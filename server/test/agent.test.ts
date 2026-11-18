import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AgentEvent } from "../../shared/src/index";
import type { Platform } from "../src/context";
import { createApp } from "../src/app";
import { auditLogs, messages, runs, toolApprovals, usageLogs } from "../src/db/schema";
import { parseSse } from "../src/llm";
import { builtinRegistry, type Tool } from "../src/agent/tools";
import { createTestDatabase, testEnv, TestClient } from "./helpers";
import { sseResponse } from "./llm-helpers";

// ---------------- scripted OpenAI-compatible mock provider ----------------

type Reply = { sse: string; delayMs?: number; size?: number };
const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`;
const text = (t: string, opts: Partial<Reply> = {}): Reply => ({ sse: chunk({ role: "assistant", content: t }) + chunk({}, "stop") + usage + "data: [DONE]\n\n", ...opts });
const slowText = (pieces: string[], delayMs: number): Reply => ({ sse: pieces.map((p) => chunk({ content: p })).join("") + chunk({}, "stop") + "data: [DONE]\n\n", delayMs, size: 64 });
const calls = (cs: { id: string; name: string; args: unknown }[]): Reply => ({
  sse: cs.map((c, i) => chunk({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] })).join("") + chunk({}, "tool_calls") + usage + "data: [DONE]\n\n",
});

let script: (Reply | ((body: any) => Reply))[] = [];
let llmBodies: any[] = [];
const mockFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  if (!url.startsWith("https://mock.llm/v1/")) return new Response("no route", { status: 404 });
  if (url.endsWith("/models")) return Response.json({ data: [{ id: "mock-1" }] });
  const body = JSON.parse(String(init.body));
  llmBodies.push(body);
  const next = script.shift();
  if (!next) return new Response('{"error":{"message":"script exhausted"}}', { status: 400 });
  const r = typeof next === "function" ? next(body) : next;
  if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const res = sseResponse(r.sse, r.size ?? 4096, { delayMs: r.delayMs });
  // propagate abort into the body stream like real fetch does
  const reader = res.body!.getReader();
  const stream = new ReadableStream({
    async pull(ctrl) {
      if (init.signal?.aborted) return ctrl.error(new DOMException("Aborted", "AbortError"));
      const { done, value } = await reader.read();
      if (done) ctrl.close();
      else ctrl.enqueue(value);
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
  return new Response(stream, { headers: res.headers });
}) as typeof fetch;

// ---------------- tools ----------------

const executed: string[] = [];
const toolSpans: Record<string, [number, number]> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const writeNote: Tool = {
  name: "write_note",
  description: "寫入筆記檔",
  risk: "write",
  parameters: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } } },
  async execute(args) {
    executed.push(`write_note:${args.path}`);
    return { ok: true, path: args.path };
  },
};
const slowRead = (name: string): Tool => ({
  name,
  description: "slow read",
  risk: "read",
  parameters: { type: "object", properties: {} },
  async execute() {
    const t = Date.now();
    await sleep(150);
    toolSpans[name] = [t, Date.now()];
    executed.push(name);
    return { startedAt: t };
  },
});
const dangerous: Tool = {
  name: "fetch_url",
  description: "危險：任意 HTTP",
  risk: "dangerous",
  parameters: { type: "object", properties: { url: { type: "string" } } },
  async execute(args) {
    executed.push(`fetch_url:${args.url}`);
    return "ok";
  },
};
const registry = builtinRegistry().register(writeNote, slowRead("slow_a"), slowRead("slow_b"), dangerous);

// ---------------- harness ----------------

let t: Awaited<ReturnType<typeof createTestDatabase>>;
let env: Record<string, string>;
let cookies: Map<string, string>;
let modelRowId: string;

function makeClient(platform: Platform = { name: "test" }) {
  const app = createApp({ getDatabase: () => t.database, fetch: mockFetch, platform, tools: registry, agent: { heartbeatMs: 40, llmRetry: { maxRetries: 0 } } });
  const c = new TestClient(app, env);
  c.cookies = cookies;
  const open = (body: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json", cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "), "x-csrf-token": cookies.get("em_csrf")! };
    return app.request("http://localhost/api/chat", { method: "POST", headers, body: JSON.stringify(body) }, env);
  };
  const chat = async (body: unknown) => {
    const res = await open(body);
    if (!res.headers.get("content-type")?.includes("text/event-stream")) return { status: res.status, json: await res.json(), events: [] as AgentEvent[] };
    const events: AgentEvent[] = [];
    for await (const e of parseSse(res.body!)) events.push(JSON.parse(e.data));
    return { status: res.status, json: null as any, events };
  };
  return { c, app, open, chat };
}

const last = (evs: AgentEvent[]) => evs[evs.length - 1];
const runIdOf = (evs: AgentEvent[]) => (evs.find((e) => e.type === "run") as any).runId as string;
const convOf = (evs: AgentEvent[]) => (evs.find((e) => e.type === "run") as any).conversationId as string;

beforeAll(async () => {
  t = await createTestDatabase();
  env = testEnv(t.url);
  const app = createApp({ getDatabase: () => t.database, fetch: mockFetch });
  const c = new TestClient(app, env);
  await c.get("/status");
  expect((await c.post("/auth/setup", { password: "owner-password-1" })).status).toBe(200);
  cookies = c.cookies;
  const p = await c.post("/providers", { type: "llm", kind: "openai", name: "Mock", baseUrl: "https://mock.llm/v1", apiKey: "sk-mock-123456" });
  expect(p.status).toBe(201);
  const m = await c.req("PUT", `/providers/${p.body.id}/models`, { models: [{ modelId: "mock-1", capabilities: { tools: true } }] });
  modelRowId = m.body[0].id;
  expect((await c.req("PUT", "/settings/memory", { autoExtract: false })).status).toBe(200);
});
afterAll(async () => t?.drop());
beforeEach(async () => {
  script = [];
  llmBodies = [];
  executed.length = 0;
  await t.database.query(`UPDATE settings SET value = '"normal"'::jsonb WHERE key = 'permission_mode'`);
  await t.database.query(`DELETE FROM tool_policies`);
});

describe("agent loop: basics", () => {
  it("streams a plain answer and persists user + assistant messages, steps and usage", async () => {
    const { chat } = makeClient();
    script = [text("你好！")];
    const r = await chat({ content: "嗨", modelId: modelRowId });
    expect(r.events.map((e) => e.type)).toEqual(["run", "text-delta", "usage", "message", "done"]);
    expect(last(r.events)).toEqual({ type: "done", status: "completed", reason: "stop" });
    const runId = runIdOf(r.events);
    const [run] = await t.database.db.select().from(runs).where(eq(runs.id, runId));
    expect(run.status).toBe("completed");
    expect(run.stepCount).toBe(1);
    const msgs = await t.database.db.select().from(messages).where(eq(messages.conversationId, run.conversationId));
    expect(msgs.map((m) => m.role).sort()).toEqual(["assistant", "user"]);
    expect(llmBodies[0].messages[0].role).toBe("system");
    expect(llmBodies[0].messages[0].content).toContain("EdgeMind");
    expect(llmBodies[0].tools.map((x: any) => x.function.name)).toContain("get_time");
    const u = await t.database.db.select().from(usageLogs).where(eq(usageLogs.runId, runId));
    expect(u[0]).toMatchObject({ inputTokens: 10, outputTokens: 3, kind: "chat" });
  });

  it("read tool runs automatically; parallel tool calls execute concurrently; results fed back in order; audit logged", async () => {
    const { chat } = makeClient();
    script = [
      calls([{ id: "c1", name: "slow_a", args: {} }, { id: "c2", name: "slow_b", args: {} }, { id: "c3", name: "echo", args: { text: "hi" } }]),
      text("完成"),
    ];
    const r = await chat({ content: "go", modelId: modelRowId });
    // 2×150 ms tools in parallel: their execution windows overlap (robust under a loaded full-suite run, unlike a wall-clock bound)
    const [a0, a1] = toolSpans.slow_a, [b0, b1] = toolSpans.slow_b;
    expect(Math.max(a0, b0)).toBeLessThan(Math.min(a1, b1));
    expect(last(r.events)).toMatchObject({ status: "completed" });
    expect(r.events.filter((e) => e.type === "tool-result").length).toBe(3);
    const toolMsgs = llmBodies[1].messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs.map((m: any) => m.tool_call_id)).toEqual(["c1", "c2", "c3"]);
    expect(toolMsgs[2].content).toBe('{"text":"hi"}');
    const a = await t.database.db.select().from(auditLogs).where(and(eq(auditLogs.action, "tool_call"), eq(auditLogs.runId, runIdOf(r.events))));
    expect(a.map((x) => x.decision).sort()).toEqual(["allow", "allow", "allow"]);
  });

  it("unknown tools and invalid JSON arguments become error results instead of crashing", async () => {
    const { chat } = makeClient();
    script = [
      { sse: chunk({ tool_calls: [{ index: 0, id: "x1", type: "function", function: { name: "nope", arguments: "{}" } }, { index: 1, id: "x2", type: "function", function: { name: "echo", arguments: "{bad" } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n" },
      text("ok"),
    ];
    const r = await chat({ content: "go", modelId: modelRowId });
    expect(last(r.events)).toMatchObject({ status: "completed" });
    const toolMsgs = llmBodies[1].messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs[0].content).toContain("未知的工具");
    expect(toolMsgs[1].content).toContain("不是有效的 JSON");
  });

  it("stops at max steps", async () => {
    const { chat } = makeClient();
    script = [calls([{ id: "a", name: "echo", args: { text: "1" } }]), calls([{ id: "b", name: "echo", args: { text: "2" } }]), text("never")];
    const r = await chat({ content: "loop", modelId: modelRowId, maxSteps: 2 });
    expect(last(r.events)).toEqual({ type: "done", status: "completed", reason: "max_steps" });
    expect(llmBodies.length).toBe(2);
  });

  it("model errors fail the run with the provider message", async () => {
    const { chat } = makeClient();
    script = [];
    const r = await chat({ content: "x", modelId: modelRowId });
    expect(r.events.some((e) => e.type === "error" && e.error.message.includes("script exhausted"))).toBe(true);
    expect(last(r.events)).toMatchObject({ type: "done", status: "failed" });
  });
});

describe("approvals", () => {
  it("write tool pauses for approval, survives days, resumes after allow_once", async () => {
    const { chat, c } = makeClient();
    script = [calls([{ id: "w1", name: "write_note", args: { path: "notes/a.md", text: "x" } }])];
    const r1 = await chat({ content: "寫筆記", modelId: modelRowId });
    const runId = runIdOf(r1.events);
    const appr = r1.events.find((e) => e.type === "approval-required") as any;
    expect(appr.approvals).toMatchObject([{ toolCallId: "w1", toolName: "write_note", risk: "write", args: { path: "notes/a.md", text: "x" } }]);
    expect(last(r1.events)).toEqual({ type: "done", status: "waiting_approval" });
    expect(executed).toEqual([]);

    // three days later …
    await t.database.query(`UPDATE runs SET updated_at = now() - interval '3 days' WHERE id = $1`, [runId]);
    const st = await c.get(`/runs/${runId}`);
    expect(st.body).toMatchObject({ status: "waiting_approval", approvals: [{ toolCallId: "w1" }] });
    // a continue before deciding just re-announces the pending approval
    const again = await chat({ runId });
    expect(again.events.map((e) => e.type)).toEqual(["run", "approval-required", "done"]);

    const d = await c.post(`/runs/${runId}/approvals`, { toolCallId: "w1", decision: "allow_once" });
    expect(d.body).toMatchObject({ status: "paused", remaining: [], resume: true });
    script = [text("已寫入")];
    const r2 = await chat({ runId, action: "continue" });
    expect(executed).toEqual(["write_note:notes/a.md"]);
    expect(r2.events.find((e) => e.type === "tool-result")).toMatchObject({ callId: "w1", result: { ok: true } });
    expect(last(r2.events)).toMatchObject({ status: "completed" });
    const a = await t.database.db.select().from(auditLogs).where(and(eq(auditLogs.runId, runId), eq(auditLogs.toolName, "write_note")));
    expect(a.map((x) => `${x.action}:${x.decision}`).sort()).toEqual(["tool_approval:approved", "tool_call:approved", "tool_call:ask"]);
  });

  it("deny → model gets an error result and continues", async () => {
    const { chat, c } = makeClient();
    script = [calls([{ id: "w2", name: "write_note", args: { path: "x.md" } }])];
    const r1 = await chat({ content: "寫", modelId: modelRowId });
    const runId = runIdOf(r1.events);
    await c.post(`/runs/${runId}/approvals`, { toolCallId: "w2", decision: "deny" });
    script = [text("好的，不寫")];
    const r2 = await chat({ runId, action: "continue" });
    expect(executed).toEqual([]);
    expect(last(r2.events)).toMatchObject({ status: "completed" });
    expect(llmBodies[1].messages.find((m: any) => m.role === "tool").content).toContain("使用者拒絕");
    expect((await c.post(`/runs/${runId}/approvals`, { toolCallId: "w2", decision: "allow_once" })).status).toBe(409);
  });

  it("allow_conversation grants the tool for later runs of the same conversation only", async () => {
    const { chat, c } = makeClient();
    script = [calls([{ id: "g1", name: "write_note", args: { path: "a" } }, { id: "g2", name: "write_note", args: { path: "b" } }])];
    const r1 = await chat({ content: "兩個", modelId: modelRowId });
    const runId = runIdOf(r1.events);
    expect((r1.events.find((e) => e.type === "approval-required") as any).approvals).toHaveLength(2);
    const d = await c.post(`/runs/${runId}/approvals`, { toolCallId: "g1", decision: "allow_conversation" });
    expect(d.body.remaining).toEqual([]); // g2 covered by the same grant
    script = [text("ok")];
    await chat({ runId, action: "continue" });
    expect(executed.sort()).toEqual(["write_note:a", "write_note:b"]);

    executed.length = 0;
    script = [calls([{ id: "g3", name: "write_note", args: { path: "c" } }]), text("done")];
    const r2 = await chat({ conversationId: convOf(r1.events), content: "再一次" });
    expect(r2.events.some((e) => e.type === "approval-required")).toBe(false);
    expect(executed).toEqual(["write_note:c"]);

    script = [calls([{ id: "g4", name: "write_note", args: { path: "d" } }])];
    const r3 = await chat({ content: "新對話", modelId: modelRowId });
    expect(r3.events.some((e) => e.type === "approval-required")).toBe(true);
  });

  it("a new message while a run waits for approval closes the old run with a valid history", async () => {
    const { chat } = makeClient();
    script = [calls([{ id: "o1", name: "write_note", args: { path: "z" } }])];
    const r1 = await chat({ content: "first", modelId: modelRowId });
    script = [text("second answer")];
    const r2 = await chat({ conversationId: convOf(r1.events), content: "never mind" });
    expect(last(r2.events)).toMatchObject({ status: "completed" });
    const [old] = await t.database.db.select().from(runs).where(eq(runs.id, runIdOf(r1.events)));
    expect(old.status).toBe("stopped");
    const msgs = llmBodies[1].messages;
    expect(msgs.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(msgs[3].content).toContain("停止");
  });
});

describe("segments, stop, background", () => {
  it("segment budget → `continue` event, client re-POSTs and the run resumes seamlessly", async () => {
    const { chat } = makeClient({ name: "test", segment: { softMs: 0 } });
    script = [calls([{ id: "s1", name: "echo", args: { text: "a" } }]), calls([{ id: "s2", name: "echo", args: { text: "b" } }]), text("end")];
    let r = await chat({ content: "multi", modelId: modelRowId });
    const runId = runIdOf(r.events);
    let segments = 1;
    while (last(r.events).type === "continue") {
      expect(last(r.events)).toEqual({ type: "continue", runId });
      r = await chat({ runId, action: "continue" });
      segments++;
      expect(segments).toBeLessThan(10);
    }
    expect(segments).toBe(3);
    expect(last(r.events)).toMatchObject({ status: "completed" });
    expect(llmBodies[2].messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "tool"]);
    const steps = await t.database.query<{ kind: string }>(`SELECT kind FROM run_steps WHERE run_id = $1 ORDER BY seq`, [runId]);
    expect(steps.filter((s) => s.kind === "continue")).toHaveLength(2);
  });

  it("hard deadline aborts an in-flight model step, which is redone in the next segment", async () => {
    const { chat } = makeClient({ name: "test", segment: { softMs: 0, hardMs: 120 } });
    script = [slowText(["慢", "慢", "慢", "慢"], 60), text("快")];
    const r1 = await chat({ content: "x", modelId: modelRowId });
    expect(last(r1.events).type).toBe("continue");
    const r2 = await chat({ runId: runIdOf(r1.events), action: "continue" });
    expect(last(r2.events)).toMatchObject({ status: "completed" });
    const msgs = await t.database.db.select().from(messages).where(eq(messages.conversationId, convOf(r1.events)));
    expect(msgs.filter((m) => m.role === "assistant").map((m) => m.parts)).toEqual([[{ type: "text", text: "快" }]]);
  });

  it("backgroundOnDeadline: a model step cut by the hard deadline moves the run to background instead of redoing it", async () => {
    const { chat, c } = makeClient({ name: "test", segment: { softMs: 0, hardMs: 120 }, background: { softMs: 60_000 }, backgroundOnDeadline: true });
    script = [slowText(["慢", "慢", "慢", "慢"], 60), text("完成")];
    const r1 = await chat({ content: "長回答", modelId: modelRowId });
    const runId = runIdOf(r1.events);
    expect(last(r1.events)).toEqual({ type: "continue", runId, mode: "background" });
    const [row] = await t.database.db.select().from(runs).where(eq(runs.id, runId));
    expect(row.mode).toBe("background");
    expect(row.status).toBe("paused");
    // the page's automatic `continue` is answered with 202: the step finishes in background mode
    const r2 = await chat({ runId, action: "continue" });
    expect(r2.status).toBe(202);
    let status = "";
    for (let i = 0; i < 100 && status !== "completed"; i++) {
      status = (await c.get(`/runs/${runId}`)).body.status;
      if (status !== "completed") await sleep(30);
    }
    expect(status).toBe("completed");
    const msgs = await t.database.db.select().from(messages).where(eq(messages.conversationId, convOf(r1.events)));
    expect(msgs.filter((m) => m.role === "assistant").map((m) => m.parts)).toEqual([[{ type: "text", text: "完成" }]]);
  });

  it("stop during streaming keeps the partial answer", async () => {
    const { open, c } = makeClient();
    script = [slowText(Array.from({ length: 40 }, (_, i) => `字${i}`), 25)];
    const res = await open({ content: "長回答", modelId: modelRowId });
    const evs: AgentEvent[] = [];
    let stopped = false;
    for await (const e of parseSse(res.body!)) {
      const ev = JSON.parse(e.data) as AgentEvent;
      evs.push(ev);
      if (ev.type === "text-delta" && !stopped) {
        stopped = true;
        const s = await c.post(`/runs/${runIdOf(evs)}/stop`, {});
        expect(["stopping", "stopped"]).toContain(s.body.status);
      }
    }
    expect(last(evs)).toEqual({ type: "done", status: "stopped", reason: "stopped" });
    const msgs = await t.database.db.select().from(messages).where(and(eq(messages.conversationId, convOf(evs)), eq(messages.role, "assistant")));
    expect(msgs).toHaveLength(1);
    const partial = (msgs[0].parts[0] as any).text as string;
    expect(partial.startsWith("字0")).toBe(true);
    expect(partial.length).toBeLessThan(40 * 3);
  });

  it("stop request seen through the DB heartbeat (other instance)", async () => {
    const { open } = makeClient();
    script = [slowText(Array.from({ length: 40 }, (_, i) => `${i}`), 25)];
    const res = await open({ content: "x", modelId: modelRowId });
    const evs: AgentEvent[] = [];
    for await (const e of parseSse(res.body!)) {
      const ev = JSON.parse(e.data) as AgentEvent;
      evs.push(ev);
      if (ev.type === "text-delta" && evs.filter((x) => x.type === "text-delta").length === 1) {
        await t.database.query(`UPDATE runs SET status = 'stopping' WHERE id = $1`, [runIdOf(evs)]); // no local abort
      }
    }
    expect(last(evs)).toMatchObject({ status: "stopped" });
  });

  it("stop while waiting for approval closes the run, denies approvals, answers the tool call", async () => {
    const { chat, c } = makeClient();
    script = [calls([{ id: "q1", name: "write_note", args: { path: "q" } }])];
    const r = await chat({ content: "x", modelId: modelRowId });
    const runId = runIdOf(r.events);
    expect((await c.post(`/runs/${runId}/stop`, {})).body.status).toBe("stopped");
    const [a] = await t.database.db.select().from(toolApprovals).where(eq(toolApprovals.runId, runId));
    expect(a.status).toBe("denied");
    const tool = await t.database.db.select().from(messages).where(and(eq(messages.runId, runId), eq(messages.role, "tool")));
    expect((tool[0].parts[0] as any).result).toContain("停止");
    expect((await c.get(`/runs/${runId}`)).body.status).toBe("stopped");
  });

  it("background mode: 202 + polling via /runs/:id/events until completion", async () => {
    const { chat, c } = makeClient({ name: "test", background: { softMs: 0 } });
    script = [calls([{ id: "b1", name: "echo", args: { text: "bg" } }]), text("背景完成")];
    const r = await chat({ content: "背景", modelId: modelRowId, mode: "background" });
    expect(r.status).toBe(202);
    const runId = r.json.runId;
    let after = 0;
    const kinds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const ev = await c.get(`/runs/${runId}/events?after=${after}`);
      kinds.push(...ev.body.steps.map((s: any) => s.kind));
      after = ev.body.nextAfter;
      if (ev.body.status === "completed") break;
      await sleep(30);
    }
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("continue"); // softMs 0 forces chained segments
    expect(kinds.at(-1)).toBe("done");
    expect((await c.get(`/runs/${runId}`)).body.status).toBe("completed");
  });

  it("background approval: deciding resumes the run automatically", async () => {
    const { chat, c } = makeClient();
    script = [calls([{ id: "ba", name: "write_note", args: { path: "bg.md" } }])];
    const r = await chat({ content: "x", modelId: modelRowId, mode: "background" });
    const runId = r.json.runId;
    for (let i = 0; i < 50 && (await c.get(`/runs/${runId}`)).body.status !== "waiting_approval"; i++) await sleep(20);
    script = [text("ok")];
    await c.post(`/runs/${runId}/approvals`, { toolCallId: "ba", decision: "allow_once" });
    for (let i = 0; i < 50 && (await c.get(`/runs/${runId}`)).body.status !== "completed"; i++) await sleep(20);
    expect((await c.get(`/runs/${runId}`)).body.status).toBe("completed");
    expect(executed).toEqual(["write_note:bg.md"]);
  });

  it("internal drive endpoint requires a valid HMAC token", async () => {
    const { c } = makeClient();
    const r = await c.req("POST", `/internal/runs/00000000-0000-0000-0000-000000000000/drive`, undefined, { headers: { "x-edgemind-drive": "nope" } });
    expect(r.status).toBe(401);
  });
});

describe("regenerate and edit-and-branch", () => {
  it("regenerate creates a sibling assistant branch; edit creates a sibling user message with a clean context", async () => {
    const { chat, c } = makeClient();
    script = [text("A1")];
    const r1 = await chat({ content: "Q1", modelId: modelRowId });
    const conversationId = convOf(r1.events);
    const userId = (r1.events.find((e) => e.type === "run") as any).userMessageId;
    script = [text("A2")];
    await chat({ conversationId, content: "Q2" });

    script = [text("A1-bis")];
    const rg = await chat({ conversationId, regenerate: userId });
    expect(last(rg.events)).toMatchObject({ status: "completed" });
    expect(llmBodies[2].messages.map((m: any) => m.content)).toEqual([expect.any(String), "Q1"]);
    let tree = await c.get(`/conversations/${conversationId}/messages`);
    const children = tree.body.messages.filter((m: any) => m.parentId === userId);
    expect(children.map((m: any) => m.parts[0].text).sort()).toEqual(["A1", "A1-bis"]);
    expect(tree.body.conversation.activeLeafId).toBe(children.find((m: any) => m.parts[0].text === "A1-bis").id);

    script = [text("E1")];
    await chat({ conversationId, content: "Q1 edited", parentId: null });
    expect(llmBodies[3].messages.slice(1)).toEqual([{ role: "user", content: "Q1 edited" }]);
    tree = await c.get(`/conversations/${conversationId}/messages`);
    expect(tree.body.messages.filter((m: any) => m.parentId === null).map((m: any) => m.parts[0].text).sort()).toEqual(["Q1", "Q1 edited"]);
  });
});

describe("permission modes (integration)", () => {
  async function setMode(c: TestClient, scope: string, mode: string | null, scopeId?: string) {
    const r = await c.req("PUT", "/permissions/mode", { scope, scopeId, mode });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  it("plan mode hides and denies write tools", async () => {
    const { chat, c } = makeClient();
    await setMode(c, "global", "plan");
    script = [calls([{ id: "p1", name: "write_note", args: { path: "a" } }]), text("ok")];
    const r = await chat({ content: "x", modelId: modelRowId });
    expect(llmBodies[0].tools.map((x: any) => x.function.name).sort()).toEqual(["ask_user", "echo", "get_time", "kb_search", "memory_search", "skill_load", "slow_a", "slow_b", "subagent", "todo", "web_fetch", "web_search"]);
    expect(r.events.find((e) => e.type === "tool-result")).toMatchObject({ isError: true });
    expect(executed).toEqual([]);
  });

  it("auto_edit allows writes but asks for dangerous; conversation-level full overrides; custom rules with globs and domains", async () => {
    const { chat, c } = makeClient();
    await setMode(c, "global", "auto_edit");
    script = [calls([{ id: "e1", name: "write_note", args: { path: "a" } }, { id: "e2", name: "fetch_url", args: { url: "https://x.com" } }])];
    const r1 = await chat({ content: "x", modelId: modelRowId });
    expect(executed).toEqual(["write_note:a"]);
    expect((r1.events.find((e) => e.type === "approval-required") as any).approvals.map((a: any) => a.toolName)).toEqual(["fetch_url"]);

    // conversation override: full
    executed.length = 0;
    script = [calls([{ id: "e3", name: "fetch_url", args: { url: "https://y.com" } }]), text("ok")];
    const r0 = await chat({ content: "y", modelId: modelRowId });
    expect(r0.events.some((e) => e.type === "approval-required")).toBe(true);
    await c.post(`/runs/${runIdOf(r0.events)}/stop`, {});
    await setMode(c, "conversation", "full", convOf(r0.events));
    script = [calls([{ id: "e4", name: "fetch_url", args: { url: "https://y.com" } }]), text("ok")];
    await chat({ conversationId: convOf(r0.events), content: "again" });
    expect(executed).toEqual(["fetch_url:https://y.com"]);

    // custom: write_note allowed only under docs/**, fetch_url only for *.example.com, echo denied
    executed.length = 0;
    await setMode(c, "global", "custom");
    expect((await c.post("/permissions/policies", { scope: "global", toolName: "write_note", action: "allow", rule: { pathGlob: "docs/**" } })).status).toBe(201);
    await c.post("/permissions/policies", { scope: "global", toolName: "fetch_url", action: "allow", rule: { domains: ["*.example.com"] } });
    await c.post("/permissions/policies", { scope: "global", toolName: "echo", action: "deny" });
    script = [
      calls([
        { id: "k1", name: "write_note", args: { path: "docs/guide/a.md" } },
        { id: "k2", name: "write_note", args: { path: "docs/../secrets/b" } },
        { id: "k3", name: "fetch_url", args: { url: "https://api.example.com/v1" } },
        { id: "k4", name: "fetch_url", args: { url: "https://evil.com" } },
        { id: "k5", name: "echo", args: { text: "x" } },
      ]),
    ];
    const r2 = await chat({ content: "custom", modelId: modelRowId });
    expect(executed.sort()).toEqual(["fetch_url:https://api.example.com/v1", "write_note:docs/guide/a.md"]);
    expect((r2.events.find((e) => e.type === "approval-required") as any).approvals.map((a: any) => a.toolCallId)).toEqual(["k2", "k4"]);
    expect(r2.events.find((e) => e.type === "tool-result" && e.callId === "k5")).toMatchObject({ isError: true });
    const perms = await c.get(`/permissions?conversationId=${convOf(r2.events)}`);
    expect(perms.body).toMatchObject({ globalMode: "custom", effectiveMode: "custom" });
    expect(perms.body.policies).toHaveLength(3);
  });
});
