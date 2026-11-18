# 變更紀錄

## 未發布

- **聊天斷流（Netlify）**：模型一次回覆被 60 秒上限切斷時，不再丟棄後整步重做（長回覆會無限重來），改為自動轉背景模式完成；剩餘時間不足 30 秒時不開始新的模型步驟，改到新的一段；分段計時從請求開始算，Netlify 改為 40 秒／50 秒，留時間寫入步驟紀錄並送出 `continue`。前端收到 `continue` 時清掉中斷步驟的半截文字（不再重複顯示）；串流異常結束後自動接續（最多 3 次）才顯示「繼續執行」。
- **排程不再空轉喚醒 Neon**：「下一個到期時間」與排程 token 的 HMAC 另存在物件儲存（`system/scheduler-hint.json`），沒有到期任務的 tick 直接從 S3 回覆，不跑 migration、不查資料庫；只有任務到期、提示遺失或超過 6 小時未更新時才連線 Neon。錯誤 token 也不再喚醒資料庫。排程頁「最近一次觸發」包含閒置 tick。
- **專案對話**：側邊欄點專案會接續該專案最近的對話（沒有對話時開啟專案頁），專案可展開顯示自己的對話（最新的在上）；「最近對話」只列不屬於專案的對話；對話選單新增「移到專案…」與「移出專案」，專案頁新增「繼續最近的對話」、「加入現有對話」與每列的「移出專案」；在專案中開新對話時列出可繼續的專案對話。`GET /api/conversations` 的 `projectId` 不是專案 ID 或 `none` 時回 400（以前會默默列出全部）。
- **密鑰**：名稱與介面使用同一套整理規則（全形、零寬字元、前後空白），不合法的名稱說明是哪個字元；儲存失敗的訊息顯示在對話框中且對話框不會被點外面關掉；清單載入失敗顯示原因與「重試」；儲存後確認清單中確實有它。`http_request` 找不到密鑰時說明是「完全沒有密鑰」還是名稱不符（列出現有名稱與相近名稱）；回應內容為空時加上說明，工具卡片的空結果顯示「（工具沒有回傳任何內容）」。所有 `/api` 回應加上 `Cache-Control: no-store`。
- 開發／測試：`DEV_DB_DRIVER=neon` 讓本機 API 使用正式環境的 Neon HTTP 驅動（搭配 `e2e/support/neon-http-proxy.mjs`），`E2E_DB=neon` 讓 E2E 走同一條路。

## 0.1.0（2026-11-15）

第一個完整版本。

- **第一期**：單人登入（PBKDF2、JWT Cookie、CSRF、速率限制）；供應商設定（LLM／搜尋／Embedding／Rerank／圖片，模型清單與連線測試）；自寫 LLM 適配層（OpenAI 相容 Chat Completions／Responses、Anthropic Messages、Gemini）；Agent Loop（分段續跑、背景模式、權限閘門與五種權限模式、稽核紀錄）；聊天介面（串流 Markdown、分支、重新生成、匯出）；專案與檔案（瀏覽器直傳 S3、分段上傳、版本）；內建工具 web_search、web_fetch、file_*、memory_*、todo、ask_user。
- **第二期**：知識庫 RAG（瀏覽器端解析與切塊、pgvector + 中日韓全文混合檢索、Rerank、背景重建索引）；Skills（zip、線上編輯、GitHub 匯入）；MCP 客戶端（Streamable HTTP、SSE、OAuth 2.1）；自動記憶與對話壓縮。
- **第三期**：code_run（伺服器端 QuickJS JavaScript、瀏覽器端 Pyodide Python）；密鑰保險庫與 http_request；內建 Skills e2b-sandbox、self-hosted-runner；image_generate；subagent；排程任務；用量儀表板與花費上限；PWA。
- **發布準備**：選填環境變數 `S3_FORCE_PATH_STYLE`（支援只接受虛擬主機式網址的服務）；Cloudflare `_routes.json`（只有 `/api/*` 進入 Functions）；`.nvmrc`（Node 22）；部署、設定與部署後檢查文件。
