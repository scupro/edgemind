/**
 * Agent loop (PLAN §4). A run executes in *segments*: each segment claims the run lease, works until it
 * finishes, needs an approval, is stopped, or exceeds its time budget, then checkpoints everything to the DB.
 *
 *  - soft budget (≈50s on Netlify): no new step starts after it → status `paused` + `continue` event; the
 *    client (or the background driver) starts the next segment. At least one model step runs per segment.
 *  - hard deadline (≈57s on Netlify, none on Cloudflare): an in-flight model stream is aborted and its
 *    step is redone in the next segment; in-flight tools are aborted and re-run.
 *  - approvals pause the run (`waiting_approval`) indefinitely; deciding them flips it back to `paused`.
 *  - stop: in-isolate AbortController + DB status `stopping` noticed by the heartbeat (other instances).
 *
 * History stays provider-valid: every assistant tool_call gets a tool_result (denied / stopped calls get an
 * error result), and each model step / tool batch is its own message row chained by parent_id.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import type { AgentEvent, ChatRequest, PendingApprovalDTO, PermissionMode, RunStatus } from "../../../shared/src/index";
import { TERMINAL_RUN_STATUSES } from "../../../shared/src/index";
import type { Database } from "../db/client";
import { auditLogs, projects, runSteps, toolApprovals, usageLogs } from "../db/schema";
import { getFullModeCaps, getModelPrices } from "../lib/settings";
import { recordLlmUsage, spendStatus } from "../usage";
import { AssistantBuilder, resolveModel, streamChat, type Fetch, type ResolvedModel, type RetryOptions } from "../llm";
import { assembleContext, type ContextHooks } from "./context";
import { buildMcpTools, mcpRisks } from "../mcp/service";
import { estimateTokens, getMemorySettings, helperModel, maybeCompact, memoryRecaller, messageTokens } from "../memory";
import { evaluate, loadGrants, loadPolicies, resolveMode, type Policy } from "./permissions";
import {
  appendStep, claimRun, getRun, heartbeat, insertMessage, saveRun, toMessageDTO, transition, STALE_LEASE_MS,
  type Checkpoint, type PendingTools, type RunRow,
} from "./store";
import { ToolDeferred, type Tool, type ToolContext, type ToolRegistry } from "./tools";
import { resolveFilePart, type FileStore } from "../storage/files";
import type { Message, Part } from "../../../shared/src/index";

export interface AgentEnv {
  database: Database;
  encKey: Uint8Array;
  registry: ToolRegistry;
  fetch?: Fetch;
  llmRetry?: RetryOptions;
  hooks?: ContextHooks;
  /** Heartbeat / stop-poll interval. Default 3000 ms. */
  heartbeatMs?: number;
  /** Cap on a serialized tool result fed back to the model. Default 50 000 chars. */
  maxToolResultChars?: number;
  /** Project file storage (S3); also resolves `fileId` attachment parts for the model. */
  storage?: FileStore;
  /** Cloudflare Workers AI binding (embedding via binding instead of REST). */
  ai?: import("../providers/probe").AiBinding | null;
  /** Override model resolution (tests). */
  resolveModel?: (modelRowId: string) => Promise<ResolvedModel>;
  /** Called (fire-and-forget) when a run completes normally — auto memory extraction (M10). */
  onCompleted?: (runId: string) => void;
}

export interface SegmentBudget {
  /** No new step starts after this many ms. */
  softMs: number;
  /** In-flight work is aborted after this many ms (undefined = never). */
  hardMs?: number;
}

export interface SegmentOptions extends SegmentBudget {
  emit?: (e: AgentEvent) => void;
  /**
   * Stream-mode runs on platforms with a hard wall-clock cap (Netlify ≈60 s): when a model step is cut by the hard
   * deadline, switch the run to background mode instead of redoing the same step in another capped segment, where a
   * long answer would be cut again forever. The client's `continue` then gets 202 and follows the step log.
   */
  backgroundOnDeadline?: boolean;
}

/** A model step only starts when at least this much of the hard deadline is left (else pause first, fresh segment). */
export const MIN_MODEL_STEP_MS = 30_000;

export interface SegmentOutcome {
  status: RunStatus;
  reason?: string;
}

/** Runs executing in this isolate (immediate local stop). */
const active = new Map<string, AbortController>();

