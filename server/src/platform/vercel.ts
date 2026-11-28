/**
 * Vercel Functions adapter (Node.js runtime, Fluid compute). Mounted by vercel/api.ts, which
 * scripts/build-vercel.mjs bundles into .vercel/output (Build Output API v3).
 *
 * - No Vercel AI SDK / AI Gateway: LLM calls go straight to each provider through the app's own fetch adapters.
 * - Streaming segments and background drives share the function's maxDuration (Hobby: up to 300 s).
 *   Background mode works like Cloudflare: a signed self-request to /api/internal/.../drive answers 202 and keeps
 *   working inside waitUntil, then chains the next invocation until the run finishes.
 * - Scheduled tasks: an external trigger (cron-worker/, cron-job.org) calling POST /api/cron/tick, or — on plans that
 *   allow frequent Vercel Cron — set VERCEL_CRON_SCHEDULE at build time; Vercel then calls GET /api/cron/vercel with
 *   `Authorization: Bearer $CRON_SECRET`, forwarded in-process with the internal HMAC token.
 */
import { waitUntil as vercelWaitUntil } from "@vercel/functions";
import { createApp } from "../app";
import { createNeonDatabase } from "../db/client";
import { ENV_KEYS, OPTIONAL_ENV_KEYS } from "../env";
import type { Platform } from "../context";
import { useNodeQuickJS } from "../sandbox/quickjs-node";
import { cronInternalToken } from "../routes/schedules";
import { timingSafeEqual } from "../lib/crypto";

useNodeQuickJS();

/** Must match maxDuration written by scripts/build-vercel.mjs (EDGEMIND_MAX_DURATION, default 300). */
const MAX_S = Math.max(60, Number(process.env.EDGEMIND_MAX_DURATION) || 300);
/** Leave a margin for persisting the step log and handing over to the next invocation. */
const budget = { softMs: (MAX_S - 80) * 1000, hardMs: (MAX_S - 45) * 1000 };
/** A model step cut by the hard deadline finishes in background mode (same maxDuration, chained) instead of being redone. */
const MIN_STEP_MS = 60_000;

function readEnv(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [...ENV_KEYS, ...OPTIONAL_ENV_KEYS]) out[k] = process.env[k];
  return out;
}

let envObj: Record<string, unknown> | undefined;

const waitUntil = (p: Promise<unknown>) => {
  const guarded = p.catch((e) => console.error("[edgemind] background task failed", e));
  try {
    vercelWaitUntil(guarded);
  } catch {
    /* outside a Vercel request context (local smoke tests) */
  }
};

/** Self-requests must pass Deployment Protection on preview deployments (Protection Bypass for Automation). */
function selfHeaders(token: string): Record<string, string> {
  const h: Record<string, string> = { "x-edgemind-drive": token };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) h["x-vercel-protection-bypass"] = bypass;
  return h;
}

const platform: Platform = {
  name: "vercel",
  segment: budget,
  background: budget,
  minStepMs: MIN_STEP_MS,
  backgroundOnDeadline: true, // a step longer than one capped segment keeps going in background mode (chained)
  async startBackground({ origin, runId, token }) {
    const res = await fetch(`${origin}/api/internal/runs/${encodeURIComponent(runId)}/drive`, { method: "POST", headers: selfHeaders(token) });
    if (res.status >= 400) throw new Error(`無法啟動背景執行（HTTP ${res.status}）`);
  },
  async startInternal({ origin, path, token }) {
    const res = await fetch(`${origin}${path}`, { method: "POST", headers: selfHeaders(token) });
    if (res.status >= 400) throw new Error(`無法啟動背景工作（HTTP ${res.status}）`);
  },
};

const app = createApp({ getDatabase: (env) => createNeonDatabase(env.DATABASE_URL), platform });

const execCtx = { waitUntil, passThroughOnException() {}, props: {} } as never;

/** Vercel Cron → the app's dispatcher, authenticated with CRON_SECRET and re-signed with the internal token. */
async function handleVercelCron(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }
  const jwt = String(envObj!.JWT_SECRET || "unset"); // unset → the app answers 503 env_invalid before checking the token
  const inner = new Request(new URL("/api/cron/tick", req.url), {
    method: "POST",
    headers: { "x-edgemind-cron": await cronInternalToken(jwt), "x-edgemind-cron-source": "vercel-cron" },
  });
  const res = await app.fetch(inner, envObj, execCtx);
  console.log("[edgemind] cron tick", res.status, await res.clone().text().catch(() => ""));
  return res;
}

export async function handleVercel(req: Request): Promise<Response> {
  envObj ??= readEnv(); // stable object identity -> env validation cached per instance
  const url = new URL(req.url);
  // .vercel/output/config.json routes /api/* to this one function and passes the original path along in case the rewrite changed it.
  const original = url.searchParams.get("__em_path");
  // Vercel terminates TLS in front of the function, so the URL built by @hono/node-server is http://.
  // Restore the client's scheme so the CSRF Origin check and Secure cookies see https.
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const fixProto = proto === "https" && url.protocol === "http:";
  if (fixProto) url.protocol = "https:";
  if (original !== null) {
    url.searchParams.delete("__em_path");
    url.pathname = `/api${original.startsWith("/") ? original : original ? `/${original}` : ""}`;
  }
  if (original !== null || fixProto) {
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    req = new Request(url, { method: req.method, headers: req.headers, body: hasBody ? req.body : undefined, duplex: "half", signal: req.signal } as RequestInit);
  }
  if (url.pathname === "/api/cron/vercel") return handleVercelCron(req);
  return app.fetch(req, envObj, execCtx);
}
