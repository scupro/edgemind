/**
 * Scheduled tasks (排程).
 *   GET    /api/schedules                  list (+ last run status)
 *   POST   /api/schedules                  { name, prompt, projectId?, modelId?, permissionMode?, schedule, enabled? }
 *   PATCH  /api/schedules/:id              any of the above
 *   DELETE /api/schedules/:id
 *   GET    /api/schedules/:id/runs         execution history (status from the agent run)
 *   POST   /api/schedules/:id/run          立即執行 (does not move next_run_at)
 *   POST   /api/schedules/preview          { schedule } → next 5 run times
 *   GET    /api/settings/cron              external-dispatcher token + last tick
 *   POST   /api/settings/cron/token        (re)generate the token;  DELETE → remove it
 *   POST   /api/cron/tick                  dispatcher: `Authorization: Bearer <token>` (cron-job.org / CF cron Worker)
 *                                          or `x-edgemind-cron: HMAC(JWT_SECRET,"cron-tick")` (Netlify scheduled function)
 *
 * Approvals: scheduled runs use the task's permission mode. A tool that needs approval does NOT fail: the run
 * goes to `waiting_approval` and waits, visible in the 排程 page (status 等待批准 + link) and in the conversation,
 * where the normal approval card resumes it. Browser-only tools (code_run python) return an error in
 * background runs. Use 全部權限 (with its caps) for fully unattended tasks.
 */
