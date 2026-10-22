# 精準網頁翻譯（LLM）— Chrome 擴充功能

用 Claude 等大型語言模型取代 Chrome／Edge 內建的網頁翻譯。內建翻譯用的是小型機翻模型，常翻得生硬、不準，有些頁面還直接拒絕翻譯；這個擴充功能把頁面文字交給 LLM，翻完後放回原本的版面位置，連結、粗體、圖示、程式碼都保留。

目前以 **英文 → 繁體中文（台灣用語）** 為主，日文、韓文可在設定中勾選加入。

## 功能

- **一鍵翻譯／還原**：工具列按鈕、右鍵選單，或快捷鍵 `Alt+T`。
- **保留排版**：以段落為單位翻譯，段落內的連結、粗體、斜體、`code`、圖片、換行以標記方式送給模型，譯文回來後放回原位。模型若漏掉某個標記，對應的元素會自動補回，不會消失。
- **兩種顯示方式**：取代原文（像內建翻譯），或雙語對照（原文下方顯示譯文；此模式完全不動原本的 DOM，對 React 等 SPA 最安全）。
- **幾乎所有頁面都能翻**：忽略網站設定的 `notranslate` 中繼標籤、支援 iframe（每個 frame 各自翻）、open Shadow DOM、動態載入的內容（無限捲動、SPA 切頁）。尊重作者標記為 `translate="no"` 或 `.notranslate` 的元素，不翻 `<pre>`、`<code>`、表單欄位與可編輯區域。
- **省錢**：預設只翻看得到的區域（捲動到哪翻到哪，含前後一個畫面）；相同文字快取在本機，重新整理或再次造訪不重複付費；已是中文、純數字、純網址的段落不送出。
- **自動翻譯**：可設定「永遠翻譯這個網站」或「偵測到英文／日文／韓文網頁就自動翻譯」。
- **品質控制**：詞彙表（固定術語譯法）、額外指示（語氣、領域），系統提示詞已要求台灣用語與全形標點。
- **多種後端**：
  - Anthropic Claude（預設 `claude-opus-5-5`，可改 Sonnet／Haiku；使用結構化輸出確保回傳格式，並啟用伺服器端備援）
  - 任何 OpenAI 相容端點：OpenAI、Gemini、DeepSeek、OpenRouter、Groq，或本機免費的 Ollama／LM Studio
  - DeepL API（免費方案每月 50 萬字元）

## 安裝（Chrome／Edge／Brave）

1. 下載這個資料夾（或整個 repo）。只需要 `web-translator/extension/` 這個目錄。
2. 開啟 `chrome://extensions/`（Edge 為 `edge://extensions/`），打開右上角「開發人員模式」。
3. 按「載入未封裝項目」，選擇 `web-translator/extension/` 目錄。
4. 第一次安裝會自動打開設定頁，填入 API key 後按「測試連線」，成功後按「儲存設定」。
5. 建議把擴充功能圖示釘選到工具列。

> 更新程式碼後，到 `chrome://extensions/` 按該擴充功能的「重新載入」，已開啟的分頁需要重新整理。

## 取得 API key

| 供應商 | 哪裡拿 | 費用 |
| --- | --- | --- |
| Anthropic Claude | https://console.anthropic.com/ → API Keys | 按用量計費。一般文章頁面約數千 token，用 Opus 5.5 約新台幣 0.3–1 元／頁；Haiku 5.5 便宜約 40 倍。 |
| OpenAI 相容 | 各家平台自行申請；本機 Ollama／LM Studio 免費 | 視平台 |
| DeepL | https://www.deepl.com/pro-api | 免費方案每月 50 萬字元 |

金鑰只存在瀏覽器的擴充功能儲存空間（會隨 Chrome 帳號同步），直接呼叫供應商的 API，不經過任何第三方伺服器。

## 使用

- 點工具列圖示 → 「翻譯此頁」；再點一次「顯示原文」即可還原。
- 彈出視窗可以切換「取代原文／雙語對照」、勾選「總是翻譯此網站」、「總是翻譯英文網頁」。
- 右下角會顯示翻譯進度；若失敗會顯示原因，點一下可開啟設定頁。
- 設定頁的「進階」可以調整每批字數、同時請求數，以及清除快取。

## 已知限制

- Chrome 不允許任何擴充功能存取 `chrome://` 頁面、Chrome 線上應用程式商店，以及內建 PDF 檢視器，這些頁面無法翻譯（內建翻譯也一樣）。
- 要翻譯本機 `file://` 檔案，需在 `chrome://extensions/` 的擴充功能詳細資料中開啟「允許存取檔案網址」。
- 關閉的 Shadow DOM（closed shadow root）無法存取。
- 目前只翻譯頁面文字，不翻譯 `title`／`alt`／`placeholder` 屬性和分頁標題。
- 「取代原文」模式會改動 DOM；少數 React／Vue 頁面重新渲染時可能閃回原文（會自動從快取補翻），若遇到問題請改用「雙語對照」。
- 模型回應需要時間，第一批文字出現大約需要 1–4 秒（取決於模型與批次大小）；Haiku 最快。

## 程式結構

```
web-translator/
├── extension/            ← 載入到 Chrome 的目錄
│   ├── manifest.json     Manifest V3
│   ├── background.js     service worker：設定、呼叫 API、快取、併發、語言偵測、右鍵選單、快捷鍵
│   ├── content.js        內容腳本：切段、序列化／還原、延遲翻譯、動態內容、Shadow DOM、進度提示
│   ├── popup.html/js     工具列彈出視窗
│   ├── options.html/js   設定頁
│   └── icons/
├── test/
│   ├── fixture.html      測試頁面
│   ├── run.mjs           內容腳本單元測試（假翻譯器，不花 API 費用）
│   ├── e2e.mjs           在 Chromium 載入真正的擴充功能，API 指向本機假伺服器
│   └── make-icons.mjs    產生圖示
└── README.md
```

### 翻譯單元與標記格式

內容腳本把「同一父節點下連續的行內節點」視為一個翻譯單元，序列化成類似 XLIFF 的格式送給模型：

```
This is a <g0>link</g0>, some <g1>bold</g1>, inline <x2/> and an image <x3/>.
```

`<gN>…</gN>` 代表可翻譯的行內元素（連結、粗體等），`<xN/>` 代表不翻譯的佔位元素（程式碼、圖片、換行）。譯文回來後解析這些標記，把原本的 DOM 元素放回對應位置，所以連結的 `href`、事件監聽器都保留；還原時用快照精確復原。

## 開發與測試

```bash
cd web-translator
npm install          # 安裝 playwright（或 ln -s 到全域安裝）
npm test             # 內容腳本測試 + 端對端測試
```

端對端測試會在 Chromium 裡載入真正的擴充功能，API 請求導向本機假伺服器，驗證請求格式（標頭、`output_config`、詞彙表）、快取、徽章、設定頁與彈出視窗。
