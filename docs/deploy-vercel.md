# 部署到 Vercel

EdgeMind 可以部署到 Vercel，**不使用 Vercel AI SDK，也不使用 Vercel AI Gateway**：模型金鑰照常在 UI 設定、加密存在 Neon，由伺服器端自寫的 fetch 適配層直接呼叫各家供應商。

建置採用 Build Output API v3：`scripts/build-vercel.mjs` 把網頁輸出到 `.vercel/output/static`，並用 esbuild 把 `vercel/api.ts` 打包成單一 Node.js 函式（處理 `/api/*`，支援 SSE 串流）。

## 步驟

1. 在 Vercel 匯入此 GitHub repo。`vercel.json` 已指定 `npm ci` 與 `npm run build:vercel`，Framework Preset 選 **Other**，其餘欄位留空。
2. 確認專案 **Settings → Functions → Fluid compute** 為開啟（新專案預設開啟）。
3. 在 **Settings → Environment Variables** 設定與 Netlify 相同的變數：
   `DATABASE_URL`、`S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、（選用）`S3_FORCE_PATH_STYLE`、`ENCRYPTION_KEY`、`JWT_SECRET`。
4. 部署完成後**立刻**開啟網站設定擁有者密碼。
5. 依 [verification-checklist.md](verification-checklist.md) 檢查。

## 選用的建置期變數

| 變數 | 說明 |
|---|---|
| `EDGEMIND_MAX_DURATION` | 函式 maxDuration（秒），預設 `300`（Hobby＋Fluid compute 上限）。Pro 方案可調高；每段串流與背景執行會自動預留 30–60 秒餘裕。 |
| `EDGEMIND_FUNCTION_REGION` | 例如 `sin1`、`hnd1`、`iad1`。把函式放在 Neon 資料庫附近可大幅降低延遲。 |
| `VERCEL_CRON_SCHEDULE` | 例如 `*/15 * * * *`。設定後加入 Vercel Cron（呼叫 `/api/cron/vercel`），並需同時設定 `CRON_SECRET`。 |

## 背景模式

Vercel 沒有 Netlify 的 15 分鐘 Background Function。EdgeMind 改用與 Cloudflare 相同的串接方式：對已簽章的 `/api/internal/runs/:id/drive` 發出自我請求，該請求立即回 202，在 `waitUntil` 中執行一段（預設約 4 分鐘），未完成就串接下一段，直到任務結束。

**Preview 部署**若開啟了 Deployment Protection，自我請求會被擋下：到 **Settings → Deployment Protection** 開啟 *Protection Bypass for Automation*，Vercel 會自動提供 `VERCEL_AUTOMATION_BYPASS_SECRET`，EdgeMind 會帶在自我請求的標頭上。Production 網域不受影響。

## 排程任務

Vercel Cron 在 Hobby 方案每天只能執行一次，不夠用。建議沿用外部觸發（見 [`cron-worker/README.md`](../cron-worker/README.md)）：

- `cron-worker/` 的 Cloudflare Worker（免費），或 cron-job.org，
- 每 5–15 分鐘 `POST https://你的網域/api/cron/tick`，標頭 `Authorization: Bearer <排程頁的 token>`。

Pro 方案可改用 Vercel Cron：設定 `CRON_SECRET`（任意長隨機字串）與 `VERCEL_CRON_SCHEDULE`，重新部署即可；排程頁的「最近一次觸發」會顯示 `vercel-cron`。

## 本機驗證

```bash
npm run build:vercel   # 產生 .vercel/output 並做冒煙測試
npx vercel deploy --prebuilt   # 選用：直接上傳本機建置結果
```
