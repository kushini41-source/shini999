# 交接摘要（2026-10-31）

使用者：ku.shini41@gmail.com，主要用 Windows（電腦名稱 DESKTOP-3EA3GBG）與 Google Chrome，偏好繁體中文（台灣用語）回覆，不是工程師背景，解釋要白話。

## 1. 網頁翻譯擴充功能（已完成、已推送）

- 位置：repo `kushini41-source/shini999`，分支 `claude/beautiful-bohr-pho4sl`，資料夾 `web-translator/`。
- 安裝包：`web-translator/精準網頁翻譯-extension.zip`；載入方式為 Chrome「載入未封裝項目」選 `web-translator/extension/`。
- 目的：取代 Chrome 內建機翻。Manifest V3，content script 以行內 run 為單元、用 `<gN>…</gN>` / `<xN/>` 標記保留排版；支援取代原文／雙語對照、延遲翻譯、動態內容、Shadow DOM、iframe、快取、自動翻譯網站／語言、詞彙表。
- 預設：供應商 Anthropic，模型 `claude-sonnet-5-5`（約新台幣 1.2 元／頁），effort low，來源語言英／日／韓全開，目標 zh-TW，取代原文模式，只翻看得到的區域。也支援 OpenAI 相容端點（含本機 Ollama／LM Studio）與 DeepL。
- 測試：`cd web-translator && npm test`（單元測試 + 在 Chromium 載入真擴充功能的端對端測試，API 指向本機假伺服器），目前全部通過。
- 尚未用真實 API key 驗證翻譯品質；使用者還沒回報實際使用結果。
- 使用者沒有 API key 時無法翻譯；曾詢問是否內建模型，已說明必須外接 API。

## 2. 遠端桌面

- 使用者之前（另一個對話）請 Claude 自製遠端連線軟體，效果比 Chrome 遠端桌面差。已說明自製難以達到 Parsec 等級，建議改用現成開源軟體。
- 使用者決定試 **Moonlight + Sunshine**（兩台互連，所以每台都要裝兩個）。
- 已給的安裝指令（系統管理員 PowerShell）：
  `winget install --id LizardByte.Sunshine -e` 與 `winget install --id MoonlightGameStreamingProject.Moonlight -e`
  手動下載：https://github.com/LizardByte/Sunshine/releases （MSI）、https://github.com/moonlight-stream/moonlight-qt/releases 。
- 設定重點：Sunshine 設定頁 `https://localhost:47990`，設帳密、語言改正體中文；Moonlight 配對 PIN；跨網路建議兩邊裝 Tailscale，否則需轉發 TCP 47984/47989/47990/48010、UDP 47998-48000/48002/48010；無螢幕主機需 HDMI 假負載。
- 使用者要求「幫我裝」，但雲端工作階段無法遠端控制 Windows 電腦（Remote Control 清單裡的三個資料夾都標示不可用），所以只能給指令請使用者自己執行。下一步：等使用者回報安裝結果或截圖。

## 3. Parsec 中文化

- 結論：Parsec 無官方中文，翻譯擴充功能只能翻網頁版 web.parsec.app，不建議改程式檔。使用者後來轉向 Moonlight + Sunshine。
