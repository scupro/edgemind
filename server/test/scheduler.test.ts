import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Harness, callsReply, textReply } from "./harness";
import { describeSpec, localDayStart, nextCron, nextRun, parseCron, validateSpec, zonedToUtc } from "../src/scheduler/cron";
import { tick } from "../src/scheduler/service";
import { cronInternalToken } from "../src/routes/schedules";
import { createApp } from "../src/app";
import { HINT_KEY, HINT_MAX_AGE_MS } from "../src/scheduler/hint";
import { TestClient } from "./helpers";
import { S3Mock } from "./s3-mock";

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
const at = (s: string) => Date.parse(s);

describe("schedule math", () => {
  it("parses cron fields, names, steps, macros and rejects bad input", () => {
    const f = parseCron("*/15 9-17 * JAN,mar MON-FRI");
    expect([...f.minute]).toEqual([0, 15, 30, 45]);
    expect([...f.hour]).toHaveLength(9);
    expect([...f.month]).toEqual([1, 3]);
    expect([...f.dow]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron("0 0 * * 7").dow]).toEqual([0]);
    expect(parseCron("@daily").minute.has(0)).toBe(true);
    for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "a * * * *", "5-1 * * * *"]) expect(() => parseCron(bad)).toThrow();
  });

  it("computes next runs in a timezone", () => {
    // 09:00 Asia/Taipei (UTC+8) daily
    expect(iso(nextRun({ type: "daily", time: "09:00", timezone: "Asia/Taipei" }, at("2026-11-14T00:30:00Z")))).toBe("2026-11-14T01:00:00.000Z");
    expect(iso(nextRun({ type: "daily", time: "09:00", timezone: "Asia/Taipei" }, at("2026-11-14T01:00:00Z")))).toBe("2026-11-15T01:00:00.000Z");
    // weekly Mon+Thu 08:30 Europe/Berlin (CET in Nov), 2026-11-14 is a Saturday
    expect(iso(nextRun({ type: "weekly", time: "08:30", weekdays: [1, 4], timezone: "Europe/Berlin" }, at("2026-11-14T12:00:00Z")))).toBe("2026-11-16T07:30:00.000Z");
    // cron: first of month at midnight in New York
    expect(iso(nextCron("0 0 1 * *", at("2026-11-14T12:00:00Z"), "America/New_York"))).toBe("2026-12-01T05:00:00.000Z");
    // Vixie: dom and dow both restricted → either matches (the 20th, or any Monday)
    expect(iso(nextCron("0 12 20 * 1", at("2026-11-14T00:00:00Z"), "UTC"))).toBe("2026-11-16T12:00:00.000Z");
    // interval anchored
    expect(iso(nextRun({ type: "interval", everyMinutes: 30, anchor: "2026-11-14T00:10:00.000Z", timezone: "UTC" }, at("2026-11-14T01:00:00Z")))).toBe("2026-11-14T01:10:00.000Z");
    // once: in the future → instant, past → null
    const once = { type: "once" as const, at: "2026-12-25T08:00", timezone: "Asia/Taipei" };
    expect(iso(nextRun(once, at("2026-11-14T00:00:00Z")))).toBe("2026-12-25T00:00:00.000Z");
    expect(nextRun(once, at("2026-12-25T00:00:00Z"))).toBeNull();
    expect(describeSpec({ type: "weekly", time: "08:30", weekdays: [1, 4], timezone: "Europe/Berlin" })).toBe("每週一、四 08:30（Europe/Berlin）");
  });

  it("handles DST gaps and overlaps", () => {
    const ny = "America/New_York";
    // spring forward 2026-03-08: 02:30 does not exist → 03:30 EDT (07:30Z)
    expect(iso(nextRun({ type: "daily", time: "02:30", timezone: ny }, at("2026-03-08T05:00:00Z")))).toBe("2026-03-08T07:30:00.000Z");
    // the day after is normal again: 02:30 EDT = 06:30Z
    expect(iso(nextRun({ type: "daily", time: "02:30", timezone: ny }, at("2026-03-08T08:00:00Z")))).toBe("2026-03-09T06:30:00.000Z");
    // fall back 2026-11-01: 01:30 occurs twice → first occurrence only (EDT, 05:30Z), then next day EST (06:30Z)
    expect(iso(nextRun({ type: "daily", time: "01:30", timezone: ny }, at("2026-11-01T04:00:00Z")))).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(nextRun({ type: "daily", time: "01:30", timezone: ny }, at("2026-11-01T05:30:00Z")))).toBe("2026-11-02T06:30:00.000Z");
    // 09:00 local keeps its wall time across the change
    expect(iso(nextRun({ type: "daily", time: "09:00", timezone: ny }, at("2026-10-31T14:00:00Z")))).toBe("2026-11-01T14:00:00.000Z");
    expect(iso(zonedToUtc(Date.UTC(2026, 6, 1, 12, 0), ny))).toBe("2026-07-01T16:00:00.000Z");
    expect(iso(localDayStart(at("2026-11-14T02:00:00Z"), ny))).toBe("2026-11-13T05:00:00.000Z");
  });

  it("validates specs with 正體中文 errors", () => {
    expect(() => validateSpec({ type: "daily", time: "25:00", timezone: "UTC" })).toThrow("HH:MM");
    expect(() => validateSpec({ type: "daily", time: "09:00", timezone: "Mars/Base" })).toThrow("時區無效");
    expect(() => validateSpec({ type: "interval", everyMinutes: 1, timezone: "UTC" })).toThrow("5 分鐘");
    expect(() => validateSpec({ type: "weekly", time: "09:00", weekdays: [], timezone: "UTC" })).toThrow("至少要選一天");
    expect(() => validateSpec({ type: "once", at: "2026-02-30T10:00", timezone: "UTC" })).toThrow("無效");
    expect(() => validateSpec({ type: "cron", cron: "0 0 30 2 *", timezone: "UTC" })).toThrow("五年");
    expect(validateSpec({ type: "weekly", time: "09:00", weekdays: [3, 1, 1], timezone: "UTC" }).weekdays).toEqual([1, 3]);
  });
});

