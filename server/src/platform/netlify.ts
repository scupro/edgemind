/**
 * Netlify Functions (v2, Web-standard Request/Response) adapter.
 * Sync + streaming functions are capped at 60s; background functions (15 min) get their own entry later.
 */
import { createApp } from "../app";
import { createNeonDatabase } from "../db/client";
import { ENV_KEYS, OPTIONAL_ENV_KEYS } from "../env";
import type { Platform } from "../context";
import { useNodeQuickJS } from "../sandbox/quickjs-node";
import { cronInternalToken } from "../routes/schedules";

useNodeQuickJS();

interface NetlifyContext {
  waitUntil?: (p: Promise<unknown>) => void;
}

declare const Netlify: { env: { get(k: string): string | undefined } } | undefined;

function readEnv(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [...ENV_KEYS, ...OPTIONAL_ENV_KEYS]) {
    out[k] = (typeof Netlify !== "undefined" ? Netlify.env.get(k) : undefined) ?? process.env[k];
  }
  return out;
}

let envObj: Record<string, unknown> | undefined;

/** Background mode: hand the run to the `agent-background` background function (15 min, no streaming). */
const startBackground: NonNullable<Platform["startBackground"]> = async ({ origin, runId, token }) => {
  const res = await fetch(`${origin}/.netlify/functions/agent-background`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-edgemind-drive": token },
    body: JSON.stringify({ runId }),
  });
  if (res.status >= 400) throw new Error(`無法啟動背景執行（HTTP ${res.status}）`);
};

/** Generic internal jobs (KB indexing) also run in the background function: body { path }. */
const startInternal: NonNullable<Platform["startInternal"]> = async ({ origin, path, token }) => {
  const res = await fetch(`${origin}/.netlify/functions/agent-background`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-edgemind-drive": token },
    body: JSON.stringify({ path }),
  });
  if (res.status >= 400) throw new Error(`無法啟動背景工作（HTTP ${res.status}）`);
};

const app = createApp({
  getDatabase: (env) => createNeonDatabase(env.DATABASE_URL),
  // Sync/streaming functions are cut at 60 s from the request. 40 s soft / 50 s hard (counted from the request) leaves
  // room to persist the step log and emit `continue` before Netlify ends the response.
  platform: { name: "netlify", segment: { softMs: 40_000, hardMs: 50_000 }, backgroundOnDeadline: true, startBackground, startInternal },
});

/** Same app, configured to drive runs inline with the background-function budget. */
const backgroundApp = createApp({
  getDatabase: (env) => createNeonDatabase(env.DATABASE_URL),
  platform: { name: "netlify", background: { softMs: 13 * 60_000, hardMs: 14 * 60_000 + 30_000 }, driveInline: true, startBackground, startInternal },
});

/** Entry of netlify/functions/agent-background.ts (body: { runId } | { path }, header x-edgemind-drive). */
export async function handleNetlifyBackground(req: Request, context: NetlifyContext): Promise<Response> {
  envObj ??= readEnv();
  const body = (await req.json().catch(() => null)) as { runId?: string; path?: string } | null;
  const runId = typeof body?.runId === "string" ? body.runId : "";
  const origin = new URL(req.url).origin;
  const path = typeof body?.path === "string" && /^\/api\/internal\/[\w\-/]+$/.test(body.path) && !body.path.includes("..")
    ? body.path
    : `/api/internal/runs/${encodeURIComponent(runId)}/drive`;
  const inner = new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "x-edgemind-drive": req.headers.get("x-edgemind-drive") ?? "" },
  });
  const waitUntil = context?.waitUntil?.bind(context) ?? ((p: Promise<unknown>) => void p.catch(() => {}));
  return backgroundApp.fetch(inner, envObj, { waitUntil, passThroughOnException() {}, props: {} } as never);
}

export async function handleNetlify(req: Request, context: NetlifyContext): Promise<Response> {
  envObj ??= readEnv(); // stable object identity -> env validation cached per instance
  const waitUntil = context?.waitUntil?.bind(context) ?? ((p: Promise<unknown>) => void p.catch(() => {}));
  return app.fetch(req, envObj, { waitUntil, passThroughOnException() {}, props: {} } as never);
}

/**
 * Entry of netlify/functions/cron-tick.ts (Netlify Scheduled Function, `config.schedule`). Calls the dispatcher
 * in-process with an HMAC token; runs it starts are handed to agent-background as usual. The site origin comes
 * from Netlify's built-in `URL` variable (set automatically on every deploy).
 */
export async function handleNetlifyCron(_req: Request, context: NetlifyContext): Promise<Response> {
  envObj ??= readEnv();
  const site = (typeof Netlify !== "undefined" ? Netlify.env.get("URL") : undefined) ?? process.env.URL ?? process.env.DEPLOY_PRIME_URL;
  if (!site) return new Response("missing URL", { status: 500 });
  const secret = String(envObj.JWT_SECRET || "unset"); // unset → the app answers 503 env_invalid before checking the token
  const inner = new Request(`${site.replace(/\/$/, "")}/api/cron/tick`, { method: "POST", headers: { "x-edgemind-cron": await cronInternalToken(secret) } });
  const waitUntil = context?.waitUntil?.bind(context) ?? ((p: Promise<unknown>) => void p.catch(() => {}));
  const res = await app.fetch(inner, envObj, { waitUntil, passThroughOnException() {}, props: {} } as never);
  console.log("[edgemind] cron tick", res.status, await res.clone().text().catch(() => ""));
  return res;
}
