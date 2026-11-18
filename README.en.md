# EdgeMind

English ｜ [正體中文](README.md)

A single-user, self-hosted, serverless AI agent workspace: chat, projects, files, knowledge base (RAG), memory, Skills, MCP, web search, code execution, scheduled tasks and a usage dashboard — with every model and search provider configurable in the web UI. The UI is in 正體中文 (zh-Hant-TW).

The full documentation is written in 正體中文; this page is a short English summary.

## Highlights

- **Primary target: Netlify** (Functions + Background Functions + Scheduled Functions); the same code also deploys to **Cloudflare Pages**.
- **Neon Postgres + pgvector**; object storage via Neon Object Storage or any S3-compatible service (Cloudflare R2, Backblaze B2, MinIO, AWS S3).
- Self-written LLM adapters on plain `fetch` (no Vercel AI SDK): OpenAI-compatible (Chat Completions / Responses), Anthropic Messages, Gemini generateContent — including reasoning signatures round-tripped across tool calls.
- Agent loop persisted step by step, ~50 s segments with automatic continuation, background mode, permission modes (Plan / Normal / Auto-edit / Full / Custom) with approvals and an audit log.
- Built-in tools: web search (Tavily, Serper, SearXNG, Jina, Google PSE) and fetch, project files with versions, knowledge-base search, memory, skills, `code_run` (server-side QuickJS JavaScript, in-browser Pyodide Python), `http_request` with a server-side secrets vault, image generation, sub-agents.
- Own native-fetch MCP client (Streamable HTTP + legacy SSE, OAuth 2.1).
- API keys, secrets and MCP credentials encrypted with AES-256-GCM.

## Environment variables

Only these come from the environment (see [`.env.example`](.env.example)); everything else lives in the database and is configured in the UI:
`DATABASE_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, optional `S3_FORCE_PATH_STYLE` (default `true`),
`ENCRYPTION_KEY` (`openssl rand -base64 32`), `JWT_SECRET` (`openssl rand -base64 48`).

## Deploy

- Netlify: [docs/deploy-netlify.md](docs/deploy-netlify.md)
- Vercel: [docs/deploy-vercel.md](docs/deploy-vercel.md) — Build Output API + Fluid compute; no Vercel AI SDK, no AI Gateway.
- Cloudflare Pages: [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md) — note the free plan's 10 ms CPU / 50 subrequests per request limits.
- Post-deploy checks: [docs/verification-checklist.md](docs/verification-checklist.md)
- All settings: [docs/configuration.md](docs/configuration.md)

> ⚠️ Open the site right after the first deploy and set the owner password. Until then, whoever reaches a fresh deploy first can complete the setup.

## Development

```bash
npm install
./scripts/test-db.sh          # local Postgres 17 + pgvector on :54329
cp .env.example .env          # fill in, then: set -a; . ./.env; set +a
npm run dev:api               # API on :8787
npm run dev                   # Vite, proxies /api
npm test                      # vitest against real Postgres
npm run typecheck
npm run build                 # web + Netlify/Cloudflare function bundles + smoke tests
```

## License

Released under the [MIT License](LICENSE).
