# Buffer 繁體中文化（Chrome 擴充功能）

讓 Buffer（publish.buffer.com 等所有 buffer.com 頁面）直接以繁體中文顯示，包含按鈕、說明文字、提示框與彈出選單。翻譯來自人工整理的字典，不經過 Google 翻譯，專有名詞（佇列、頻道、起始頁、點子…）全站一致。

## 安裝

1. 下載這個資料夾 `buffer-zh-tw`（GitHub 上按 Code → Download ZIP，解壓縮）。
2. Chrome 網址列輸入 `chrome://extensions`，打開右上角「開發人員模式」。
3. 按「載入未封裝項目」，選擇 `buffer-zh-tw` 資料夾。
4. 重新整理 Buffer 頁面即可。

## 遇到沒翻到的英文

點 Chrome 工具列上的擴充功能圖示，「尚未翻譯的文字」會列出你在 Buffer 看到但字典沒有的字串，直接在旁邊填中文按「存」，頁面立即套用。

## 換電腦

你自己填的翻譯存在 Chrome 同步空間（`chrome.storage.sync`）。另一台電腦只要用同一個 Google 帳號登入 Chrome 並開啟同步、安裝本擴充功能，自訂翻譯就會自動出現。也可以用「匯出 JSON / 匯入 JSON」手動備份。

## 說明

- 只翻譯介面文字；你自己寫的貼文內容、輸入框、編輯區不會被改動。
- 內建字典在 `dict.js`，句型規則（如「3 posts → 3 則貼文」）在同檔的 `BUFFER_ZH_PATTERNS`。
