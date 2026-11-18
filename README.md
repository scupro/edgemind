# EdgeMind

[English](README.en.md) ｜ 正體中文

EdgeMind 是一個**單人自用、自架、Serverless** 的 AI Agent 工作台，體驗接近 Claude／ChatGPT：聊天、專案、檔案、知識庫、記憶、Skills、MCP、網頁搜尋、程式執行與排程任務，全部集中在一個網頁介面中。所有模型與搜尋供應商都可以自行設定，API Key 加密後存在你自己的資料庫裡。

- **主要部署平台：Netlify**（Functions + Background Functions + Scheduled Functions）
- **次要部署平台：Cloudflare Pages**（同一份程式，透過平台適配層掛載）
- **也可部署到 Vercel**（Build Output API＋Fluid compute，不使用 Vercel AI SDK／AI Gateway），見 [docs/deploy-vercel.md](docs/deploy-vercel.md)
- **資料：Neon Postgres（含 pgvector）＋ 任何 S3 相容物件儲存**（Neon Object Storage、Cloudflare R2、Backblaze B2、MinIO、AWS S3…）
- **介面：正體中文**，淺色／深色／跟隨系統，可安裝為 PWA

## 目錄

- [功能](#功能)
- [架構概覽](#架構概覽)
- [技術選型](#技術選型)
- [介面導覽](#介面導覽)
- [快速開始（本機開發）](#快速開始本機開發)
- [部署](#部署)
- [專案結構](#專案結構)
- [安全設計](#安全設計)
- [文件](#文件)

## 功能

### 聊天

- 串流 Markdown（程式碼高亮、KaTeX 數學式、Mermaid 圖表）、可摺疊的思考過程（reasoning）、工具呼叫卡片（風險等級、參數與結果）。
- 每則對話可切換模型與推理強度；重新生成、編輯先前訊息並分支、分支切換、複製、匯出 Markdown／JSON。
- 附件：小圖片與文字直接內嵌，其他檔案直傳物件儲存後交給模型（圖片給視覺模型、PDF 給支援的模型）。
- **背景模式**：長任務交給背景函式執行，關掉分頁也會繼續；回來時從步驟紀錄接續顯示。
- 前景模式每段請求約 50 秒，到時自動存檔並無縫續跑，不受 Serverless 執行時間上限影響。
- 自動命名、全文搜尋（含中日韓文字）、置頂、封存、移到專案／移出專案。

### 專案

- 專案的對話歸在專案底下：側邊欄點專案會直接接續它最近的對話（沒有對話時開啟專案頁），展開可看到全部對話（最新的在上）；在專案中開新對話是明確的「在專案中新對話」。側邊欄的「最近對話」只列不屬於任何專案的對話。
- 舊對話可以用對話選單的「移到專案…」或專案頁的「加入現有對話」移進專案，「移出專案」移回來。
- 專屬指示（System Prompt）、預設模型、預設權限模式。
- 專案檔案空間：瀏覽器直傳 S3（大檔自動分段上傳），每次覆寫或刪除前自動保留舊版本，可還原。
- 專案專屬知識庫、記憶，以及可啟用的工具、Skills、MCP 伺服器清單。

### Agent 與工具

- Agent Loop：平行工具呼叫、步數上限、每一步都寫入資料庫（斷線可接續、待批准狀態可隔天再批）。
- **權限系統**：唯讀（Plan）／一般／自動編輯／全部權限／自訂五種模式，可在全域、專案、單一對話設定；每次詢問可選「本次允許／本對話一直允許／拒絕」；所有工具呼叫寫入稽核紀錄。
- 內建工具：

| 工具 | 說明 | 預設風險 |
|---|---|---|
| `web_search` | Tavily／Serper／SearXNG／Jina／Google PSE，依優先順序自動備援，結果一律限長 | 讀取 |
| `web_fetch` | Readability 轉 Markdown、分段讀取、SSRF 防護、Jina Reader 備援 | 讀取 |
| `file_list`／`file_read`／`file_search` | 讀取專案檔 | 讀取 |
| `file_write`／`file_edit`／`file_delete` | 寫入專案檔（保留版本） | 寫入 |
| `kb_search` | 知識庫混合檢索，附編號引用 | 讀取 |
| `memory_search`／`memory_save`／`memory_update`／`memory_delete` | 長期記憶 | 讀取／寫入 |
| `skill_load`／`skill_write` | 讀取或建立 Skill | 讀取／寫入 |
| `code_run` | JavaScript（伺服器端 QuickJS-WASM）或 Python（瀏覽器端 Pyodide） | 危險 |
| `http_request` | 任意 HTTP API，`{{secret:名稱}}` 由伺服器端代入密鑰 | 危險 |
| `image_generate` | 圖片生成（OpenAI 相容、Gemini、Workers AI），存入專案 | 寫入 |
| `subagent` | 派發唯讀子代理，隔離上下文完成子任務 | 讀取 |
| `todo`／`ask_user` | 模型自己的待辦清單、中途向你提問 | 讀取 |

### 知識庫（RAG）

- 全域或專案專屬；每個知識庫綁定一個 Embedding 供應商＋模型＋維度，可選重排序（Jina／Cohere／Voyage）。
- 在**瀏覽器中**解析與切塊：txt、md、程式碼、csv、json、html、PDF（pdfjs-dist）、DOCX（mammoth）；伺服器只負責批次向量化。
- 向量（pgvector HNSW）＋全文（應用程式端中日韓二字詞 tsvector）以 RRF 融合；換模型時背景分批重建索引，可中斷續跑。

### 記憶與上下文

- 三層記憶：全域／專案／對話；每回合自動語意召回 Top-K；對話結束後由輔助模型自動萃取記憶（會過濾明顯的密鑰）。
- 對話過長時自動壓縮較早的內容為摘要（依上下文長度比例觸發），也可手動壓縮。

### Skills

- 相容 Agent Skills 格式（資料夾＋`SKILL.md` YAML 前置資料），存在物件儲存。
- 漸進揭露：系統提示只放名稱與描述，模型需要時才以 `skill_load` 讀取完整內容與附檔。
- 上傳 zip、線上編輯（檔案樹）、從 GitHub 網址匯入、匯出 zip，模型也能在權限允許下自行建立 Skill。
- 內建 Skills：`e2b-sandbox`（E2B 雲端沙盒）、`self-hosted-runner`（自架 Piston／Judge0）。

### MCP

- 遠端 MCP 伺服器：Streamable HTTP 與舊版 HTTP+SSE；認證支援無、Bearer、自訂 Header、OAuth 2.1（動態註冊、PKCE、自動更新權杖）。
- 自動同步工具清單，個別工具可啟用／停用並調整風險等級；專案可限定可用的伺服器。

### 排程、用量與其他

- **排程任務**：一次／間隔／每日／每週／cron，支援 IANA 時區與日光節約時間；以租約領取，不會重複執行；需要批准的工具會等待你批准。
- **用量儀表板**：依日期、模型、對話、專案、類型統計 tokens（含快取與推理 tokens）與花費；每日／每月花費上限與 80% 警告，在每次呼叫模型前檢查。
- **密鑰保險庫**：加密保存 API Key 並綁定允許網域，只在 `http_request` 送出時於伺服器端代入，模型看不到真值。
- **PWA**：可安裝到桌面或手機主畫面，離線時顯示應用程式外殼。

## 架構概覽

```
瀏覽器（React SPA，正體中文介面）
  │  ├─ PDF／DOCX 解析、知識庫切塊、Python（Pyodide）都在瀏覽器執行
  │  └─ 檔案以預簽名 URL 直傳 ─────────────────────────────┐
  │                                                         ▼
  ├─ SSE 串流 / 輪詢 ──► /api/*  Hono 應用程式      S3 相容物件儲存
  │                      （Netlify Functions 或       （專案檔、知識庫原檔、
  │                        Cloudflare Pages Functions）  Skills、附件）
  │                        │
  │                        ├─ Agent Loop：組裝上下文 → 呼叫模型 → 權限閘門 → 執行工具 → 寫入 run_steps
  │                        ├─ Neon Postgres + pgvector（資料、向量、全文、記憶、執行紀錄、設定）
  │                        ├─ LLM 供應商（OpenAI 相容／Anthropic Messages／Gemini）
  │                        ├─ 搜尋、Embedding、Rerank、圖片供應商
  │                        └─ 遠端 MCP 伺服器
  │
  └─ 背景工作：Netlify Background Function（15 分鐘）／Cloudflare waitUntil 串接
     排程觸發：Netlify Scheduled Function／Cloudflare cron Worker 或外部 cron 服務
```

**長任務策略**：Serverless 有執行時間上限（Netlify 同步函式 60 秒）。Agent Loop 每段預算約 50 秒，到時把狀態寫入資料庫並送出 `continue` 事件，前端自動發下一段請求接續；背景模式則由背景函式執行並在時間將盡時自我重新觸發。每個模型步驟與工具批次都以租約（lease）保護，不會被兩個請求同時執行。

**設定分工**：只有資料庫、物件儲存與兩把金鑰走環境變數（見 [`.env.example`](.env.example)）；其他所有設定（供應商、模型、MCP、Skills、權限、記憶、排程…）都在網頁介面設定並加密存入資料庫。

## 技術選型

| 層 | 選擇 | 理由 |
|---|---|---|
| 前端 | React + Vite + TypeScript + Tailwind + shadcn/ui | 靜態輸出，兩個平台都能直接託管；Markdown、Mermaid、PDF 解析等大型模組延遲載入 |
| 後端 | Hono | 同一份路由跑在 Netlify Functions 與 Cloudflare Pages Functions |
| LLM 抽象 | **自寫適配層（原生 fetch），不使用 Vercel AI SDK** | 三種協定涵蓋所有供應商：OpenAI Chat Completions／Responses 相容、Anthropic Messages、Gemini generateContent；完整掌握思考簽章（thinking signature、thoughtSignature）的往返、串流事件、重試與金鑰遮蔽，體積小、相依少、Edge 相容 |
| MCP | 自寫原生 fetch 客戶端（不使用官方 SDK） | 體積小、Edge 相容，可跨請求重用 session；Serverless 無法執行 stdio，只支援遠端 MCP |
| 資料庫 | Neon + `@neondatabase/serverless`（HTTP）+ Drizzle ORM | Edge 相容；migration 內嵌於程式，啟動時自動執行 |
| 向量／全文 | pgvector（依維度建立 HNSW 部分索引）＋ Postgres tsvector | 不需額外向量資料庫；中日韓文字在應用程式端切成二字詞，Neon 上不需任何額外擴充 |
| 物件儲存 | `aws4fetch`（SigV4） | 輕量、Edge 相容，支援預簽名直傳與分段上傳 |
| 程式執行 | QuickJS（`quickjs-emscripten`）＋ Pyodide | 伺服器端安全執行 JavaScript（無網路、限時限記憶體）；Python 在瀏覽器執行，不佔伺服器資源 |
| 排程 | 自寫 cron／時區解析器 | 無相依、支援 DST；搭配平台原生排程觸發 |
| 認證 | 單一管理密碼（PBKDF2）＋ JWT HttpOnly Cookie | 單人自用，不做註冊與多人 |
| 加密 | AES-256-GCM（WebCrypto），主金鑰為 `ENCRYPTION_KEY` | API Key、密鑰、MCP 憑證不落明文 |
| 測試 | Vitest + 真實 Postgres 17 + pgvector | 所有供應商 HTTP 以模擬伺服器測試 |

## 介面導覽

- **側邊欄**：新對話、搜尋（含內文片段）、專案（可展開，顯示專案內的對話）、不屬於專案的置頂／最近對話、封存的對話、排程、用量、設定、安裝 App。
- **聊天頁**：模型與推理強度選擇、權限模式選擇（全部權限會顯示醒目警告）、背景模式開關、批准卡片、提問卡片、瀏覽器端 Python 執行卡片、工具卡片、分支切換、匯出、壓縮較早的對話。
- **專案頁**：對話（最新的在上、繼續最近的對話、加入現有對話、移出專案）、設定（指示、預設模型、權限、工具篩選）、檔案、知識庫、Skills、MCP、記憶。
- **設定頁**：供應商、Agent 與權限、知識庫、Skills、MCP、記憶、密鑰、儲存空間、帳號安全、外觀。各項說明見 [docs/configuration.md](docs/configuration.md)。
- **排程頁**：任務清單、立即執行、執行紀錄、觸發器（token 與最近一次觸發）。
- **用量頁**：花費上限、每日圖表、依模型／類型／對話／專案分類。

## 快速開始（本機開發）

需求：Node.js 20 以上（建議 22）、Postgres 16/17 + pgvector、一個 S3 相容 bucket（本機可用 MinIO，或直接用 R2／Neon 的 bucket）。

```bash
git clone <你的儲存庫網址> edgemind && cd edgemind
npm install

# 1. 資料庫：Debian/Ubuntu 可用內附腳本啟動本機 Postgres 17 + pgvector（埠 54329）
sudo apt-get install -y postgresql-17 postgresql-17-pgvector
./scripts/test-db.sh
#   或直接使用 Neon 的連線字串

# 2. 環境變數
cp .env.example .env
#   填入 DATABASE_URL（本機：postgres://postgres@127.0.0.1:54329/postgres）、S3_*、
#   ENCRYPTION_KEY（openssl rand -base64 32）、JWT_SECRET（openssl rand -base64 48）

# 3. 啟動 API（:8787）與前端（Vite，自動代理 /api）
set -a; . ./.env; set +a
npm run dev:api          # 終端機 A
npm run dev              # 終端機 B，開啟 Vite 顯示的網址（預設 http://localhost:5173）
```

第一次開啟會自動建立資料表，接著設定登入密碼（至少 10 個字元），再到 **設定 → 供應商** 新增第一個 LLM 供應商、勾選模型並測試連線，就可以開始聊天。

本機用 MinIO 時，`S3_ENDPOINT` 填 `http://127.0.0.1:9000`、`S3_REGION` 填 `us-east-1`，並先建立 bucket。

常用指令：

```bash
npm test             # 全部測試（需先執行 ./scripts/test-db.sh）
npm run typecheck    # shared + server + web 型別檢查
npm run build        # 嵌入 migration → 建置前端 → 打包兩個平台的 Functions 並煙霧測試
npm run db:generate  # 修改 server/src/db/schema.ts 後產生並嵌入 migration
```

## 部署

- **Netlify（主要）**：見 [docs/deploy-netlify.md](docs/deploy-netlify.md)
- **Cloudflare Pages（次要）**：見 [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md)
- 部署後檢查清單：見 [docs/verification-checklist.md](docs/verification-checklist.md)

> ⚠️ **部署完成後請立即開啟網站設定密碼。** 在設定密碼之前，任何先打開網站的人都能完成首次設定並取得管理權。

## 專案結構

```
web/                 前端 SPA（React + Vite），含 PWA（public/manifest.webmanifest、sw.js）
server/              Hono API
  src/agent/         Agent Loop、權限、上下文組裝
  src/llm/           三種協定的 LLM 適配器（原生 fetch）
  src/tools/         內建工具（搜尋、網頁、檔案、程式執行、HTTP、圖片、子代理…）
  src/rag/           知識庫索引與混合檢索
  src/mcp/           MCP 客戶端與 OAuth
  src/skills/        Skills 儲存、匯入、內建 Skills
  src/memory/        自動記憶與對話壓縮
  src/scheduler/     cron 解析與排程執行
  src/usage/         用量統計與花費上限
  src/platform/      Netlify／Cloudflare／Node 平台適配層
  src/db/            Drizzle schema 與內嵌 migration
  test/              Vitest 測試（真實 Postgres）
shared/              前後端共用型別、供應商目錄、切塊器
netlify/functions/   Netlify 入口：api.ts、agent-background.ts、cron-tick.ts
functions/[[path]].ts  Cloudflare Pages 入口
cron-worker/         Cloudflare 用的排程觸發 Worker（選用）
scripts/             建置、煙霧測試、本機測試資料庫
docs/                部署與設定文件
```

## 安全設計

- 單一管理密碼：PBKDF2-SHA256（100,000 次）；登入狀態為 HttpOnly + SameSite=Strict 的 JWT Cookie，每個 JWT 對應資料庫中的 session，可登出撤銷，變更密碼會讓其他裝置失效。
- CSRF：double-submit token（`X-CSRF-Token` 標頭）＋ Origin 檢查；登入速率限制（同一 IP 15 分鐘內失敗 5 次即暫停）。
- API Key、密鑰、MCP 憑證：AES-256-GCM 加密並以資料列 ID 作為 AAD；API 只回傳遮罩後的預覽。
- `web_fetch`／`http_request`：只允許 http(s)，以 DNS-over-HTTPS 解析並封鎖內網／保留位址，每次重新導向都重新檢查，解析失敗即拒絕。
- 工具輸出視為不受信任內容；危險工具一律經過權限閘門；「全部權限」模式可設步數、Token 與花費上限。
- `http_request` 的密鑰只送往允許網域，回應、錯誤訊息、執行紀錄與稽核紀錄中的密鑰值一律遮蔽。

## 文件

| 文件 | 內容 |
|---|---|
| [docs/deploy-netlify.md](docs/deploy-netlify.md) | Netlify 部署：Neon、物件儲存與 CORS、環境變數、建置設定、背景與排程函式、首次設定 |
| [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md) | Cloudflare Pages 部署：建置設定、wasm 模組、免費方案限制、排程觸發 |
| [docs/configuration.md](docs/configuration.md) | 網頁介面中每一項設定的說明 |
| [docs/verification-checklist.md](docs/verification-checklist.md) | 部署後要逐項確認的檢查清單 |

本專案採用 [MIT 授權條款](LICENSE)。
