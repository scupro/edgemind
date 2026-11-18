# EdgeMind 排程觸發器（Cloudflare Pages 用）

Netlify 部署不需要這個資料夾（`netlify/functions/cron-tick.ts` 是內建的排程函式，每 15 分鐘觸發一次）。

Cloudflare Pages Functions 不支援 cron trigger，所以排程任務需要外部定時呼叫 `POST https://你的網域/api/cron/tick`，
並帶上 `Authorization: Bearer <token>`。token 在 EdgeMind 的「排程」頁面產生（加密存在資料庫，可隨時重新產生）。

## 方法一：獨立的 Cloudflare Worker（推薦，免費方案即可）

```bash
cd cron-worker
# 編輯 wrangler.toml 的 EDGEMIND_URL
npx wrangler deploy
npx wrangler secret put CRON_TOKEN   # 貼上「排程」頁的 token
```

部署後「排程」頁的「最近一次觸發」會顯示 `cloudflare-worker`。

## 方法二：外部免費排程服務（例如 cron-job.org）

建立一個每 5–15 分鐘執行的工作：
- URL：`https://你的網域/api/cron/tick`
- Method：POST
- Header：`Authorization: Bearer <token>`

## 注意

- 沒有到期任務的檢查只讀物件儲存裡的提示檔，不會喚醒 Neon；只有任務到期（或提示超過 6 小時未更新）時才連線資料庫，所以檢查頻率可以放心調高，任務最多晚一個檢查週期執行。
- 同一時間有多個觸發來源也不會重複執行：每個到期任務都以租約（lease）領取。
- 錯過的時段不會補跑：排程器停擺期間到期的任務只會執行一次，下次時間從當下重新計算。