export function abortLocalRun(runId: string): boolean {
  const ac = active.get(runId);
  if (!ac) return false;
  ac.abort(new Error("stopped"));
  return true;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function capResult(result: unknown, max: number): unknown {
  if (result === undefined) return null;
  let s: string;
  try {
    s = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    s = String(result);
  }
  if (s.length <= max) return result;
  return `${s.slice(0, max)}\n…[內容過長已截斷，原長 ${s.length} 字元]`;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ac.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

export async function pendingApprovals(database: Database, runId: string, registry?: ToolRegistry): Promise<PendingApprovalDTO[]> {
  const rows = await database.db.select().from(toolApprovals).where(and(eq(toolApprovals.runId, runId), eq(toolApprovals.status, "pending")));
  const mcp = rows.some((r) => r.toolName.startsWith("mcp__")) ? await mcpRisks(database).catch(() => new Map()) : new Map();
  return rows.map((r) => ({
    id: r.id,
    toolCallId: r.toolCallId,
    toolName: r.toolName,
    args: r.args,
    risk: registry?.get(r.toolName)?.risk ?? mcp.get(r.toolName) ?? "unknown",
    reason: r.kind === "question" ? "等待你的回答" : r.kind === "client" ? "等待瀏覽器執行" : "需要你的批准",
    kind: r.kind === "question" ? ("question" as const) : r.kind === "client" ? ("client" as const) : ("approval" as const),
  }));
}

/**
 * Close a run that no segment is executing (stop while paused / waiting for approval / stale lease):
 * fill missing tool results, deny open approvals, mark stopped.
 */
export async function closeStoppedRun(database: Database, run: RunRow, emit?: (e: AgentEvent) => void): Promise<void> {
  const cp = (run.checkpoint ?? undefined) as Checkpoint | undefined;
  if (cp?.pending) await flushPendingAsStopped(database, run, cp);
  await database.db.update(toolApprovals).set({ status: "denied", decidedAt: new Date() }).where(and(eq(toolApprovals.runId, run.id), eq(toolApprovals.status, "pending")));
  await saveRun(database, run.id, { status: "stopped", finishedAt: new Date(), checkpoint: cp ? { ...cp, finishReason: "stopped" } : null });
  await appendStep(database, run.id, "done", { status: "stopped", reason: "stopped" });
  emit?.({ type: "done", status: "stopped", reason: "stopped" });
}

async function flushPendingAsStopped(database: Database, run: RunRow, cp: Checkpoint) {
  const p = cp.pending!;
  const parts = p.calls.map((c) => {
    const r = p.results[c.id] ?? { result: "使用者已停止執行，此工具未執行。", isError: true };
    return { type: "tool_result" as const, callId: c.id, name: c.name, result: r.result, ...(r.isError ? { isError: true } : {}) };
  });
  const row = await insertMessage(database, { conversationId: run.conversationId, parentId: cp.leafId, role: "tool", parts, runId: run.id });
  cp.leafId = row.id;
  cp.pending = undefined;
  return row;
}

/** Replace `{type:"file", fileId}` parts with inline content from S3 (cached per segment). */
async function resolveFileParts(store: FileStore, msgs: Message[], cache: Map<string, Part>): Promise<Message[]> {
  const out: Message[] = [];
  for (const m of msgs) {
    if (!m.parts.some((p) => p.type === "file" && p.fileId && !p.data && p.text === undefined && !p.url)) {
      out.push(m);
      continue;
    }
    const parts: Part[] = [];
    for (const p of m.parts) {
      if (p.type !== "file" || !p.fileId || p.data || p.text !== undefined || p.url) {
        parts.push(p);
        continue;
      }
      let r = cache.get(p.fileId);
      if (!r) {
        try {
          r = await resolveFilePart(store, p);
        } catch (e) {
          r = { type: "text", text: `[附件：${p.name}（讀取失敗：${errMsg(e)}）]` };
        }
        cache.set(p.fileId, r);
      }
      parts.push(r);
    }
    out.push({ ...m, parts });
  }
  return out;
}

export async function runSegment(env: AgentEnv, runId: string, opts: SegmentOptions): Promise<SegmentOutcome> {
  const { database: db, registry } = env;
  const emit = (e: AgentEvent) => {
    try {
      opts.emit?.(e);
    } catch {
      /* client gone: keep working, everything is persisted */
    }
  };
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;

  const run = await claimRun(db, runId);
  if (!run) {
    const cur = await getRun(db, runId);
    if (!cur) {
      emit({ type: "error", error: { message: "找不到執行紀錄", code: "not_found" } });
      return { status: "failed", reason: "not_found" };
    }
    emit({ type: "run", runId, conversationId: cur.conversationId, userMessageId: cur.userMessageId, status: cur.status as RunStatus });
    if (cur.status === "stopping" && Date.now() - cur.updatedAt.getTime() > STALE_LEASE_MS) {
      await closeStoppedRun(db, cur, emit);
      return { status: "stopped" };
    }
    if (cur.status === "waiting_approval") {
      emit({ type: "approval-required", approvals: await pendingApprovals(db, runId, registry) });
      emit({ type: "done", status: "waiting_approval" });
      return { status: "waiting_approval" };
    }
    if (TERMINAL_RUN_STATUSES.includes(cur.status as RunStatus)) {
      emit({ type: "done", status: cur.status as RunStatus, reason: (cur.checkpoint as Checkpoint | null)?.finishReason });
      return { status: cur.status as RunStatus };
    }
    emit({ type: "error", error: { message: "此執行正在其他連線中進行", code: "busy", retryable: true } });
    return { status: cur.status as RunStatus, reason: "busy" };
  }

  const stopAc = new AbortController();
  active.set(runId, stopAc);
  const deadlineAc = new AbortController();
  const deadlineTimer = opts.hardMs !== undefined ? setTimeout(() => deadlineAc.abort(new Error("deadline")), opts.hardMs) : undefined;
  const hb = setInterval(() => {
    heartbeat(db, runId)
      .then((s) => {
        if (s === "stopping") stopAc.abort(new Error("stopped"));
      })
      .catch(() => {});
  }, env.heartbeatMs ?? 3000);
  const workSignal = anySignal([stopAc.signal, deadlineAc.signal]);

  try {
    return await segmentBody(env, run, opts, emit, elapsed, stopAc.signal, deadlineAc.signal, workSignal);
  } catch (e) {
    // Unexpected failure: record it; the lease goes stale so the run could be retried by "continue".
    await saveRun(db, runId, { status: "failed", error: errMsg(e), finishedAt: new Date() }).catch(() => {});
    await appendStep(db, runId, "error", { message: errMsg(e) }).catch(() => {});
    emit({ type: "error", error: { message: errMsg(e), code: "internal" } });
    emit({ type: "done", status: "failed", reason: "internal" });
    return { status: "failed", reason: errMsg(e) };
  } finally {
    clearInterval(hb);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    active.delete(runId);
  }
}

async function segmentBody(
  env: AgentEnv,
  run: RunRow,
  opts: SegmentOptions,
  emit: (e: AgentEvent) => void,
  elapsed: () => number,
  stopSignal: AbortSignal,
  deadlineSignal: AbortSignal,
  workSignal: AbortSignal,
): Promise<SegmentOutcome> {
  const { database: db } = env;
  const runId = run.id;
  const conversationId = run.conversationId;
  const cp = { ...(run.checkpoint as Checkpoint) };
  let stepCount = run.stepCount;
  emit({ type: "run", runId, conversationId, userMessageId: run.userMessageId, status: "running" });

  const { mode: resolvedMode, projectId } = await resolveMode(db, conversationId);
  // MCP tools of the enabled servers (project allow-list applied) join the registry for this segment.
  const registry = env.registry.withTools(await buildMcpTools(db, projectId).catch(() => []));
  const mode = (run.permissionMode as PermissionMode | null) ?? resolvedMode;
  const policies: Policy[] = await loadPolicies(db, conversationId, projectId);
  const grants = await loadGrants(db, conversationId);
  if (!run.modelId) throw new Error("此執行沒有指定模型");
  const model = await (env.resolveModel ? env.resolveModel(run.modelId) : resolveModel(db, env.encKey, run.modelId, env.fetch));
  if (env.llmRetry) model.cfg.retry = env.llmRetry;
  const maxChars = env.maxToolResultChars ?? 50_000;
  let enabledTools: string[] | null = null;
  if (projectId) {
    const [p] = await db.db.select({ t: projects.enabledTools }).from(projects).where(eq(projects.id, projectId)).limit(1);
    enabledTools = Array.isArray(p?.t) ? p.t : null;
  }
  /** Project tool filter (`enabledTools`, null = all) + project-only tools. */
  const toolAvailable = (t: Tool) => (!t.projectOnly || !!projectId) && (enabledTools === null || enabledTools.includes(t.name));
  /** Why http_request (the only way to use vault secrets) is not usable in this run — stated in the # 密鑰 section. */
  const httpUnavailable = ((): string | null => {
    const t = registry.get("http_request");
    if (!t) return null;
    if (!toolAvailable(t)) {
      return "這個專案的「啟用的工具」沒有勾選 http_request（可能是在新增這個工具之前就自訂過專案的工具清單）。解決方法：請使用者到這個專案的設定 →「啟用的工具」勾選 http_request，或開啟「啟用全部工具」";
    }
    if (mode === "plan") {
      return "目前的權限模式是「唯讀（Plan）」，只提供讀取類工具，http_request 不會提供給你。解決方法：請使用者把這個對話（聊天輸入框旁的權限選單）或專案預設的權限模式改成「一般」或以上，再重新送出";
    }
    const d = evaluate({ mode, toolName: t.name, risk: t.risk, targets: {}, policies, grants });
    if (d.decision === "deny") return `權限規則禁止 http_request（${d.reason}）。解決方法：請使用者檢查 http_request 的權限規則`;
    return null;
  })();
  const fullCaps = mode === "full" ? await getFullModeCaps(db) : null;
  const prices = await getModelPrices(db);

  const audit = (toolName: string, decision: string, detail: Record<string, unknown>) =>
    db.db.insert(auditLogs).values({ action: "tool_call", runId, conversationId, toolName, decision, detail });

  const finalize = async (status: RunStatus, reason?: string, error?: string): Promise<SegmentOutcome> => {
    cp.finishReason = reason;
    await saveRun(db, runId, { status, finishedAt: new Date(), checkpoint: cp, error: error ?? null, stepCount });
    await appendStep(db, runId, "done", { status, reason, error });
    emit({ type: "done", status, reason });
    if (status === "completed") {
      try {
        env.onCompleted?.(runId);
      } catch {
        /* never affects the run */
      }
    }
    return { status, reason };
  };

  const finalizeStopped = async (): Promise<SegmentOutcome> => {
    if (cp.pending) {
      const row = await flushPendingAsStopped(db, run, cp);
      emit({ type: "message", message: toMessageDTO(row) });
    }
    await db.db.update(toolApprovals).set({ status: "denied", decidedAt: new Date() }).where(and(eq(toolApprovals.runId, runId), eq(toolApprovals.status, "pending")));
    return finalize("stopped", "stopped");
  };

  const pause = async (reason: string): Promise<SegmentOutcome> => {
    const ok = await transition(db, runId, ["running"], { status: "paused", checkpoint: cp, stepCount });
    if (!ok) return finalizeStopped(); // a stop request arrived meanwhile
    await appendStep(db, runId, "continue", { reason });
    emit({ type: "continue", runId });
    return { status: "paused", reason };
  };

  const saveCp = () => saveRun(db, runId, { checkpoint: cp, stepCount });
  const segmentStart = Date.now() - elapsed();
  const deadline = opts.hardMs !== undefined ? segmentStart + opts.hardMs : undefined;
  const toolCtx = (callId: string): ToolContext => ({
    runId, conversationId, projectId, signal: workSignal, database: db, encKey: env.encKey,
    fetch: env.fetch ?? ((...a) => fetch(...a)), storage: env.storage, ai: env.ai, callId, deadline, model, registry,
  });
  /** A result already recorded in run_steps for this call (crash between recording and checkpointing). */
  const recordedResult = async (callId: string): Promise<{ result: unknown; isError?: boolean } | undefined> => {
    const [row] = await db.db.select({ payload: runSteps.payload }).from(runSteps)
      .where(and(eq(runSteps.runId, runId), eq(runSteps.kind, "tool_result"), sql`${runSteps.payload}->>'callId' = ${callId}`)).limit(1);
    if (!row) return undefined;
    const pl = row.payload as { result: unknown; isError?: boolean };
    return { result: pl.result, ...(pl.isError ? { isError: true } : {}) };
  };

  let modelStepsThisSegment = 0;
  /** Something was persisted in this segment (a model step or a batch of tool results): pausing now still advances. */
  let progressed = false;
  const fileCache = new Map<string, Part>();
  let lastInputTokens = 0;
  const memSettings = await getMemorySettings(db);
  const hooks: ContextHooks = {
    ...env.hooks,
    memoriesSection: env.hooks?.memoriesSection ?? memoryRecaller({ database: db, encKey: env.encKey, fetch: env.fetch ?? ((...a) => fetch(...a)), runId }),
  };

  for (;;) {
    if (stopSignal.aborted) return finalizeStopped();

    // ---------- 1. pending tool calls ----------
    if (cp.pending) {
      const p: PendingTools = cp.pending;
      const waiting: PendingApprovalDTO[] = [];
      const toRun: { call: PendingTools["calls"][number]; tool: Tool; decision: string }[] = [];
      const setResult = (id: string, result: unknown, isError?: boolean) => {
        p.results[id] = { result, ...(isError ? { isError: true } : {}) };
      };
      /** Permission granted: run server-side, or hand a client-side call (code_run python) to the browser. */
      const allowRun = async (call: PendingTools["calls"][number], tool: Tool, decision: string) => {
        if (!tool.clientSide?.(call.args)) {
          toRun.push({ call, tool, decision });
          return;
        }
        const finish = async (result: unknown, isError: boolean, auditDecision: string) => {
          setResult(call.id, result, isError);
          await audit(call.name, auditDecision, { callId: call.id, args: call.args, isError, mode, clientSide: true });
          await appendStep(db, runId, "tool_result", { callId: call.id, name: call.name, isError, result });
          emit({ type: "tool-result", callId: call.id, name: call.name, result, isError });
        };
        const prior = await recordedResult(call.id);
        if (prior) return finish(prior.result, !!prior.isError, "reused");
        if (run.mode === "background") return finish(tool.clientUnavailable ?? "此工具需要開啟中的瀏覽器分頁，背景模式無法執行。", true, decision);
        const [cl] = await db.db.select().from(toolApprovals).where(and(eq(toolApprovals.runId, runId), eq(toolApprovals.toolCallId, call.id), eq(toolApprovals.kind, "client"))).limit(1);
        if (!cl) {
          let clientArgs: unknown;
          try {
            clientArgs = tool.prepareClient ? await tool.prepareClient(call.args, toolCtx(call.id)) : call.args;
          } catch (e) {
            return finish(`工具執行失敗：${errMsg(e)}`, true, decision);
          }
          const [row] = await db.db.insert(toolApprovals).values({ runId, conversationId, toolCallId: call.id, toolName: call.name, args: clientArgs as object, kind: "client" }).returning();
          await audit(call.name, decision, { callId: call.id, args: call.args, mode, clientSide: true });
          await appendStep(db, runId, "approval", { approvalId: row.id, toolCallId: call.id, toolName: call.name, args: clientArgs, status: "pending", kind: "client" });
          waiting.push({ id: row.id, toolCallId: call.id, toolName: call.name, args: clientArgs, risk: tool.risk, reason: "等待瀏覽器執行", kind: "client" });
        } else if (cl.status === "pending") {
          waiting.push({ id: cl.id, toolCallId: call.id, toolName: call.name, args: cl.args, risk: tool.risk, reason: "等待瀏覽器執行", kind: "client" });
        } else if (cl.status === "approved") {
          const ans = cl.answer as { ok?: boolean } | null;
          await finish(ans ?? { ok: false, error: "瀏覽器沒有回傳結果" }, !ans || ans.ok === false, "client_result");
        } else {
          await finish("使用者取消了瀏覽器端執行。", true, "client_cancelled");
        }
      };
      for (const call of p.calls) {
        if (p.results[call.id]) continue;
        const found = registry.get(call.name);
        if (found && !toolAvailable(found)) {
          const msg = found.projectOnly && !projectId ? `${call.name} 只能在專案內的對話使用。` : `${call.name} 未在此專案啟用。`;
          setResult(call.id, msg, true);
          await audit(call.name, "deny", { callId: call.id, reason: "tool_disabled" });
          emit({ type: "tool-result", callId: call.id, name: call.name, result: msg, isError: true });
          continue;
        }
        const tool = found;
        if (!tool) {
          setResult(call.id, `未知的工具：${call.name}`, true);
          await audit(call.name, "deny", { callId: call.id, reason: "unknown_tool" });
          emit({ type: "tool-result", callId: call.id, name: call.name, result: p.results[call.id].result, isError: true });
          continue;
        }
        const argErr = p.argErrors?.[call.id];
        if (argErr) {
          setResult(call.id, argErr, true);
          await audit(call.name, "deny", { callId: call.id, reason: "bad_arguments" });
          emit({ type: "tool-result", callId: call.id, name: call.name, result: argErr, isError: true });
          continue;
        }
        if (tool.interactive) {
          const [appr] = await db.db.select().from(toolApprovals).where(and(eq(toolApprovals.runId, runId), eq(toolApprovals.toolCallId, call.id))).limit(1);
          if (!appr) {
            const [row] = await db.db.insert(toolApprovals).values({ runId, conversationId, toolCallId: call.id, toolName: call.name, args: call.args as object, kind: "question" }).returning();
            await appendStep(db, runId, "approval", { approvalId: row.id, toolCallId: call.id, toolName: call.name, args: call.args, status: "pending", kind: "question" });
            waiting.push({ id: row.id, toolCallId: call.id, toolName: call.name, args: call.args, risk: tool.risk, reason: "等待你的回答", kind: "question" });
          } else if (appr.status === "pending") {
            waiting.push({ id: appr.id, toolCallId: call.id, toolName: call.name, args: call.args, risk: tool.risk, reason: "等待你的回答", kind: "question" });
          } else {
            const result = appr.status === "approved" ? { answer: appr.answer } : { skipped: true, note: "使用者略過了這個問題，請自行判斷或換個方式繼續。" };
            setResult(call.id, result);
            await audit(call.name, appr.status === "approved" ? "answered" : "skipped", { callId: call.id });
            await appendStep(db, runId, "tool_result", { callId: call.id, name: call.name, isError: false, result });
            emit({ type: "tool-result", callId: call.id, name: call.name, result });
          }
          continue;
        }
        const g = evaluate({ mode, toolName: tool.name, risk: tool.risk, targets: registry.targetsOf(tool, call.args), policies, grants });
        if (g.decision === "allow") {
          await allowRun(call, tool, g.source === "grant" ? "allow_grant" : "allow");
        } else if (g.decision === "deny") {
          const msg = `權限禁止執行 ${call.name}：${g.reason}`;
          setResult(call.id, msg, true);
          await audit(call.name, "deny", { callId: call.id, args: call.args, reason: g.reason, mode });
          await appendStep(db, runId, "tool_result", { callId: call.id, name: call.name, isError: true, result: msg });
          emit({ type: "tool-result", callId: call.id, name: call.name, result: msg, isError: true });
        } else {
          const [appr] = await db.db.select().from(toolApprovals).where(and(eq(toolApprovals.runId, runId), eq(toolApprovals.toolCallId, call.id), ne(toolApprovals.kind, "client"))).limit(1);
          if (!appr) {
            const [row] = await db.db.insert(toolApprovals).values({ runId, conversationId, toolCallId: call.id, toolName: call.name, args: call.args as object }).returning();
            await audit(call.name, "ask", { callId: call.id, args: call.args, reason: g.reason, mode });
            await appendStep(db, runId, "approval", { approvalId: row.id, toolCallId: call.id, toolName: call.name, args: call.args, status: "pending" });
            waiting.push({ id: row.id, toolCallId: call.id, toolName: call.name, args: call.args, risk: tool.risk, reason: g.reason });
          } else if (appr.status === "approved") {
            if (appr.scope === "conversation") grants.add(call.name);
            await allowRun(call, tool, "approved");
          } else if (appr.status === "denied") {
            const msg = "使用者拒絕執行此工具。";
            setResult(call.id, msg, true);
            await audit(call.name, "denied", { callId: call.id, args: call.args });
            await appendStep(db, runId, "tool_result", { callId: call.id, name: call.name, isError: true, result: msg });
            emit({ type: "tool-result", callId: call.id, name: call.name, result: msg, isError: true });
          } else {
            waiting.push({ id: appr.id, toolCallId: call.id, toolName: call.name, args: call.args, risk: tool.risk, reason: g.reason });
          }
        }
      }

      // Parallel execution of everything allowed.
      let deferred = false;
      await Promise.all(
        toRun.map(async ({ call, tool, decision }) => {
          const started = Date.now();
          let result: unknown;
          let isError = false;
          if (tool.nonIdempotent) {
            const prior = await recordedResult(call.id);
            if (prior) {
              // Already executed in an earlier (interrupted) segment: never repeat its side effects.
              setResult(call.id, prior.result, prior.isError);
              emit({ type: "tool-result", callId: call.id, name: call.name, result: prior.result, isError: prior.isError });
              return;
            }
          }
          try {
            result = await tool.execute(call.args, toolCtx(call.id));
          } catch (e) {
            if (e instanceof ToolDeferred) {
              deferred = true; // not enough time left in this segment: run it in the next one
              return;
            }
            if (workSignal.aborted) return; // re-run next segment (deadline) or flushed as stopped
            result = `工具執行失敗：${errMsg(e)}`;
            isError = true;
          }
          result = capResult(result, maxChars);
          setResult(call.id, result, isError);
          await audit(call.name, decision, { callId: call.id, args: call.args, isError, durationMs: Date.now() - started, mode });
          await appendStep(db, runId, "tool_result", { callId: call.id, name: call.name, isError, result });
          emit({ type: "tool-result", callId: call.id, name: call.name, result, isError });
        }),
      );
      await saveCp();

      if (stopSignal.aborted) return finalizeStopped();
      if (deadlineSignal.aborted || deferred) return pause("deadline");
      if (waiting.length) {
        const ok = await transition(db, runId, ["running"], { status: "waiting_approval", checkpoint: cp, stepCount });
        if (!ok) return finalizeStopped();
        emit({ type: "approval-required", approvals: waiting });
        emit({ type: "done", status: "waiting_approval" });
        return { status: "waiting_approval" };
      }

      const parts = p.calls.map((c) => {
        const r = p.results[c.id];
        return { type: "tool_result" as const, callId: c.id, name: c.name, result: r.result, ...(r.isError ? { isError: true } : {}) };
      });
      const row = await insertMessage(db, { conversationId, parentId: cp.leafId, role: "tool", parts, runId });
      const dto = toMessageDTO(row);
      await appendStep(db, runId, "message", { message: dto });
      emit({ type: "message", message: dto });
      cp.leafId = row.id;
      cp.pending = undefined;
      await saveCp();
      progressed = true;
    }

    // ---------- 2. limits ----------
    if (stepCount >= run.maxSteps) return finalize("completed", "max_steps");
    if (modelStepsThisSegment > 0 && elapsed() >= opts.softMs) return pause("budget");
    if (deadlineSignal.aborted) return pause("deadline");
    // Don't start a model step that the hard deadline would cut mid-stream (its output would be thrown away and
    // regenerated): hand it a fresh segment instead. Only after progress, so a segment always moves the run forward.
    if (deadline !== undefined && progressed && deadline - Date.now() < Math.min(MIN_MODEL_STEP_MS, (opts.hardMs ?? 0) * 0.6)) {
      return pause("budget");
    }
    if (fullCaps) {
      if (fullCaps.maxSteps && stepCount >= fullCaps.maxSteps) return finalize("completed", "full_mode_step_cap");
      if (fullCaps.maxTokens || fullCaps.maxCostUsd) {
        const [u] = await db.db
          .select({ tokens: sql<number>`coalesce(sum(coalesce(${usageLogs.inputTokens},0) + coalesce(${usageLogs.outputTokens},0)),0)::float8`, cost: sql<number>`coalesce(sum(${usageLogs.costUsd}),0)::float8` })
          .from(usageLogs)
          .where(eq(usageLogs.runId, runId));
        if (fullCaps.maxTokens && Number(u.tokens) >= fullCaps.maxTokens) return finalize("completed", "full_mode_token_cap");
        if (fullCaps.maxCostUsd && Number(u.cost) >= fullCaps.maxCostUsd) return finalize("completed", "full_mode_cost_cap");
      }
    }

    // ---------- spend caps (用量): checked before every model call ----------
    {
      const spend = await spendStatus(db);
      if (spend.daily === "blocked" || spend.monthly === "blocked") {
        await appendStep(db, runId, "error", { message: spend.message, code: "spend_cap" });
        emit({ type: "error", error: { message: spend.message!, code: "spend_cap" } });
        return finalize("failed", "spend_cap", spend.message!);
      }
      if (spend.message && !cp.spendWarned) {
        cp.spendWarned = true;
        await appendStep(db, runId, "spend_warning", { message: spend.message });
        await saveCp();
      }
    }

    // ---------- 3. model step ----------
    let ctx = await assembleContext(db, conversationId, cp.leafId, hooks, { httpUnavailable });
    const tools = registry.defs((t) => toolAvailable(t) && (mode === "plan" ? t.risk === "read" : true));
    // Compaction (M10): summarize older turns when the prompt nears the model's context window.
    {
      const fixed = estimateTokens(ctx.system) + estimateTokens(JSON.stringify(tools));
      const est = fixed + ctx.messages.reduce((n, m) => n + messageTokens(m), 0);
      const slack = Math.max(0, lastInputTokens - est); // provider-reported size beats the estimate
      const window = model.contextLength ?? memSettings.compaction.defaultContextTokens;
      if (memSettings.compaction.enabled && est + slack > window * memSettings.compaction.threshold) {
        try {
          const helper = memSettings.helperModelId ? await helperModel(db, env.encKey, env.fetch, null) : null;
          const r = await maybeCompact(db, conversationId, cp.leafId, model, { systemTokens: fixed + slack, signal: workSignal, helper });
          if (r.compacted) {
            await appendStep(db, runId, "compacted", { summarizedMessages: r.summarizedMessages });
            ctx = await assembleContext(db, conversationId, cp.leafId, hooks, { httpUnavailable });
          }
        } catch (e) {
          if (workSignal.aborted) return stopSignal.aborted ? finalizeStopped() : pause("deadline");
          await appendStep(db, runId, "compaction_failed", { error: (e as Error).message });
        }
      }
    }
    if (env.storage) ctx.messages = await resolveFileParts(env.storage, ctx.messages, fileCache);
    const req: ChatRequest = {
      model: model.model,
      system: ctx.system,
      messages: ctx.messages,
      tools,
      ...(cp.options?.maxTokens ? { maxTokens: cp.options.maxTokens } : {}),
      ...(cp.options?.temperature !== undefined ? { temperature: cp.options.temperature } : {}),
      ...(cp.options?.reasoning ? { reasoning: cp.options.reasoning } : {}),
    };
    const b = new AssistantBuilder();
    for await (const ev of streamChat(model.cfg, req, { signal: workSignal })) {
      b.push(ev);
      if (ev.type !== "finish" && ev.type !== "error") emit(ev);
    }
    modelStepsThisSegment++;
    if (!b.error) progressed = true;

    if (b.error?.code === "aborted") {
      if (stopSignal.aborted) {
        const partial = b.message().parts.filter((x) => x.type === "text" || x.type === "reasoning");
        if (partial.some((x) => x.type === "text" && x.text)) {
          const row = await insertMessage(db, { conversationId, parentId: cp.leafId, role: "assistant", parts: partial, runId, modelId: model.modelRowId });
          cp.leafId = row.id;
          emit({ type: "message", message: toMessageDTO(row) });
        }
        return finalizeStopped();
      }
      if (opts.backgroundOnDeadline && run.mode === "stream") {
        // The step alone outlasts a capped segment: finish it in background mode (long budget) instead of looping.
        const ok = await transition(db, runId, ["running"], { status: "paused", mode: "background", checkpoint: cp, stepCount });
        if (!ok) return finalizeStopped();
        await appendStep(db, runId, "continue", { reason: "deadline", mode: "background" });
        emit({ type: "continue", runId, mode: "background" });
        return { status: "paused", reason: "deadline_background" };
      }
      return pause("deadline"); // step is redone next segment
    }

    if (b.usage) {
      lastInputTokens = b.usage.inputTokens ?? 0;
      await recordLlmUsage(db, { providerId: model.providerId, model: model.model, modelRowId: model.modelRowId, runId, conversationId, usage: b.usage }, prices);
    }

    if (b.error) {
      const partial = b.message().parts.filter((x) => x.type === "text");
      if (partial.length) {
        const row = await insertMessage(db, { conversationId, parentId: cp.leafId, role: "assistant", parts: partial, runId, modelId: model.modelRowId });
        cp.leafId = row.id;
        emit({ type: "message", message: toMessageDTO(row) });
      }
      await appendStep(db, runId, "error", { error: b.error });
      emit({ type: "error", error: b.error });
      return finalize("failed", "model_error", b.error.message);
    }

    const msg = b.message();
    stepCount++;
    if (!msg.parts.length) return finalize("completed", b.finish ?? "empty");
    const row = await insertMessage(db, { conversationId, parentId: cp.leafId, role: "assistant", parts: msg.parts, runId, modelId: model.modelRowId });
    const dto = toMessageDTO(row);
    await appendStep(db, runId, "message", { message: dto, finish: b.finish, usage: b.usage });
    emit({ type: "message", message: dto });
    cp.leafId = row.id;

    const calls = b.toolCalls;
    if (calls.length) {
      for (const c of calls) await appendStep(db, runId, "tool_call", { callId: c.id, name: c.name, args: c.args });
      cp.pending = { calls, results: {}, argErrors: b.argErrors.size ? Object.fromEntries(b.argErrors) : undefined };
      await saveCp();
      continue;
    }
    return finalize("completed", b.finish ?? "stop");
  }
}

/**
 * Run segments back-to-back until the run leaves `paused` or the overall budget is used up
 * (background mode). Returns the last outcome; `paused` means the caller should re-trigger.
 */
export async function driveRun(env: AgentEnv, runId: string, budget: SegmentBudget, emit?: (e: AgentEvent) => void): Promise<SegmentOutcome> {
  const t0 = Date.now();
  for (;;) {
    const left = (ms: number | undefined) => (ms === undefined ? undefined : Math.max(0, ms - (Date.now() - t0)));
    const o = await runSegment(env, runId, { softMs: left(budget.softMs)!, hardMs: left(budget.hardMs), emit });
    if (o.status !== "paused" || o.reason === "busy") return o;
    if (Date.now() - t0 >= budget.softMs) return o;
  }
}
