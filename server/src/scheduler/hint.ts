/**
 * Idle-tick shortcut: keep the scheduler's "next due" time in object storage so a dispatcher tick with nothing due
 * never touches Postgres. On Neon every query wakes the compute (then ≈5 min until it suspends again), so a
 * 15-minute dispatcher alone used to keep the database awake ~8 h a day even with no scheduled tasks.
 *
 * The hint lives in the S3 bucket the app already uses (`system/scheduler-hint.json`) and is rewritten from the
 * database whenever that state can change: after every full tick, every schedule create / update / delete, a token
 * regenerate / delete, and when the 排程 page reads the dispatcher settings. A tick goes the full (database) way when
 * a task is due, the hint is missing / unreadable, or it is older than HINT_MAX_AGE_MS (self-healing safety net).
 * The external dispatcher token is checked against an HMAC of it stored in the hint, so even an unauthenticated
 * caller cannot wake the database with a wrong token while the hint is fresh.
 */
import type { Database } from "../db/client";
import type { AppEnv } from "../env";
import { S3, type Fetch } from "../storage/s3";
import { hmacHex, timingSafeEqual } from "../lib/crypto";

export const HINT_KEY = "system/scheduler-hint.json";
export const LAST_CHECK_KEY = "system/scheduler-last-check.json";
/** A hint older than this is not trusted: the next tick reads the database once (≈4 wakes a day at most). */
export const HINT_MAX_AGE_MS = 6 * 60 * 60_000;

export interface SchedulerHint {
  v: 1;
  /** Earliest next_run_at of an enabled task; null = nothing scheduled. */
  nextDueAt: string | null;
  /** HMAC(JWT_SECRET, "cron-token:" + token) of the external dispatcher token; null = none generated. */
  tokenMac: string | null;
  updatedAt: string;
}

export const cronInternalToken = (secret: string) => hmacHex(secret, "cron-tick");
export const cronTokenMac = (secret: string, token: string) => hmacHex(secret, `cron-token:${token}`);

/** Recompute the hint from the database and store it (best effort: a failure only means the next tick reads the DB). */
export async function writeSchedulerHint(database: Database, s3: S3, jwtSecret: string, token: string | null): Promise<void> {
  try {
    const [r] = await database.query<{ next: Date | string | null }>(
      "SELECT min(next_run_at) AS next FROM scheduled_tasks WHERE enabled AND next_run_at IS NOT NULL",
    );
    const next = r?.next ? new Date(r.next).toISOString() : null;
    const hint: SchedulerHint = { v: 1, nextDueAt: next, tokenMac: token ? await cronTokenMac(jwtSecret, token) : null, updatedAt: new Date().toISOString() };
    await s3.put(HINT_KEY, JSON.stringify(hint), "application/json");
  } catch (e) {
    console.error("[edgemind] scheduler hint not written", e);
    await s3.delete(HINT_KEY).catch(() => {}); // never leave an outdated hint behind
  }
}

async function readJson<T>(s3: S3, key: string): Promise<T | null> {
  const bytes = await s3.getBytes(key);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

export async function readLastCheck(s3: S3): Promise<{ at: string; source: string } | null> {
  const v = await readJson<{ at: string; source: string }>(s3, LAST_CHECK_KEY).catch(() => null);
  return v && typeof v.at === "string" ? v : null;
}

export type IdleTickResult =
  | { kind: "idle"; body: { claimed: 0; started: []; failed: []; idle: true; nextDueAt: string | null } }
  | { kind: "unauthorized"; message?: string }
  | null; // go the full (database) way

/**
 * Decide a dispatcher tick without the database. Returns null whenever the database must be consulted.
 * `given` is the bearer / ?token= value; `internal` the x-edgemind-cron header (Netlify scheduled function).
 */
export async function idleTick(
  env: AppEnv,
  req: { internal?: string | null; given?: string | null; source: string },
  s3Fetch?: Fetch,
  now = Date.now(),
): Promise<IdleTickResult> {
  if (req.internal) {
    if (!timingSafeEqual(req.internal, await cronInternalToken(env.JWT_SECRET))) return { kind: "unauthorized" };
  }
  const s3 = new S3(env, s3Fetch);
  const hint = await readJson<SchedulerHint>(s3, HINT_KEY);
  if (!hint || hint.v !== 1 || typeof hint.updatedAt !== "string") return null;
  const age = now - Date.parse(hint.updatedAt);
  if (!(age >= 0 && age < HINT_MAX_AGE_MS)) return null;
  if (!req.internal) {
    if (!hint.tokenMac) return { kind: "unauthorized", message: "尚未產生排程 token" };
    if (!req.given || !timingSafeEqual(await cronTokenMac(env.JWT_SECRET, req.given), hint.tokenMac)) return { kind: "unauthorized", message: "token 錯誤" };
  }
  if (hint.nextDueAt !== null) {
    const due = Date.parse(hint.nextDueAt);
    if (!Number.isFinite(due) || due <= now) return null;
  }
  await s3.put(LAST_CHECK_KEY, JSON.stringify({ at: new Date(now).toISOString(), source: req.source }), "application/json").catch(() => {});
  return { kind: "idle", body: { claimed: 0, started: [], failed: [], idle: true, nextDueAt: hint.nextDueAt } };
}
