/**
 * Chat / run endpoints.
 *   POST /api/chat                       new message | regenerate | edit-and-branch | continue/resume (SSE or 202 background)
 *   GET  /api/runs/:id                   run state + pending approvals
 *   GET  /api/runs/:id/events?after=N    step log polling (background mode / reconnect)
 *   POST /api/runs/:id/stop
 *   POST /api/runs/:id/approvals         { toolCallId, decision: allow_once | allow_conversation | deny }
 *   GET  /api/conversations/:id/messages full message tree + active leaf
 *   POST /api/internal/runs/:id/drive    HMAC-signed background driver (Netlify background fn / CF waitUntil chain)
 */
import type { Hono } from "hono";
import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { AgentEvent, ApprovalDecision, ClientToolResult, Part, RunStatus } from "../../../shared/src/index";
import { CODE_OUTPUT_CAP, TERMINAL_RUN_STATUSES } from "../../../shared/src/index";
import type { AppDeps, Ctx, HonoEnv } from "../context";
import { runInBackground } from "../context";
import { auditLogs, conversations, files as files_, messages, models, projects, providers, runSteps, runs, settings, toolApprovals } from "../db/schema";
import { BadInput } from "../lib/errors";
import { hmacHex, timingSafeEqual } from "../lib/crypto";
import { aiBinding } from "./kb";
import { abortLocalRun, closeStoppedRun, driveRun, pendingApprovals, runSegment, type AgentEnv } from "../agent/loop";
import { appendStep, getRun, insertMessage, STALE_LEASE_MS, toMessageDTO, transition, type Checkpoint, type RunOptions } from "../agent/store";
import { builtinRegistry } from "../agent/tools";
import { extractMemories } from "../memory";
import { fileStore } from "./files";
import { ensureBuiltinSkills } from "../skills/builtin";
import { SkillStore } from "../skills/store";
import { isPermissionMode } from "../agent/permissions";
import { usableModelId } from "../llm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export const DEFAULT_MAX_STEPS = 25;
const DEFAULT_SEGMENT = { softMs: 50_000, hardMs: 57_000 };
const DEFAULT_BACKGROUND = { softMs: 13 * 60_000, hardMs: 14 * 60_000 + 30_000 };
const MAX_INLINE_BYTES = 15 * 1024 * 1024;

export const driveToken = (secret: string, runId: string) => hmacHex(secret, `drive:${runId}`);

function parseContent(v: unknown): Part[] {
  if (typeof v === "string") {
    if (!v.trim()) throw new BadInput("訊息不可為空");
    return [{ type: "text", text: v }];
  }
  if (!Array.isArray(v) || !v.length || v.length > 50) throw new BadInput("content 必須是字串或 1–50 個 parts");
  let bytes = 0;
  const parts = v.map((p: any): Part => {
    if (p?.type === "text" && typeof p.text === "string") return { type: "text", text: p.text };
    if (p?.type === "image" && typeof p.mime === "string" && /^image\//.test(p.mime) && (typeof p.data === "string" || typeof p.url === "string")) {
      bytes += p.data?.length ?? 0;
      return { type: "image", mime: p.mime, ...(p.data ? { data: p.data } : { url: String(p.url) }) };
    }
    if (p?.type === "file" && typeof p.name === "string" && typeof p.mime === "string") {
      bytes += (p.data?.length ?? 0) + (p.text?.length ?? 0);
      return {
        type: "file", name: p.name.slice(0, 300), mime: p.mime,
        ...(isUuid(p.fileId) ? { fileId: p.fileId } : {}),
        ...(typeof p.data === "string" ? { data: p.data } : {}),
        ...(typeof p.text === "string" ? { text: p.text } : {}),
      };
    }
    throw new BadInput("不支援的訊息內容類型");
  });
  if (bytes > MAX_INLINE_BYTES) throw new BadInput("附件過大，請改用檔案上傳");
  if (!parts.some((p) => (p.type === "text" ? p.text.trim() : true))) throw new BadInput("訊息不可為空");
  return parts;
}

