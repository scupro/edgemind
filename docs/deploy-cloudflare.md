# 部署到 Cloudflare Pages（次要平台）

同一份程式也能部署到 Cloudflare Pages：前端是 Pages 靜態網站，API 由 `functions/[[path]].ts` 掛載與 Netlify 相同的 Hono 應用程式。資料庫與物件儲存的準備方式和 Netlify 相同。

> **先看限制再決定**：Cloudflare **免費方案**每次請求只有 **10 ms CPU 時間**與 **50 個子請求（subrequest）**。EdgeMind 的資料庫走 Neon HTTP 驅動，每一次查詢都是一個子請求；一段較長的 Agent 執行很容易超過 50 個。免費方案適合試用與輕量聊天；要穩定使用 Agent、`code_run` JavaScript、`web_fetch` 等功能，請使用 **Workers Paid（每月 5 美元起，CPU 預設 30 秒、子請求 10,000 個）** 或改用 Netlify。詳見下方「免費方案限制」。

## 1. 準備資料庫、物件儲存與金鑰

與 Netlify 完全相同，請依照 [deploy-netlify.md](deploy-netlify.md) 的：

- 第 1 節：建立 Neon Postgres（pgvector 會在第一次啟動時自動啟用）
- 第 2 節：建立 bucket（Neon Object Storage、R2、B2…）與 CORS；CORS 的允許來源改成你的 Pages 網址（例如 `https://edgemind.pages.dev`）
- 第 3 節：產生 `ENCRYPTION_KEY` 與 `JWT_SECRET`

使用 Cloudflare R2 時，端點同樣是 `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`（EdgeMind 透過 S3 API 存取 R2，不使用 R2 綁定）。

## 2. 建立 Pages 專案（Git 整合）

1. Cloudflare 主控台 → **Workers & Pages → Create → Pages → Connect to Git**，選擇 EdgeMind 儲存庫。
2. 建置設定：

   | 欄位 | 值 |
   |---|---|
   | Framework preset | None |
   | Build command | `npm run build` |
   | Build output directory | `web/dist` |
   | Root directory | （留空，儲存庫根目錄） |

   - Node 版本：儲存庫根目錄的 `.nvmrc` 指定 Node 22，Pages 建置環境會自動採用。
   - `functions/` 資料夾位於儲存庫根目錄，Pages 會自動把它編譯成 Functions。
   - `web/public/_routes.json` 只把 `/api/*` 交給 Functions；其他路徑（前端、靜態檔）直接由 Pages 提供，不計入 Functions 的請求數與 CPU。
3. 儲存庫中的 `wrangler.toml` 含有 `pages_build_output_dir`，Pages 會把它當成專案設定的**唯一來源**。因此：
   - 一般（純文字）環境變數無法在主控台新增；**請把所有變數都設成 Secret（加密）**。
   - 相容日期（`compatibility_date`）與 Workers AI 綁定等設定請改 `wrangler.toml`，不要在主控台改。

## 3. 設定環境變數（Secrets）

到 Pages 專案 **Settings → Variables and Secrets**，在 **Production**（需要預覽部署也能用時，Preview 也要設）新增下列 **Secret**：

| 名稱 | 說明 |
|---|---|
| `DATABASE_URL` | Neon 連線字串 |
| `S3_ENDPOINT` | 物件儲存端點（不含 bucket） |
| `S3_REGION` | `auto`、`us-east-2`… |
| `S3_BUCKET` | bucket 名稱 |
| `S3_ACCESS_KEY_ID` | 存取金鑰 ID |
| `S3_SECRET_ACCESS_KEY` | 存取金鑰密碼 |
| `S3_FORCE_PATH_STYLE` | 選填，預設 `true` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `JWT_SECRET` | `openssl rand -base64 48` |

也可以用 Wrangler 設定：

```bash
npx wrangler pages secret put DATABASE_URL --project-name edgemind
npx wrangler pages secret put ENCRYPTION_KEY --project-name edgemind
# …其餘變數相同
```

