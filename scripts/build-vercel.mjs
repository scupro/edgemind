// Vercel build (Build Output API v3): static SPA + one Node.js function for /api/*.
// Runs as vercel.json's buildCommand after the web build. Output: .vercel/output (git-ignored).
//
// Optional build-time env (set in Vercel → Settings → Environment Variables):
//   EDGEMIND_MAX_DURATION  function maxDuration in seconds (default 300 = Hobby + Fluid compute max; Pro allows more)
//   VERCEL_CRON_SCHEDULE   e.g. "*/15 * * * *" — adds a Vercel Cron job calling /api/cron/vercel (needs CRON_SECRET).
//                          Hobby only allows once a day, so leave it unset there and use cron-worker/ or cron-job.org.
//   EDGEMIND_FUNCTION_REGION  e.g. "sin1" / "hnd1" — put the function next to your Neon database (default: project setting)
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const OUT = ".vercel/output";
const maxDuration = Math.max(60, Number(process.env.EDGEMIND_MAX_DURATION) || 300);
const cron = process.env.VERCEL_CRON_SCHEDULE?.trim();
const region = process.env.EDGEMIND_FUNCTION_REGION?.trim();

if (!existsSync("web/dist/index.html")) {
  console.error("web/dist is missing: run the web build first (npm run build:vercel does both)");
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/functions/api.func`, { recursive: true });

// 1) static files
cpSync("web/dist", `${OUT}/static`, { recursive: true });
// Cloudflare-only files are harmless but useless here
for (const f of ["_routes.json", "_headers"]) rmSync(`${OUT}/static/${f}`, { force: true });

// 2) the API function
await build({
  entryPoints: ["vercel/api.ts"],
  outfile: `${OUT}/functions/api.func/index.mjs`,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
  define: { "process.env.EDGEMIND_MAX_DURATION": JSON.stringify(String(maxDuration)) },
  // some CJS deps call require(); give the ESM bundle one
  banner: { js: "import { createRequire as __edgemindCreateRequire } from 'node:module'; const require = __edgemindCreateRequire(import.meta.url);" },
});
writeFileSync(`${OUT}/functions/api.func/package.json`, JSON.stringify({ type: "module" }));
writeFileSync(
  `${OUT}/functions/api.func/.vc-config.json`,
  JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration,
      ...(region ? { regions: [region] } : {}),
    },
    null,
    2,
  ),
);

// 3) routing (mirrors netlify.toml's headers and SPA fallback)
const security = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "DENY" };
const config = {
  version: 3,
  routes: [
    { src: "^/assets/(.*)$", headers: { "Cache-Control": "public, max-age=31536000, immutable" }, continue: true },
    { src: "^/sw\\.js$", headers: { "Cache-Control": "no-cache" }, continue: true },
    { src: "^/manifest\\.webmanifest$", headers: { "Content-Type": "application/manifest+json" }, continue: true },
    { src: "^/(.*)$", headers: security, continue: true },
    // every /api path goes to the single function; the original path rides along in __em_path
    { src: "^/api(/.*)?$", dest: "/api?__em_path=$1" },
    { handle: "filesystem" },
    { src: "^/(.*)$", dest: "/index.html" },
  ],
  ...(cron ? { crons: [{ path: "/api/cron/vercel", schedule: cron }] } : {}),
};
writeFileSync(`${OUT}/config.json`, JSON.stringify(config, null, 2));

console.log(`vercel output: ${OUT} (maxDuration ${maxDuration}s${cron ? `, cron "${cron}"` : ", no Vercel Cron"}${region ? `, region ${region}` : ""})`);

// 4) smoke: the bundle loads and answers /api/status with an env report (no env set here)
if (process.env.VERCEL !== "1") {
  const { createServer } = await import("node:http");
  const { pathToFileURL } = await import("node:url");
  const saved = {};
  for (const k of ["DATABASE_URL", "ENCRYPTION_KEY", "JWT_SECRET"]) { saved[k] = process.env[k]; delete process.env[k]; }
  const mod = await import(pathToFileURL(`${OUT}/functions/api.func/index.mjs`).href);
  const server = createServer(mod.default);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(`${base}/api?__em_path=/status`)).json();
  const cronRes = await fetch(`${base}/api?__em_path=/cron/vercel`);
  server.close();
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  if (status.env?.ok !== false || cronRes.status !== 401) {
    console.error("vercel smoke failed", status, cronRes.status);
    process.exit(1);
  }
  console.log("smoke: vercel bundle serves /api/status via the rewrite; /api/cron/vercel rejects without CRON_SECRET");
}