import type { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { ScheduledTaskDTO, ScheduledTaskRunDTO, CronSettingsDTO } from "../../../shared/src/index";
import type { AppDeps, Ctx, HonoEnv } from "../context";
import type { ChatApi } from "./chat";
import { models, projects, scheduledTasks, settings, auditLogs } from "../db/schema";
import { BadInput } from "../lib/errors";
import { decryptSecret, encryptSecret, randomToken, timingSafeEqual } from "../lib/crypto";
import { getSetting } from "../lib/settings";
import { isPermissionMode } from "../agent/permissions";
import { describeSpec, nextRun, ScheduleError, validateSpec, type ScheduleSpec } from "../scheduler/cron";
import { history, lastStatuses, recordExecution, tick } from "../scheduler/service";
import { cronInternalToken, readLastCheck, writeSchedulerHint } from "../scheduler/hint";
import { s3For } from "./files";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export { cronInternalToken };
const TOKEN_AAD = "cron_token";

type Row = typeof scheduledTasks.$inferSelect;

function spec(v: unknown): ScheduleSpec {
  try {
    return validateSpec(v);
  } catch (e) {
    if (e instanceof ScheduleError) throw new BadInput(e.message);
    throw e;
  }
}

function toDTO(r: Row, last?: { status: string; conversationId: string }): ScheduledTaskDTO {
  const s = r.schedule as ScheduleSpec;
  return {
    id: r.id, name: r.name, prompt: r.prompt, projectId: r.projectId, modelId: r.modelId, permissionMode: r.permissionMode,
    schedule: s, summary: describeSpec(s), enabled: r.enabled,
    nextRunAt: r.nextRunAt?.toISOString() ?? null, lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastStatus: r.lastError && !r.lastRunId ? "error" : last?.status ?? null, lastError: r.lastError,
    lastConversationId: last?.conversationId ?? null, createdAt: r.createdAt.toISOString(),
  };
}

async function readToken(c: Ctx): Promise<string | null> {
  const [row] = await c.get("database").db.select({ enc: settings.secretEnc }).from(settings).where(eq(settings.key, "cron_token")).limit(1);
  if (!row?.enc) return null;
  try {
    return await decryptSecret(row.enc, c.get("encKey"), TOKEN_AAD);
  } catch {
    return null;
  }
}

export function mountSchedules(app: Hono<HonoEnv>, chat: ChatApi, deps: AppDeps = {} as AppDeps) {
  /** Keep the idle-tick hint (object storage) in step with the database: see scheduler/hint.ts. */
  const refreshHint = async (c: Ctx) => writeSchedulerHint(c.get("database"), s3For(c, deps), c.get("env").JWT_SECRET, await readToken(c));

  const startRun = (c: Ctx) => (t: { name: string; prompt: string; projectId: string | null; modelId: string | null; permissionMode: string | null }) =>
    chat.startConversationRun(c, { prompt: t.prompt, title: `[排程] ${t.name}`, projectId: t.projectId, modelId: t.modelId, permissionMode: t.permissionMode });

  async function parseBody(c: Ctx, body: any, existing?: Row) {
    const db = c.get("database").db;
    const out: Partial<typeof scheduledTasks.$inferInsert> = {};
    if (body.name !== undefined || !existing) {
      if (typeof body.name !== "string" || !body.name.trim()) throw new BadInput("請輸入名稱");
      out.name = body.name.trim().slice(0, 100);
    }
    if (body.prompt !== undefined || !existing) {
      if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new BadInput("請輸入要執行的提示詞");
      if (body.prompt.length > 20_000) throw new BadInput("提示詞過長");
      out.prompt = body.prompt;
    }
    if (body.projectId !== undefined) {
      if (body.projectId === null) out.projectId = null;
      else {
        if (!isUuid(body.projectId)) throw new BadInput("projectId 格式錯誤");
        const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, body.projectId)).limit(1);
        if (!p) throw new BadInput("找不到專案");
        out.projectId = p.id;
      }
    }
    if (body.modelId !== undefined) {
      if (body.modelId === null) out.modelId = null;
      else {
        if (!isUuid(body.modelId)) throw new BadInput("modelId 格式錯誤");
        const [m] = await db.select({ id: models.id }).from(models).where(eq(models.id, body.modelId)).limit(1);
        if (!m) throw new BadInput("找不到指定的模型");
        out.modelId = m.id;
      }
    }
    if (body.permissionMode !== undefined) {
      if (body.permissionMode !== null && !isPermissionMode(body.permissionMode)) throw new BadInput("未知的權限模式");
      out.permissionMode = body.permissionMode;
    }
    if (body.enabled !== undefined) out.enabled = body.enabled === true;
    if (body.schedule !== undefined || !existing) out.schedule = spec(body.schedule);
    // recompute next run when the schedule changes or the task is (re-)enabled
    const s = (out.schedule ?? existing?.schedule) as ScheduleSpec;
    const enabled = out.enabled ?? existing?.enabled ?? true;
    if (out.schedule !== undefined || (out.enabled === true && !existing?.enabled) || !existing) {
      const n = nextRun(s, Date.now());
      out.nextRunAt = n === null ? null : new Date(n);
      if (n === null && enabled && s.type === "once") throw new BadInput("單次排程的時間已經過去");
    }
    out.updatedAt = new Date();
    return out;
  }

  app.get("/schedules", async (c) => {
    const database = c.get("database");
    const rows = await database.db.select().from(scheduledTasks).orderBy(desc(scheduledTasks.createdAt));
    const st = await lastStatuses(database, rows.map((r) => r.lastRunId).filter((x): x is string => !!x));
    return c.json({ tasks: rows.map((r) => toDTO(r, r.lastRunId ? st.get(r.lastRunId) : undefined)) });
  });

  app.post("/schedules/preview", async (c) => {
    const body = await c.req.json().catch(() => null);
    const s = spec(body?.schedule);
    const times: string[] = [];
    let t = Date.now();
    for (let i = 0; i < 5; i++) {
      const n = nextRun(s, t);
      if (n === null) break;
      times.push(new Date(n).toISOString());
      if (s.type === "once") break;
      t = n;
    }
    return c.json({ summary: describeSpec(s), next: times });
  });

  app.post("/schedules", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    const values = await parseBody(c, body);
    const [row] = await c.get("database").db.insert(scheduledTasks).values(values as typeof scheduledTasks.$inferInsert).returning();
    await refreshHint(c);
    return c.json(toDTO(row), 201);
  });

  const load = async (c: Ctx): Promise<Row | null> => {
    const id = c.req.param("id");
    if (!isUuid(id)) return null;
    const [row] = await c.get("database").db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).limit(1);
    return row ?? null;
  };

  app.patch("/schedules/:id", async (c) => {
    const row = await load(c);
    if (!row) return c.json({ error: "not_found", message: "找不到排程" }, 404);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    const values = await parseBody(c, body, row);
    const [upd] = await c.get("database").db.update(scheduledTasks).set(values).where(eq(scheduledTasks.id, row.id)).returning();
    await refreshHint(c);
    return c.json(toDTO(upd));
  });

  app.delete("/schedules/:id", async (c) => {
    const row = await load(c);
    if (!row) return c.json({ error: "not_found", message: "找不到排程" }, 404);
    await c.get("database").db.delete(scheduledTasks).where(eq(scheduledTasks.id, row.id));
    await refreshHint(c);
    return c.json({ ok: true });
  });

  app.get("/schedules/:id/runs", async (c) => {
    const row = await load(c);
    if (!row) return c.json({ error: "not_found", message: "找不到排程" }, 404);
    const items = await history(c.get("database"), row.id);
    const out: ScheduledTaskRunDTO[] = items.map(({ h, status, runError }) => ({
      id: h.id, trigger: h.trigger as "schedule" | "manual", runId: h.runId, conversationId: h.conversationId,
      scheduledFor: h.scheduledFor?.toISOString() ?? null, createdAt: h.createdAt.toISOString(),
      status: h.error ? "error" : status ?? "unknown", error: h.error ?? runError ?? null,
    }));
    return c.json({ runs: out });
  });

  app.post("/schedules/:id/run", async (c) => {
    const row = await load(c);
    if (!row) return c.json({ error: "not_found", message: "找不到排程" }, 404);
    const database = c.get("database");
    try {
      const r = await startRun(c)(row);
      await recordExecution(database, row.id, "manual", null, r);
      return c.json(r, 202);
    } catch (e) {
      const error = (e as Error).message;
      await recordExecution(database, row.id, "manual", null, { error });
      return c.json({ error: "start_failed", message: error }, 400);
    }
  });

  // ----- dispatcher token -----
  app.get("/settings/cron", async (c) => {
    const dbLast = await getSetting<{ at: string; source: string }>(c.get("database"), "cron_last_tick");
    // idle ticks never reach the database: their time is kept next to the hint
    const idleLast = await readLastCheck(s3For(c, deps)).catch(() => null);
    const last = idleLast && (!dbLast || Date.parse(idleLast.at) > Date.parse(dbLast.at)) ? idleLast : dbLast;
    await refreshHint(c);
    const out: CronSettingsDTO = { token: await readToken(c), lastTickAt: last?.at ?? null, lastTickSource: last?.source ?? null };
    return c.json(out);
  });

  app.post("/settings/cron/token", async (c) => {
    const token = `emc_${randomToken(24)}`;
    const enc = await encryptSecret(token, c.get("encKey"), TOKEN_AAD);
    const database = c.get("database");
    await database.db.insert(settings).values({ key: "cron_token", value: null, secretEnc: enc })
      .onConflictDoUpdate({ target: settings.key, set: { secretEnc: enc, updatedAt: new Date() } });
    await database.db.insert(auditLogs).values({ action: "settings_change", detail: { key: "cron_token", op: "regenerate" } });
    await refreshHint(c);
    return c.json({ token });
  });

  app.delete("/settings/cron/token", async (c) => {
    await c.get("database").db.delete(settings).where(eq(settings.key, "cron_token"));
    await refreshHint(c);
    return c.json({ ok: true });
  });

  // ----- dispatcher (token-protected; exempt from cookie auth + CSRF) -----
  app.post("/cron/tick", async (c) => {
    const internal = c.req.header("x-edgemind-cron");
    let source: string;
    if (internal) {
      if (!timingSafeEqual(internal, await cronInternalToken(c.get("env").JWT_SECRET))) return c.json({ error: "unauthorized" }, 401);
      source = c.req.header("x-edgemind-cron-source")?.slice(0, 40) || "netlify-scheduled";
    } else {
      const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
      const given = m?.[1] ?? c.req.query("token") ?? "";
      const token = await readToken(c);
      if (!token || !given || !timingSafeEqual(given, token)) return c.json({ error: "unauthorized", message: token ? "token 錯誤" : "尚未產生排程 token" }, 401);
      source = c.req.header("x-edgemind-cron-source")?.slice(0, 40) || "external";
    }
    const result = await tick(c.get("database"), startRun(c), { source });
    await refreshHint(c);
    return c.json(result);
  });
}