設定完成後重新部署一次（**Deployments → ⋯ → Retry deployment**），變數才會生效。

## 4. 相容性旗標與 wasm 模組

- **不需要 `nodejs_compat`**：Cloudflare 版的 bundle 以 workerd 條件打包，並且禁止引用任何 Node 內建模組（建置時會檢查）。加上這個旗標也無害，但沒有必要。
- `compatibility_date` 設在 `wrangler.toml`（目前為 `2026-11-01`）。
- **QuickJS wasm**：`code_run` 的 JavaScript 沙盒使用 QuickJS（WebAssembly）。workerd 不允許在執行期間編譯 wasm 位元組，所以 `functions/[[path]].ts` 以模組方式匯入：
  ```ts
  import quickjsWasm from "../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";
  ```
  Pages 的 Functions 打包器（Wrangler）會把 `.wasm` 匯入轉成 `WebAssembly.Module`。這個路徑假設 npm workspaces 把套件安裝在儲存庫根目錄的 `node_modules/`（預設行為）；若改用其他套件管理工具導致路徑不同，請相應修改這一行。
- 打包大小：Functions 約 1.2 MiB（壓縮前）＋ QuickJS wasm 約 0.5 MiB，gzip 後合計約 0.6 MiB，遠低於 Workers 的大小上限。

## 5. 選用：Workers AI 綁定

取消 `wrangler.toml` 中這兩行的註解後重新部署：

```toml
[ai]
binding = "AI"
```

之後在 **設定 → 供應商** 新增「Cloudflare Workers AI」Embedding 供應商時可以不填 API Token，直接透過綁定呼叫（填了 Token 時預設走 REST API；設定 `useBinding=true` 可強制走綁定）。圖片生成的 Workers AI 供應商在有綁定時也會改走綁定（供應商表單仍要求填 Account ID 與 Token，部署到 Netlify 時則一律走 REST API）。

## 6. 立即設定登入密碼（重要）

> ⚠️ **部署完成後請馬上開啟網站。** 在設定密碼之前，任何先打開網站的人都能完成首次設定並取得完整管理權。