function parseOptions(v: any): RunOptions | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o: RunOptions = {};
  if (v.reasoning && typeof v.reasoning === "object") {
    const effort = ["minimal", "low", "medium", "high"].includes(v.reasoning.effort) ? v.reasoning.effort : undefined;
    const budget = Number.isInteger(v.reasoning.budgetTokens) && v.reasoning.budgetTokens > 0 ? v.reasoning.budgetTokens : undefined;
    o.reasoning = { ...(effort ? { effort } : {}), ...(budget ? { budgetTokens: budget } : {}) };
  }
  if (Number.isInteger(v.maxTokens) && v.maxTokens > 0 && v.maxTokens <= 1_000_000) o.maxTokens = v.maxTokens;
  if (typeof v.temperature === "number" && v.temperature >= 0 && v.temperature <= 2) o.temperature = v.temperature;
  return o;
}

/** SSE response driven by `work(emit)`; the work keeps running (waitUntil) even if the client disconnects. */
function sse(c: Ctx, work: (emit: (e: AgentEvent) => void) => Promise<unknown>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let closed = false;
  const write = (s: string) => {
    if (closed) return;
    writer.write(enc.encode(s)).catch(() => {
      closed = true;
    });
  };
  const emit = (e: AgentEvent) => write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const ka = setInterval(() => write(": keep-alive\n\n"), 15_000);
  const p = (async () => {
    try {
      await work(emit);
    } catch (e) {
      emit({ type: "error", error: { message: (e as Error).message, code: "internal" } });
    } finally {
      clearInterval(ka);
      closed = true;
      await writer.close().catch(() => {});
    }
  })();
  runInBackground(c, p);
  return new Response(readable, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}

/**
 * Whether anything is still executing a run. `stale`: running / pending / stopping but its lease expired (the segment
 * died, e.g. a platform time limit or a dropped connection). `resumable`: a stream-mode run that only moves on when a
 * page POSTs `continue` (paused between segments, or stale) — the UI must offer that instead of waiting forever.
 */
export function runLiveness(run: { status: string; mode: string; updatedAt: Date }, now = Date.now()): { stale: boolean; resumable: boolean } {
  const stale = ["running", "pending", "stopping"].includes(run.status) && now - run.updatedAt.getTime() > STALE_LEASE_MS;
  const resumable = run.mode === "stream" && (run.status === "paused" || (stale && run.status !== "stopping"));
  return { stale, resumable };
}

async function lastSeq(c: Ctx, runId: string): Promise<number> {
  const [r] = await c.get("database").db.select({ n: sql<number>`coalesce(max(${runSteps.seq}), 0)::int` }).from(runSteps).where(eq(runSteps.runId, runId));
  return Number(r?.n ?? 0);
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" ? (v.length > max ? `${v.slice(0, max)}\n…[已截斷]` : v) : undefined);

/** Validate / cap what the browser reports (never trust its sizes). File ids must exist. */
async function sanitizeClientResult(c: Ctx, raw: any): Promise<ClientToolResult> {
  if (!raw || typeof raw !== "object") throw new BadInput("缺少 result");
  const cap = CODE_OUTPUT_CAP + 500;
  const fileList = (v: unknown) => (Array.isArray(v) ? v.slice(0, 100) : [])
    .filter((f: any) => f && typeof f.path === "string" && isUuid(f.fileId))
    .map((f: any) => ({ path: f.path.slice(0, 500), fileId: f.fileId as string, size: Number.isFinite(f.size) ? Number(f.size) : 0, ...(f.kind === "figure" ? { kind: "figure" as const } : {}) }));
  let files = fileList(raw.files);
  const full = raw.fullOutput && typeof raw.fullOutput.path === "string" && isUuid(raw.fullOutput.fileId) ? { path: raw.fullOutput.path.slice(0, 500), fileId: raw.fullOutput.fileId as string } : null;
  const ids = [...files.map((f) => f.fileId), ...(full ? [full.fileId] : [])];
  const known = ids.length ? new Set((await c.get("database").db.select({ id: files_.id }).from(files_).where(inArray(files_.id, ids))).map((r) => r.id)) : new Set<string>();
  files = files.filter((f) => known.has(f.fileId));
  return {
    ok: raw.ok === true,
    stdout: str(raw.stdout, cap) ?? "",
    stderr: str(raw.stderr, cap) ?? "",
    result: str(raw.result, cap) ?? null,
    error: str(raw.error, 10_000) ?? null,
    ...(Number.isFinite(raw.durationMs) ? { durationMs: Math.round(raw.durationMs) } : {}),
    ...(raw.stdoutTruncated ? { stdoutTruncated: true } : {}),
    ...(raw.stderrTruncated ? { stderrTruncated: true } : {}),
    ...(full && known.has(full.fileId) ? { fullOutput: full } : {}),
    ...(files.length ? { files } : {}),
    ...(Array.isArray(raw.notSaved) && raw.notSaved.length
      ? { notSaved: raw.notSaved.slice(0, 100).filter((n: any) => typeof n?.path === "string").map((n: any) => ({ path: n.path.slice(0, 500), reason: String(n.reason ?? "").slice(0, 300) })) }
      : {}),
  };
}

/** Helpers other routes (scheduler) use to start agent runs. */
export interface ChatApi {
  /** New conversation + user message + background run, started immediately. */
  startConversationRun(c: Ctx, args: { prompt: string; title: string; projectId: string | null; modelId: string | null; permissionMode: string | null }): Promise<{ runId: string; conversationId: string }>;
}

export function mountChat(app: Hono<HonoEnv>, deps: AppDeps): ChatApi {
  const registry = deps.tools ?? builtinRegistry();
  const segmentBudget = deps.platform?.segment ?? DEFAULT_SEGMENT;
  /**
   * Segment options for a streamed request that started at `t0`: the platform's wall-clock cap counts from the request,
   * not from runSegment, so the time already spent here (skills, settling runs, model lookup on a cold DB) comes off.
   */
  const segmentOpts = (t0: number) => {
    const spent = Date.now() - t0;
    return {
      softMs: Math.max(0, segmentBudget.softMs - spent),
      ...(segmentBudget.hardMs !== undefined ? { hardMs: Math.max(1, segmentBudget.hardMs - spent) } : {}),
      ...(deps.platform?.backgroundOnDeadline ? { backgroundOnDeadline: true } : {}),
    };
  };
  const backgroundBudget = deps.platform?.background ?? DEFAULT_BACKGROUND;

  const agentEnv = (c: Ctx): AgentEnv => ({
    database: c.get("database"),
    encKey: c.get("encKey"),
    registry,
    fetch: deps.fetch,
    storage: fileStore(c, deps),
    ai: aiBinding(c),
    onCompleted: (runId) =>
      runInBackground(c, extractMemories(c.get("database"), c.get("encKey"), deps.fetch ?? ((...a) => fetch(...a)), runId).catch((e) => console.error("[edgemind] memory extraction failed", e))),
    ...deps.agent,
  });

  /** Kick off background execution of a run (platform-specific). */
  async function startBackground(c: Ctx, runId: string) {
    const origin = new URL(c.req.url).origin;
    const token = await driveToken(c.get("env").JWT_SECRET, runId);
    if (deps.platform?.startBackground) return deps.platform.startBackground({ origin, runId, token, c });
    // Default (Node / tests): in-process, chained until the run leaves `paused`.
    const env = agentEnv(c);
    runInBackground(
      c,
      (async () => {
        for (let i = 0; i < 1000; i++) {
          const o = await driveRun(env, runId, backgroundBudget);
          if (o.status !== "paused" || o.reason === "busy") return;
        }
      })(),
    );
  }

  async function pickModel(c: Ctx, explicit: unknown, conv?: { modelId: string | null; projectId: string | null }): Promise<string> {
    const db = c.get("database").db;
    const database = c.get("database");
    if (explicit !== undefined && explicit !== null) {
      if (!isUuid(explicit)) throw new BadInput("modelId 格式錯誤");
      const m = await usableModelId(database, explicit);
      if (m) return m;
      // A page opened before the model was removed / disabled (or a stale global default it fell back to) still sends
      // the old id: use the next usable default instead of refusing the turn (and, for a new chat, the conversation).
    }
    // Saved references can point at a model that was removed or disabled since: skip those instead of failing the turn.
    const convModel = await usableModelId(database, conv?.modelId);
    if (convModel) return convModel;
    if (conv?.projectId) {
      const [p] = await db.select({ m: projects.defaultModelId }).from(projects).where(eq(projects.id, conv.projectId)).limit(1);
      const projModel = await usableModelId(database, p?.m);
      if (projModel) return projModel;
    }
    const [s] = await db.select().from(settings).where(eq(settings.key, "default_model_id")).limit(1);
    const globalModel = await usableModelId(database, s?.value);
    if (globalModel) return globalModel;
    const [first] = await db
      .select({ id: models.id })
      .from(models)
      .innerJoin(providers, eq(providers.id, models.providerId))
      .where(and(eq(providers.type, "llm"), eq(providers.enabled, true), eq(models.enabled, true)))
      .orderBy(asc(providers.priority), asc(models.modelId))
      .limit(1);
    if (!first) throw new BadInput("尚未設定任何語言模型，請先到設定新增供應商與模型");
    return first.id;
  }

  async function maxStepsSetting(c: Ctx, requested: unknown): Promise<number> {
    if (Number.isInteger(requested) && (requested as number) >= 1 && (requested as number) <= 200) return requested as number;
    const [s] = await c.get("database").db.select().from(settings).where(eq(settings.key, "max_steps")).limit(1);
    return Number.isInteger(s?.value) && (s!.value as number) >= 1 ? (s!.value as number) : DEFAULT_MAX_STEPS;
  }

  /** Close idle runs of a conversation before a new turn so the branch never ends on unanswered tool calls. */
  async function settleOpenRuns(c: Ctx, conversationId: string) {
    const database = c.get("database");
    const open = await database.db.select().from(runs).where(and(eq(runs.conversationId, conversationId), inArray(runs.status, ["pending", "paused", "waiting_approval", "running", "stopping"])));
    for (const r of open) {
      const stale = Date.now() - r.updatedAt.getTime() > STALE_LEASE_MS;
      if (r.status === "running" || (r.status === "stopping" && !stale)) {
        return c.json({ error: "run_active", message: "這個對話還有執行中的任務，請先停止", runId: r.id }, 409);
      }
      if (await transition(database, r.id, [r.status as RunStatus], { status: "stopping" })) await closeStoppedRun(database, r);
    }
    return null;
  }

  app.post("/chat", async (c) => {
    const t0 = Date.now();
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    const database = c.get("database");
    // Bundled skills (e2b-sandbox, self-hosted-runner) are installed on first use; memoized per isolate.
    await ensureBuiltinSkills(new SkillStore(database, fileStore(c, deps).s3));
    const db = database.db;

    // ----- continue / resume an existing run -----
    if (body.runId !== undefined) {
      if (!isUuid(body.runId)) throw new BadInput("runId 格式錯誤");
      const run = await getRun(database, body.runId);
      if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
      if (run.mode === "background") {
        if (run.status === "paused" || run.status === "pending") await startBackground(c, run.id);
        return c.json({ runId: run.id, conversationId: run.conversationId, status: run.status }, 202);
      }
      const env = agentEnv(c);
      return sse(c, (emit) => runSegment(env, run.id, { ...segmentOpts(t0), emit }));
    }

    // ----- new turn: new message, edit-and-branch, or regenerate -----
    const mode = body.mode === "background" ? "background" : "stream";
    let conversationId: string;
    let conv: typeof conversations.$inferSelect | undefined;
    let newConvModel: string | undefined;
    if (body.conversationId !== undefined) {
      if (!isUuid(body.conversationId)) throw new BadInput("conversationId 格式錯誤");
      [conv] = await db.select().from(conversations).where(eq(conversations.id, body.conversationId)).limit(1);
      if (!conv) return c.json({ error: "not_found", message: "找不到對話" }, 404);
      conversationId = conv.id;
      const busy = await settleOpenRuns(c, conversationId);
      if (busy) return busy;
      [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    } else {
      if (body.regenerate !== undefined) throw new BadInput("重新生成需要 conversationId");
      let projectId: string | null = null;
      if (body.projectId !== undefined && body.projectId !== null) {
        if (!isUuid(body.projectId)) throw new BadInput("projectId 格式錯誤");
        const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, body.projectId)).limit(1);
        if (!p) throw new BadInput("找不到專案");
        projectId = p.id;
      }
      const firstText = typeof body.content === "string" ? body.content : Array.isArray(body.content) ? body.content.find((p: any) => p?.type === "text")?.text ?? "" : "";
      const permissionMode = body.permissionMode ?? null;
      if (permissionMode !== null && !isPermissionMode(permissionMode)) throw new BadInput("未知的權限模式");
      // Validate everything that can refuse the turn BEFORE the row exists: a failed first message must not leave an
      // empty conversation behind in the sidebar.
      parseContent(body.content);
      newConvModel = await pickModel(c, body.modelId, { modelId: null, projectId });
      [conv] = await db.insert(conversations).values({ projectId, permissionMode, title: String(firstText).trim().slice(0, 50) || "新對話" }).returning();
      conversationId = conv.id;
    }

    const modelId = newConvModel ?? (await pickModel(c, body.modelId, conv));
    let userMessageId: string;
    if (body.regenerate !== undefined) {
      if (!isUuid(body.regenerate)) throw new BadInput("regenerate 格式錯誤");
      const [m] = await db.select().from(messages).where(and(eq(messages.id, body.regenerate), eq(messages.conversationId, conversationId))).limit(1);
      if (!m || m.role !== "user") throw new BadInput("只能從使用者訊息重新生成");
      userMessageId = m.id;
      await db.update(conversations).set({ activeLeafId: m.id, updatedAt: new Date() }).where(eq(conversations.id, conversationId));
    } else {
      const parts = parseContent(body.content);
      let parentId: string | null = conv?.activeLeafId ?? null;
      if (body.parentId !== undefined) {
        // edit-and-branch: the new user message becomes a sibling of the edited one
        if (body.parentId === null) parentId = null;
        else {
          if (!isUuid(body.parentId)) throw new BadInput("parentId 格式錯誤");
          const [pm] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.id, body.parentId), eq(messages.conversationId, conversationId))).limit(1);
          if (!pm) throw new BadInput("找不到 parentId 指定的訊息");
          parentId = pm.id;
        }
      }
      const row = await insertMessage(database, { conversationId, parentId, role: "user", parts });
      userMessageId = row.id;
    }

    const checkpoint: Checkpoint = { leafId: userMessageId, options: parseOptions(body.options) };
    const [run] = await db
      .insert(runs)
      .values({ conversationId, userMessageId, status: "pending", mode, modelId, maxSteps: await maxStepsSetting(c, body.maxSteps), checkpoint })
      .returning();
    await db.update(messages).set({ runId: run.id }).where(and(eq(messages.id, userMessageId), eq(messages.role, "user")));

    if (mode === "background") {
      await startBackground(c, run.id);
      return c.json({ runId: run.id, conversationId, userMessageId, status: "pending" }, 202);
    }
    const env = agentEnv(c);
    return sse(c, (emit) => runSegment(env, run.id, { ...segmentOpts(t0), emit }));
  });

  app.get("/runs/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const run = await getRun(c.get("database"), id);
    if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
    const cp = run.checkpoint as Checkpoint | null;
    return c.json({
      id: run.id, conversationId: run.conversationId, userMessageId: run.userMessageId, status: run.status, mode: run.mode,
      stepCount: run.stepCount, maxSteps: run.maxSteps, error: run.error, finishReason: cp?.finishReason ?? null,
      createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null,
      ...runLiveness(run),
      approvals: await pendingApprovals(c.get("database"), run.id, registry),
    });
  });

  app.get("/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);
    const run = await getRun(c.get("database"), id);
    if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
    const steps = await c.get("database").db.select().from(runSteps).where(and(eq(runSteps.runId, id), gt(runSteps.seq, after))).orderBy(asc(runSteps.seq)).limit(500);
    return c.json({
      status: run.status,
      mode: run.mode,
      ...runLiveness(run),
      stepCount: run.stepCount,
      steps: steps.map((s) => ({ seq: s.seq, kind: s.kind, payload: s.payload, createdAt: s.createdAt.toISOString() })),
      nextAfter: steps.length ? steps[steps.length - 1].seq : after,
    });
  });

  app.post("/runs/:id/stop", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const database = c.get("database");
    const run = await getRun(database, id);
    if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
    const status = run.status as RunStatus;
    if (TERMINAL_RUN_STATUSES.includes(status)) return c.json({ status });
    await database.db.insert(auditLogs).values({ action: "run_stop", runId: id, conversationId: run.conversationId, detail: { from: status } });
    if (status === "pending" || status === "paused" || status === "waiting_approval") {
      if (await transition(database, id, [status], { status: "stopping" })) {
        await closeStoppedRun(database, run);
        return c.json({ status: "stopped" });
      }
    }
    if (status === "stopping" && Date.now() - run.updatedAt.getTime() > STALE_LEASE_MS) {
      await closeStoppedRun(database, run);
      return c.json({ status: "stopped" });
    }
    await transition(database, id, ["running"], { status: "stopping" });
    abortLocalRun(id);
    const fresh = await getRun(database, id);
    return c.json({ status: fresh?.status ?? "stopping" });
  });

  /** Record a decision (approval or ask_user answer) and resume the run when nothing else is pending. */
  async function decide(c: Ctx, id: string, toolCallId: unknown, kind: "approval" | "question" | "client", decision: ApprovalDecision, answer?: unknown) {
    if (typeof toolCallId !== "string") throw new BadInput("缺少 toolCallId");
    const database = c.get("database");
    const db = database.db;
    const run = await getRun(database, id);
    if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
    const kindFilter = kind === "client" ? eq(toolApprovals.kind, "client") : ne(toolApprovals.kind, "client");
    const [appr] = await db.select().from(toolApprovals).where(and(eq(toolApprovals.runId, id), eq(toolApprovals.toolCallId, toolCallId), kindFilter)).limit(1);
    if (!appr) return c.json({ error: "not_found", message: kind === "question" ? "找不到待回答的問題" : kind === "client" ? "找不到待執行的瀏覽器端工具" : "找不到待批准的工具呼叫" }, 404);
    if (appr.status !== "pending") return c.json({ error: "conflict", message: "此工具呼叫已經處理過" }, 409);
    if (appr.kind === "question" && kind === "approval" && decision !== "deny") throw new BadInput("這是提問，請用 /answers 回答（或拒絕以略過）");
    if (appr.kind !== "question" && kind === "question") throw new BadInput("這不是提問");
    if (kind !== "client" && appr.kind === "client") throw new BadInput("這是瀏覽器端工具，請用 /client-results 回傳結果");
    const status = decision === "deny" ? "denied" : "approved";
    const scope = decision === "allow_conversation" ? "conversation" : "once";
    await db.update(toolApprovals).set({ status, scope, decidedAt: new Date(), ...(answer !== undefined ? { answer } : {}) }).where(eq(toolApprovals.id, appr.id));
    if (decision === "allow_conversation") {
      // other pending calls of the same tool in this run are covered too
      await db.update(toolApprovals).set({ status: "approved", scope: "conversation", decidedAt: new Date() })
        .where(and(eq(toolApprovals.runId, id), eq(toolApprovals.toolName, appr.toolName), eq(toolApprovals.status, "pending"), eq(toolApprovals.kind, "approval")));
    }
    await db.insert(auditLogs).values({ action: appr.kind === "question" ? "ask_user_answer" : appr.kind === "client" ? "client_tool_result" : "tool_approval", runId: id, conversationId: run.conversationId, toolName: appr.toolName, decision: status, detail: { toolCallId: appr.toolCallId, scope } });
    await appendStep(database, id, "approval", { approvalId: appr.id, toolCallId: appr.toolCallId, toolName: appr.toolName, status, scope, kind: appr.kind });
    const remaining = await pendingApprovals(database, id, registry);
    let runStatus = run.status as RunStatus;
    if (!remaining.length && run.status === "waiting_approval") {
      if (await transition(database, id, ["waiting_approval"], { status: "paused" })) runStatus = "paused";
      if (runStatus === "paused" && run.mode === "background") await startBackground(c, id);
    }
    return c.json({ status: runStatus, remaining, resume: runStatus === "paused" && run.mode !== "background" });
  }

  app.post("/runs/:id/approvals", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const decision = body?.decision as ApprovalDecision;
    if (!["allow_once", "allow_conversation", "deny"].includes(decision)) throw new BadInput("decision 必須是 allow_once、allow_conversation 或 deny");
    return decide(c, id, body?.toolCallId, "approval", decision);
  });

  /** ask_user answers. */
  app.post("/runs/:id/answers", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.answer !== "string" || !body.answer.trim()) throw new BadInput("請輸入回答");
    if (body.answer.length > 20_000) throw new BadInput("回答過長");
    return decide(c, id, body?.toolCallId, "question", "allow_once", body.answer.trim());
  });

  /** Result of a client-side tool (code_run python executed by the browser in Pyodide), or a cancel. */
  app.post("/runs/:id/client-results", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    if (body.cancel === true) return decide(c, id, body.toolCallId, "client", "deny");
    const result = await sanitizeClientResult(c, body.result);
    return decide(c, id, body.toolCallId, "client", "allow_once", result);
  });

  app.get("/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const db = c.get("database").db;
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!conv) return c.json({ error: "not_found", message: "找不到對話" }, 404);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt));
    // Latest unfinished run (reload while running / waiting for approval / paused between segments).
    const [open] = await db.select().from(runs)
      .where(and(eq(runs.conversationId, id), inArray(runs.status, ["pending", "running", "paused", "waiting_approval", "stopping"])))
      .orderBy(desc(runs.createdAt)).limit(1);
    const activeRun = open
      ? { id: open.id, status: open.status, mode: open.mode, ...runLiveness(open), approvals: await pendingApprovals(c.get("database"), open.id, registry), lastSeq: await lastSeq(c, open.id) }
      : null;
    return c.json({
      conversation: { id: conv.id, title: conv.title, projectId: conv.projectId, activeLeafId: conv.activeLeafId, permissionMode: conv.permissionMode, modelId: conv.modelId },
      messages: rows.map(toMessageDTO),
      activeRun,
    });
  });

  // ----- internal: background driver (HMAC-signed, exempt from cookie auth/CSRF) -----
  app.post("/internal/runs/:id/drive", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const expected = await driveToken(c.get("env").JWT_SECRET, id);
    if (!timingSafeEqual(c.req.header("x-edgemind-drive") ?? "", expected)) return c.json({ error: "unauthorized" }, 401);
    const env = agentEnv(c);
    const work = async () => {
      const o = await driveRun(env, id, backgroundBudget);
      if (o.status === "paused" && o.reason !== "busy") await startBackground(c, id); // chain the next invocation
      return o;
    };
    if (deps.platform?.driveInline) return c.json(await work());
    runInBackground(c, work());
    return c.json({ accepted: true }, 202);
  });

  return {
    async startConversationRun(c, a) {
      const database = c.get("database");
      const db = database.db;
      await ensureBuiltinSkills(new SkillStore(database, fileStore(c, deps).s3));
      if (a.permissionMode !== null && !isPermissionMode(a.permissionMode)) throw new BadInput("未知的權限模式");
      const modelId = await pickModel(c, a.modelId ?? undefined, { modelId: null, projectId: a.projectId }); // model deleted → default
      const [conv] = await db.insert(conversations).values({ projectId: a.projectId, permissionMode: a.permissionMode, title: a.title.slice(0, 80) || "排程任務" }).returning();
      const msg = await insertMessage(database, { conversationId: conv.id, parentId: null, role: "user", parts: [{ type: "text", text: a.prompt }] });
      const [run] = await db.insert(runs).values({
        conversationId: conv.id, userMessageId: msg.id, status: "pending", mode: "background", modelId,
        permissionMode: a.permissionMode, maxSteps: await maxStepsSetting(c, undefined), checkpoint: { leafId: msg.id } satisfies Checkpoint,
      }).returning();
      await db.update(messages).set({ runId: run.id }).where(eq(messages.id, msg.id));
      await startBackground(c, run.id);
      return { runId: run.id, conversationId: conv.id };
    },
  };
}
