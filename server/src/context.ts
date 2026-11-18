import type { Context } from "hono";
import type { Database } from "./db/client";
import type { AppEnv } from "./env";

/** Platform hooks provided by netlify.ts / cloudflare.ts / vercel.ts (or tests). */
export interface Platform {
  name: "netlify" | "cloudflare" | "vercel" | "node" | "test";
  /** Time budget of one streamed /api/chat segment. Default: soft 50s, hard 57s (Netlify 60s cap). */
  segment?: { softMs: number; hardMs?: number };
  /** Time budget of one background drive invocation. */
  background?: { softMs: number; hardMs?: number };
  /**
   * Start (or continue) background execution of a run. Receives a signed internal URL + token.
   * Default: run in-process via waitUntil (fine for Node / tests).
   */
  startBackground?(args: { origin: string; runId: string; token: string; c: Ctx }): Promise<void>;
  /**
   * Start a generic internal background job (e.g. knowledge-base indexing) at `path` (under /api/internal/,
   * HMAC token in x-edgemind-drive). Default: run in-process via waitUntil.
   */
  startInternal?(args: { origin: string; path: string; token: string; c: Ctx }): Promise<void>;
  /**
   * Streamed segments have a hard wall-clock cap here: a model step cut by it moves the run to background mode
   * instead of being redone in another capped segment (see SegmentOptions.backgroundOnDeadline).
   */
  backgroundOnDeadline?: boolean;
  /** When true, the internal drive endpoint runs the run inline (Netlify background function). */
  driveInline?: boolean;
}

export interface AppDeps {
  /** Build the Database for an env. Prod: Neon HTTP. Tests: node-postgres. */
  getDatabase(env: AppEnv): Database;
  /** Outbound fetch for provider calls (mocked in tests). */
  fetch?: typeof fetch;
  /** fetch used for S3 (tests: in-memory S3 mock). Default: global fetch. */
  s3Fetch?: typeof fetch;
  platform?: Platform;
  /** Tool registry for the agent loop (default: built-ins). */
  tools?: import("./agent/tools").ToolRegistry;
  /** Agent tuning (tests). */
  agent?: Partial<Pick<import("./agent/loop").AgentEnv, "heartbeatMs" | "llmRetry" | "hooks" | "maxToolResultChars">>;
}

export interface HonoEnv {
  Bindings: Record<string, unknown>;
  Variables: {
    env: AppEnv;
    database: Database;
    encKey: Uint8Array;
    sessionId: string;
  };
}

export type Ctx = Context<HonoEnv>;

export function clientIp(c: Ctx): string {
  const h = c.req.header.bind(c.req);
  return (
    h("x-nf-client-connection-ip") ||
    h("cf-connecting-ip") ||
    h("x-forwarded-for")?.split(",")[0].trim() ||
    h("x-real-ip") ||
    "unknown"
  );
}

/** Keep work alive after the response (CF waitUntil / Netlify context.waitUntil via executionCtx). */
export function runInBackground(c: Ctx, p: Promise<unknown>) {
  let ec: { waitUntil(p: Promise<unknown>): void } | undefined;
  try {
    ec = c.executionCtx;
  } catch {
    ec = undefined;
  }
  if (ec) ec.waitUntil(p);
  else p.catch((e) => console.error("[edgemind] background task failed", e));
}