const s3 = new S3Mock();
const h = new Harness({ deps: { s3Fetch: s3.fetch } });
beforeAll(() => h.setup());
afterAll(() => h.teardown());
beforeEach(() => { h.script = []; h.llmBodies = []; });

async function waitRun(runId: string, statuses: string[]) {
  const c = h.client();
  for (let i = 0; i < 200; i++) {
    const r = await c.get(`/runs/${runId}`);
    if (statuses.includes(r.body.status)) return r.body;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} did not reach ${statuses}`);
}

// Direct DB edits bypass the routes that refresh the idle-tick hint: drop it like any out-of-band change must.
const makeDue = async (id: string) => {
  await h.t.database.query("UPDATE scheduled_tasks SET next_run_at = now() - interval '1 minute' WHERE id = $1", [id]);
  s3.objects.delete(`edgemind/${HINT_KEY}`);
  s3.objects.delete(HINT_KEY);
};
/** An app whose database explodes on first use: proves a request was answered without touching Postgres. */
const dblessClient = () => new TestClient(createApp({ getDatabase: () => { throw new Error("database touched"); }, s3Fetch: s3.fetch }), h.env);

describe("scheduled tasks API + dispatcher", () => {
  it("CRUD, preview, validation", async () => {
    const c = h.client();
    const bad = await c.post("/schedules", { name: "x", prompt: "p", schedule: { type: "daily", time: "9:00", timezone: "Asia/Taipei" } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("HH:MM");
    const past = await c.post("/schedules", { name: "x", prompt: "p", schedule: { type: "once", at: "2020-01-01T00:00", timezone: "UTC" } });
    expect(past.body.message).toContain("已經過去");
    const r = await c.post("/schedules", { name: "早報", prompt: "整理今天的新聞", modelId: h.modelRowId, permissionMode: "plan", schedule: { type: "daily", time: "08:00", timezone: "Asia/Taipei" } });
    expect(r.status).toBe(201);
    expect(r.body.summary).toBe("每天 08:00（Asia/Taipei）");
    expect(Date.parse(r.body.nextRunAt)).toBeGreaterThan(Date.now());
    const pv = await c.post("/schedules/preview", { schedule: { type: "cron", cron: "0 */6 * * *", timezone: "UTC" } });
    expect(pv.body.next).toHaveLength(5);
    expect(new Date(pv.body.next[0]).getUTCHours() % 6).toBe(0);
    const p = await c.req("PATCH", `/schedules/${r.body.id}`, { enabled: false, name: "早報2" });
    expect(p.body.enabled).toBe(false);
    expect(p.body.name).toBe("早報2");
    expect((await c.get("/schedules")).body.tasks.some((t: any) => t.id === r.body.id)).toBe(true);
    expect((await c.req("DELETE", `/schedules/${r.body.id}`)).status).toBe(200);
    expect((await c.get("/schedules")).body.tasks.some((t: any) => t.id === r.body.id)).toBe(false);
  });

  it("tick requires a token (external bearer or Netlify HMAC)", async () => {
    const c = h.client();
    const anon = { csrf: false, headers: { cookie: "" } };
    const noToken = await c.req("POST", "/cron/tick", undefined, anon);
    expect(noToken.status).toBe(401);
    expect(noToken.body.message).toContain("尚未產生");
    const gen = await c.post("/settings/cron/token", {});
    expect(gen.body.token).toMatch(/^emc_/);
    expect((await c.get("/settings/cron")).body.token).toBe(gen.body.token);
    expect((await c.req("POST", "/cron/tick", undefined, { csrf: false, headers: { cookie: "", authorization: "Bearer wrong" } })).status).toBe(401);
    const ok = await c.req("POST", "/cron/tick", undefined, { csrf: false, headers: { cookie: "", authorization: `Bearer ${gen.body.token}` } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ claimed: 0 });
    const hmac = await cronInternalToken(h.env.JWT_SECRET);
    expect((await c.req("POST", "/cron/tick", undefined, { csrf: false, headers: { cookie: "", "x-edgemind-cron": hmac } })).status).toBe(200);
    expect((await c.req("POST", "/cron/tick", undefined, { csrf: false, headers: { cookie: "", "x-edgemind-cron": "bad" } })).status).toBe(401);
    const st = (await c.get("/settings/cron")).body;
    expect(st.lastTickSource).toBe("netlify-scheduled");
    // regenerating invalidates the old token
    await c.post("/settings/cron/token", {});
    expect((await c.req("POST", "/cron/tick", undefined, { csrf: false, headers: { cookie: "", authorization: `Bearer ${gen.body.token}` } })).status).toBe(401);
  });

  it("idle ticks are answered from the object-storage hint without touching the database", async () => {
    const c = h.client();
    const token = (await c.post("/settings/cron/token", {})).body.token as string;
    const t = (await c.post("/schedules", { name: "閒置", prompt: "x", modelId: h.modelRowId, schedule: { type: "daily", time: "03:00", timezone: "UTC" } })).body;
    const hmac = await cronInternalToken(h.env.JWT_SECRET);
    const d = dblessClient();
    const bearer = (tok: string, extra: Record<string, string> = {}) => ({ csrf: false, headers: { cookie: "", authorization: `Bearer ${tok}`, ...extra } });
    const idle = await d.req("POST", "/cron/tick", undefined, bearer(token, { "x-edgemind-cron-source": "cron-worker" }));
    expect(idle.status).toBe(200);
    expect(idle.body).toMatchObject({ claimed: 0, idle: true });
    expect(Date.parse(idle.body.nextDueAt)).toBeLessThanOrEqual(Date.parse(t.nextRunAt));
    expect((await d.req("POST", "/cron/tick", undefined, bearer("wrong"))).status).toBe(401); // no DB wake-up either
    expect((await d.req("POST", "/cron/tick", undefined, { csrf: false, headers: { cookie: "", "x-edgemind-cron": hmac } })).body.idle).toBe(true);
    expect((await d.req("POST", "/cron/tick", undefined, { csrf: false, headers: { cookie: "", "x-edgemind-cron": "bad" } })).status).toBe(401);
    // the 排程 page shows idle ticks too
    await d.req("POST", "/cron/tick", undefined, bearer(token, { "x-edgemind-cron-source": "cron-worker" }));
    expect((await c.get("/settings/cron")).body.lastTickSource).toBe("cron-worker");

    // a stale hint is not trusted: the tick goes to the database
    const key = [...s3.objects.keys()].find((k) => k.endsWith(HINT_KEY))!;
    const hint = JSON.parse(new TextDecoder().decode(s3.objects.get(key)!.body));
    s3.objects.set(key, { body: new TextEncoder().encode(JSON.stringify({ ...hint, updatedAt: new Date(Date.now() - HINT_MAX_AGE_MS - 1000).toISOString() })), contentType: "application/json" });
    expect((await d.req("POST", "/cron/tick", undefined, bearer(token))).status).toBe(500);
    expect((await c.req("POST", "/cron/tick", undefined, bearer(token))).status).toBe(200); // full tick rewrites the hint
    expect((await d.req("POST", "/cron/tick", undefined, bearer(token))).body.idle).toBe(true);

    // a due task always reaches the database (and runs)
    await h.t.database.query("UPDATE scheduled_tasks SET next_run_at = now() - interval '1 minute' WHERE id = $1", [t.id]);
    await c.req("PATCH", `/schedules/${t.id}`, { name: "閒置2" }); // any route write refreshes the hint from the DB
    expect((await d.req("POST", "/cron/tick", undefined, bearer(token))).status).toBe(500);
    // deleting the token is reflected without the database as well
    await c.req("DELETE", `/schedules/${t.id}`);
    await c.req("DELETE", "/settings/cron/token");
    expect((await d.req("POST", "/cron/tick", undefined, bearer(token))).status).toBe(401);
  });

  it("due task → one background run in a new conversation, next_run_at advanced, no double runs", async () => {
    const c = h.client();
    const t = (await c.post("/schedules", { name: "每小時", prompt: "回報狀態", modelId: h.modelRowId, schedule: { type: "cron", cron: "0 * * * *", timezone: "Asia/Taipei" } })).body;
    await makeDue(t.id);
    h.script = [textReply("狀態良好")];
    const hmac = await cronInternalToken(h.env.JWT_SECRET);
    const hit = () => c.req("POST", "/cron/tick", undefined, { csrf: false, headers: { cookie: "", "x-edgemind-cron": hmac } });
    const [a, b, d] = await Promise.all([hit(), hit(), hit()]);
    const started = [a, b, d].flatMap((r) => r.body.started);
    expect(started).toHaveLength(1);
    const run = await waitRun(started[0].runId, ["completed"]);
    expect(run.mode).toBe("background");
    const msgs = (await c.get(`/conversations/${started[0].conversationId}/messages`)).body;
    expect(msgs.conversation.title).toBe("[排程] 每小時");
    expect(msgs.messages.map((m: any) => m.parts[0].text)).toEqual(["回報狀態", "狀態良好"]);
    const after = (await c.get("/schedules")).body.tasks.find((x: any) => x.id === t.id);
    expect(Date.parse(after.nextRunAt)).toBeGreaterThan(Date.now());
    expect(new Date(after.nextRunAt).getUTCMinutes()).toBe(0);
    expect(after.lastStatus).toBe("completed");
    expect(after.lastConversationId).toBe(started[0].conversationId);
    // not due any more
    expect((await hit()).body.claimed).toBe(0);
    const hist = (await c.get(`/schedules/${t.id}/runs`)).body.runs;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ trigger: "schedule", status: "completed" });
  });

  it("an expired lease is reclaimable; a live lease is not", async () => {
    const c = h.client();
    const t = (await c.post("/schedules", { name: "lease", prompt: "x", modelId: h.modelRowId, schedule: { type: "interval", everyMinutes: 60, timezone: "UTC" } })).body;
    await h.t.database.query("UPDATE scheduled_tasks SET next_run_at = now() - interval '1 minute', lease_until = now() + interval '1 minute' WHERE id = $1", [t.id]);
    const starts: string[] = [];
    const fake = async () => { starts.push("x"); return { runId: crypto.randomUUID(), conversationId: crypto.randomUUID() }; };
    expect((await tick(h.t.database, fake)).claimed).toBe(0);
    // a dispatcher that died mid-claim: lease expired → the next tick takes over
    await h.t.database.query("UPDATE scheduled_tasks SET lease_until = now() - interval '1 second' WHERE id = $1", [t.id]);
    const r = await tick(h.t.database, fake);
    expect(r.claimed).toBe(1);
    expect(starts).toHaveLength(1);
    await c.req("DELETE", `/schedules/${t.id}`);
  });

  it("once tasks disable themselves; start failures are recorded; 立即執行", async () => {
    const c = h.client();
    const t = (await c.post("/schedules", { name: "單次", prompt: "一次就好", modelId: h.modelRowId, schedule: { type: "once", at: "2099-01-01T00:00", timezone: "UTC" } })).body;
    await makeDue(t.id);
    const r = await tick(h.t.database, async () => { throw new Error("模型不可用"); });
    expect(r.failed[0].error).toBe("模型不可用");
    const after = (await c.get("/schedules")).body.tasks.find((x: any) => x.id === t.id);
    expect(after).toMatchObject({ enabled: false, nextRunAt: null, lastStatus: "error", lastError: "模型不可用" });
    // manual run works on a disabled task and leaves the schedule alone
    h.script = [textReply("手動完成")];
    const m = await c.post(`/schedules/${t.id}/run`, {});
    expect(m.status).toBe(202);
    await waitRun(m.body.runId, ["completed"]);
    const hist = (await c.get(`/schedules/${t.id}/runs`)).body.runs;
    expect(hist.map((x: any) => [x.trigger, x.status])).toEqual([["manual", "completed"], ["schedule", "error"]]);
    expect((await c.get("/schedules")).body.tasks.find((x: any) => x.id === t.id).enabled).toBe(false);
  });

  it("uses the task's permission mode: approval-needing tools wait (visible), 全部權限 runs unattended", async () => {
    const c = h.client();
    const t = (await c.post("/schedules", { name: "需批准", prompt: "跑程式", modelId: h.modelRowId, permissionMode: "normal", schedule: { type: "daily", time: "03:00", timezone: "UTC" } })).body;
    h.script = [callsReply([{ id: "c1", name: "code_run", args: { language: "javascript", code: "1+1" } }])];
    const m = await c.post(`/schedules/${t.id}/run`, {});
    const run = await waitRun(m.body.runId, ["waiting_approval"]);
    expect(run.approvals[0].toolName).toBe("code_run");
    expect((await c.get("/schedules")).body.tasks.find((x: any) => x.id === t.id).lastStatus).toBe("waiting_approval");
    await c.post(`/runs/${m.body.runId}/stop`, {});

    await c.req("PATCH", `/schedules/${t.id}`, { permissionMode: "full" });
    h.script = [callsReply([{ id: "c2", name: "code_run", args: { language: "javascript", code: "1+1" } }]), textReply("結果是 2")];
    const m2 = await c.post(`/schedules/${t.id}/run`, {});
    await waitRun(m2.body.runId, ["completed"]);
    const msgs = (await c.get(`/conversations/${m2.body.conversationId}/messages`)).body.messages;
    expect(msgs.at(-1).parts[0].text).toBe("結果是 2");
  });
});
