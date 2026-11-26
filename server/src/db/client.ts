/**
 * DB abstraction. Production uses the Neon serverless HTTP driver (works on Netlify Functions and
 * Cloudflare Workers, no TCP/pool). Tests inject a node-postgres backed Database (see test/helpers).
 */
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: AppDb;
  /** Run raw SQL statements atomically (used by the migrator). */
  execTransaction(statements: string[]): Promise<void>;
  /** Run one raw query and return rows. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

const cache = new Map<string, Database>();

/**
 * Postgres rejects NUL in text ("invalid byte sequence") and the JSON escape \u0000 in jsonb
 * ("unsupported Unicode escape sequence"). Tool output (shell, MCP) can contain either, so strip
 * raw NULs and turn an unescaped \u0000 sequence into \u2400 (the visible ␀ symbol) before sending.
 */
const NUL_ESC = /(^|[^\\])((?:\\\\)*)\\u0000/g;
export function scrubNul(v: unknown): unknown {
  if (typeof v === "string") {
    let s = v.indexOf("\u0000") >= 0 ? v.replace(/\u0000/g, "") : v;
    if (s.indexOf("\\u0000") >= 0) { let prev; do { prev = s; s = s.replace(NUL_ESC, "$1$2\\u2400"); } while (s !== prev); }
    return s;
  }
  if (Array.isArray(v)) return v.map(scrubNul);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = scrubNul(x);
    return o;
  }
  return v;
}

export function createNeonDatabase(url: string): Database {
  const hit = cache.get(url);
  if (hit) return hit;
  const sql = neon(url);
  const client = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => sql(strings, ...(values.map(scrubNul) as any[])),
    {
      query: (text: string, params?: unknown[], opts?: any) => sql.query(text, params ? (params.map(scrubNul) as any[]) : params, opts),
      transaction: sql.transaction.bind(sql),
    },
  );
  const database: Database = {
    db: drizzleNeon({ client: client as unknown as typeof sql, schema }) as unknown as AppDb,
    async execTransaction(statements) {
      await sql.transaction(statements.map((s) => sql.query(s)));
    },
    async query<T>(text: string, params: unknown[] = []) {
      return (await sql.query(text, params.map(scrubNul) as any[])) as T[];
    },
  };
  cache.set(url, database);
  return database;
}

export { schema };