開啟 `https://你的專案.pages.dev` → 自動建立資料表 → 設定至少 10 個字元的密碼。之後的第一次設定（新增 LLM 供應商、勾選模型、選預設模型）與 Netlify 相同，見 [deploy-netlify.md 第 6 節](deploy-netlify.md#6-第一次設定)。忘記密碼的處理方式也相同。

## 7. 排程任務的觸發

Pages Functions 不支援 cron trigger，需要外部定時呼叫 `POST https://你的網域/api/cron/tick`，並帶上 `Authorization: Bearer <token>`。

**先產生 token**：EdgeMind 側邊欄 → **排程** → 觸發器卡片 → 產生 token（加密存在資料庫，可隨時重新產生，舊 token 立即失效）。

### 方法一：獨立的 Cloudflare Worker（推薦，免費方案可用）

儲存庫中的 `cron-worker/` 是一個只有幾行的 Worker，每 15 分鐘呼叫一次：

```bash
cd cron-worker
# 編輯 wrangler.toml 的 EDGEMIND_URL，改成你的 Pages 網址
npx wrangler deploy
npx wrangler secret put CRON_TOKEN    # 貼上「排程」頁產生的 token
```

部署後「排程」頁的「最近一次觸發」會顯示 `cloudflare-worker`。免費方案每個帳號可設定 5 個 cron trigger。直接瀏覽這個 Worker 的網址不會觸發排程，只會回報設定是否完整。

### 方法二：外部免費排程服務（例如 cron-job.org）

建立一個每 5–15 分鐘執行一次的工作：

- URL：`https://你的網域/api/cron/tick`
- Method：`POST`
- Header：`Authorization: Bearer <token>`

### 注意

- 沒有到期任務的檢查只讀物件儲存裡的提示檔（`system/scheduler-hint.json`），不會喚醒 Neon；只有任務到期或提示超過 6 小時未更新時才連線資料庫。任務最多會晚一個檢查週期執行。
- 多個觸發來源同時存在也不會重複執行：每個到期任務都以租約領取。
- 停擺期間錯過的時段不會補跑，只會執行一次，下次時間從當下重新計算。

## 8. Cloudflare 上的執行方式

- **聊天串流**：用戶端保持連線期間沒有牆鐘時間上限；EdgeMind 仍以約 50 秒為一段，到時自動續跑。
- **背景模式**：Function 回應 202 後，在 `waitUntil` 中自我呼叫內部 drive 端點，每段約 20 秒（上限 27 秒，`waitUntil` 在回應後大約只能再延續 30 秒），一段接一段串接直到完成。知識庫背景重建索引也以同樣方式串接。
- **自動記憶萃取**在回應後以 `waitUntil` 執行。

## 免費方案限制

| 限制 | Workers Free | Workers Paid | 對 EdgeMind 的影響 |
|---|---|---|---|
| CPU 時間／請求 | 10 ms | 預設 30 秒（可調至 5 分鐘） | 等待網路 I/O 不計入，但 JSON／SSE 解析、Markdown 轉換、加解密、wasm 都算 |
| 子請求／請求 | 50 | 10,000 | 每次資料庫查詢、每次呼叫模型、搜尋、S3 都算一個 |
| 請求數 | 每天 100,000（帳號共用） | 每月 1,000 萬內含 | 有 `_routes.json` 後只有 `/api/*` 計入 |

在免費方案上**預期會失敗或被中斷**的工作：

- **`code_run`（JavaScript）**：載入 QuickJS wasm 與直譯程式碼都消耗 CPU，除了極小的腳本之外幾乎一定超過 10 ms。請改用 Netlify、Workers Paid，或用 `e2b-sandbox`／`self-hosted-runner` Skill 把程式交給外部沙盒執行。Python 在瀏覽器執行，不受影響。
- **`web_fetch`**：HTML 解析與 Readability 轉 Markdown 屬於 CPU 密集工作，大型網頁可能超時。
- **多步驟 Agent 執行**：每一步都會寫入資料庫，加上心跳與工具呼叫，一段執行可能超過 50 個子請求而被中斷（錯誤類似「Too many subrequests」）。
- **知識庫向量化**：批次越大越可能超時（PDF／DOCX 解析在瀏覽器進行，不受影響）。

被中斷的執行狀態都已寫入資料庫，可以從聊天頁的續跑提示接續，但頻繁中斷代表需要升級方案或改用 Netlify。

## 另一種部署方式：Wrangler CLI

不想用 Git 整合時，可以在本機建置後直接上傳：

```bash
npm ci
npm run build
npx wrangler pages project create edgemind   # 第一次
npx wrangler pages deploy                    # 讀取 wrangler.toml 的 pages_build_output_dir
```

`wrangler pages deploy` 會一併編譯根目錄的 `functions/`。Secrets 的設定方式同第 3 節。

## 疑難排解

| 症狀 | 可能原因 |
|---|---|
| 網站顯示「環境變數」錯誤頁 | 變數沒有設成 Secret，或設定後沒有重新部署；Preview 部署需在 Preview 環境另外設定 |
| 部署時 Functions 編譯失敗、找不到 `.wasm` | `node_modules` 的位置與 `functions/[[path]].ts` 中的路徑不符（見第 4 節） |
| 錯誤 1102（Worker exceeded resource limits） | 超過 10 ms CPU（免費方案）；見「免費方案限制」 |
| Too many subrequests | 超過 50 個子請求（免費方案）；升級 Workers Paid |
| 背景模式沒有進度 | 自我呼叫被擋（例如網站前面有 Cloudflare Access 等驗證）；查看 Functions 的即時記錄 |
| 排程沒有執行 | cron Worker 的 `EDGEMIND_URL`／`CRON_TOKEN` 錯誤，或 token 已重新產生；「排程」頁的「最近一次觸發」是否有更新 |
