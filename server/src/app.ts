import { Hono } from "hono";
import type { StatusResponse } from "../../shared/src/index";
import type { AppDeps, HonoEnv } from "./context";
import { decodeKey32, validateEnv, type EnvValidation } from "./env";
import { migrate } from "./db/migrate";
import type { Database } from "./db/client";
import { APP_VERSION } from "./version";
import { BadInput } from "./lib/errors";
import { mountAuth, isAuthenticated, ensureCsrfCookie } from "./routes/auth";
import { mountProviders } from "./routes/providers";
import { mountChat } from "./routes/chat";
import { mountPermissions } from "./routes/permissions";
import { mountWorkspace } from "./routes/workspace";
import { mountFiles } from "./routes/files";
import { mountKb } from "./routes/kb";
import { mountSkills } from "./routes/skills";
import { mountMcp } from "./routes/mcp";
import { mountMemory } from "./routes/memory";
import { mountSecrets } from "./routes/secrets";
import { mountSchedules } from "./routes/schedules";
import { mountUsage } from "./routes/usage";
import { idleTick } from "./scheduler/hint";

/** Migrations run at most once per isolate per database URL. */
const migrated = new Map<string, Promise<void>>();

export function ensureMigrated(database: Database, url: string): Promise<void> {
  let p = migrated.get(url);
  if (!p) {
    p = migrate(database).then(() => undefined);
    p.catch(() => migrated.delete(url));
    migrated.set(url, p);
  }
  return p;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<HonoEnv>().basePath("/api");

  app.onError((err, c) => {
    if (err instanceof BadInput) return c.json({ error: "bad_request", message: err.message }, 400);
    console.error("[edgemind]", err);
    return c.json({ error: "internal_error", message: err.message }, 500);
  });

  // API answers are per-user live data: never let a browser / CDN cache serve a stale list (e.g. 設定 → 密鑰 after a save).
  app.use("*", async (c, next) => {
    await next();
    try {
      if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
    } catch {
      /* immutable headers (proxied response): leave as is */
    }
  });

  const envCache = new WeakMap<object, EnvValidation>();
  const checkEnv = (raw: Record<string, unknown>) => {
    let v = envCache.get(raw);
    if (!v) {
      v = validateEnv(raw);
      envCache.set(raw, v);
    }
    return v;
  };

  // Status: always reachable; drives the SPA's env-error / setup / login screens.
  app.get("/status", async (c) => {
    const v = checkEnv(c.env ?? {});
    const body: StatusResponse = {
      env: { ok: v.ok, issues: v.issues },
      db: { ok: false },
      setupRequired: false,
      authenticated: false,
      version: APP_VERSION,
    };
    if (!v.ok || !v.env) return c.json(body);
    const database = deps.getDatabase(v.env);
    try {
      await ensureMigrated(database, v.env.DATABASE_URL);
      const rows = await database.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
      body.db = { ok: true, migrated: true };
      body.setupRequired = rows[0].n === 0;
      body.authenticated = !body.setupRequired && (await isAuthenticated(c, v.env, database));
    } catch (e) {
      body.db = { ok: false, error: (e as Error).message };
    }
    ensureCsrfCookie(c);
    return c.json(body);
  });

  // Dispatcher ticks with nothing due are answered from object storage, before the database middleware below (which
  // runs migrations and would wake Neon). Anything else (a task due, no / stale hint) falls through to the real tick.
  app.post("/cron/tick", async (c, next) => {
    const v = checkEnv(c.env ?? {});
    if (!v.ok || !v.env) return next();
    const internal = c.req.header("x-edgemind-cron") ?? null;
    const given = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? c.req.query("token") ?? null;
    const source = c.req.header("x-edgemind-cron-source")?.slice(0, 40) || (internal ? "netlify-scheduled" : "external");
    const r = await idleTick(v.env, { internal, given, source }, deps.s3Fetch).catch((e) => {
      console.error("[edgemind] idle tick check failed", e);
      return null;
    });
    if (r?.kind === "unauthorized") return c.json({ error: "unauthorized", ...(r.message ? { message: r.message } : {}) }, 401);
    if (r?.kind === "idle") return c.json(r.body);
    return next();
  });

  // Everything else needs a valid env + migrated DB.
  app.use("*", async (c, next) => {
    const v = checkEnv(c.env ?? {});
    if (!v.ok || !v.env) return c.json({ error: "env_invalid", issues: v.issues }, 503);
    const database = deps.getDatabase(v.env);
    await ensureMigrated(database, v.env.DATABASE_URL);
    c.set("env", v.env);
    c.set("database", database);
    c.set("encKey", decodeKey32(v.env.ENCRYPTION_KEY)!);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true, platform: deps.platform?.name ?? "unknown" }));


  mountAuth(app);
  mountProviders(app, deps);
  const chatApi = mountChat(app, deps);
  mountPermissions(app, deps);
  mountWorkspace(app, deps);
  mountFiles(app, deps);
  mountKb(app, deps);
  mountSkills(app, deps);
  mountMcp(app, deps);
  mountMemory(app, deps);
  mountSecrets(app);
  mountSchedules(app, chatApi, deps);
  mountUsage(app);

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}

export type App = ReturnType<typeof createApp>;
