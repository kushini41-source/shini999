---
name: post-to-story
description: >
  每天自動把你在 Instagram 和 Facebook 粉絲專頁發的新貼文做成限時動態（限動）並發布。讀取最近的貼文，產生 1080x1920 的限動圖（模糊背景＋貼文圖片＋文案摘要），再透過 Meta Graph API 發到 IG 限動和 FB 粉專限動，同一篇不會重複發。Use this skill whenever the user says "貼文轉限動", "把貼文做成限動", "自動發限動", "post to story", "share post to story", "每日限動", or wants to set up, test, run, restyle or troubleshoot the daily IG/FB post-to-story automation.
---

# 貼文轉限動（post-to-story）

把 IG / FB 粉專的新貼文自動做成限動。這個 skill 附帶：

| 檔案 | 用途 |
|---|---|
| `scripts/post_to_story.py` | 主程式：抓貼文、產生限動圖、發布 |
| `config.json` | 樣式：標籤文字、底部文字、帳號名稱、主色 |
| `state.json` | 已處理的貼文清單（防止重複發），程式會自動更新 |
| `../../../.github/workflows/post-to-story.yml` | GitHub Actions 每天自動執行（台灣時間 21:07） |

## 限制（先跟使用者講清楚）

- **IG 必須是商業或創作者帳號**，並連結到一個 **Facebook 粉絲專頁**。FB 個人檔案的貼文和限動，Meta 都沒有開放 API，這個 skill 做不到。
- API 發的限動是**一張圖**，不能加 IG 內建的「分享貼文」貼紙、連結貼紙、投票、音樂。所以限動上會寫「完整內容請看主頁貼文」，引導大家去主頁。
- 影片貼文會用影片封面圖做限動，不會轉成影片限動。
- IG API 每 24 小時最多發 100 篇（限動也算在內）；本程式預設每次最多 5 則。

## 執行流程

1. 用 `GET /{ig-user-id}/media` 和 `GET /{page-id}/posts` 讀最近 25 篇貼文。
2. 篩出最近 `--hours` 小時內、`state.json` 裡沒有的貼文。
3. 每篇產生一張限動圖。
4. 把圖以「不公開」方式上傳到粉專（`/{page-id}/photos?published=false`），拿到 photo_id 和公開網址。這樣不需要自己架圖床。
5. FB 限動：`POST /{page-id}/photo_stories`（帶 photo_id）。
   IG 限動：`POST /{ig-user-id}/media`（`media_type=STORIES`、`image_url`）→ 等狀態 FINISHED → `media_publish`。
6. 每成功一篇就寫入 `state.json`，所以程式中途當掉、重新執行也不會重複發。

預設 `--targets same`：IG 貼文→IG 限動，FB 貼文→FB 限動。如果使用者在兩邊都發同一篇，維持 `same` 就好；如果只在其中一邊發文、想兩邊都有限動，就改用 `--targets both` 並只讀一個來源（例如 `--sources ig --targets both`）。

## 設定步驟（第一次）

照順序帶使用者做，每一步確認完再進下一步：

1. **確認帳號**：IG 是商業/創作者帳號，而且已連結 FB 粉專。
2. **建立 Meta App**：到 developers.facebook.com → 建立應用程式（類型選「商業」）→ 加入「Instagram Graph API」和「Facebook 登入」產品。
3. **取得權限**：用 Graph API Explorer 選這個 App，勾選
   `pages_show_list`、`pages_read_engagement`、`pages_manage_posts`、`instagram_basic`、`instagram_content_publish`、`business_management`，產生使用者權杖。
4. **換成長效權杖**：
   - `GET /oauth/access_token?grant_type=fb_exchange_token&client_id={app-id}&client_secret={app-secret}&fb_exchange_token={短效權杖}` → 長效使用者權杖
   - `GET /me/accounts`（用長效使用者權杖）→ 找到你的粉專，它的 `access_token` 就是**不會過期的粉專權杖** = `META_PAGE_TOKEN`，`id` = `FB_PAGE_ID`
5. **找 IG 帳號 ID**：`GET /{FB_PAGE_ID}?fields=instagram_business_account` → `id` = `IG_USER_ID`
6. **放進 GitHub Secrets**：repo → Settings → Secrets and variables → Actions → New repository secret，建立 `META_PAGE_TOKEN`、`FB_PAGE_ID`、`IG_USER_ID`。

權杖是秘密，**絕對不要寫進任何檔案或 commit**，也不要貼在對話裡讓 Claude 印出來。

## 測試

先只產生圖片、不發布：

```bash
pip install -r .claude/skills/post-to-story/scripts/requirements.txt

# 不需要 API：用本機圖片看樣式
python .claude/skills/post-to-story/scripts/post_to_story.py --sample 照片.jpg "貼文內容……"
python .claude/skills/post-to-story/scripts/post_to_story.py --sample none "純文字貼文"

# 用真實貼文產生預覽圖（需要環境變數），圖會放在 story_out/
python .claude/skills/post-to-story/scripts/post_to_story.py --dry-run --hours 72
```

在 GitHub 上也可以：Actions → Daily posts to stories → Run workflow → 勾選 dry_run，跑完到該次執行的 Artifacts 下載 `story-preview` 看圖。

確認圖片 OK 後，手動執行一次（不勾 dry_run）確認真的有發上去，之後就交給每天的排程。

## 每天自動執行

`.github/workflows/post-to-story.yml` 每天 UTC 13:07（台灣 21:07）執行，讀最近 26 小時的貼文（多 2 小時緩衝，重複的會被 `state.json` 擋掉），跑完把 `state.json` commit 回 repo。

- **排程只會在預設分支（main）上執行**，要把這個 workflow 合併進 main 才會開始每天跑。
- 改時間：修改 `cron`（是 UTC 時間，台灣時間減 8 小時）。
- 想一天多次：加多行 cron，例如每 6 小時 `"7 */6 * * *"`，並把 `--hours` 改成 8。

## 參數

| 參數 | 預設 | 說明 |
|---|---|---|
| `--sources` | `ig,fb` | 讀哪邊的貼文 |
| `--targets` | `same` | `same` / `both` / `ig` / `fb` |
| `--hours` | `24` | 只處理多少小時內的貼文 |
| `--max` | `5` | 每次最多發幾則 |
| `--dry-run` | 關 | 只產生圖片到 `--out`（預設 `story_out/`） |
| `--config` | `config.json` | 樣式設定 |
| `--sample IMG TEXT` | — | 不連 API，用本機圖片試樣式 |

環境變數：`META_PAGE_TOKEN`、`FB_PAGE_ID`、`IG_USER_ID`、`GRAPH_VERSION`（預設 `v26.0`）、`STORY_FONT`（中文字型路徑）。

## 調整樣式

改 `config.json`：

- `label`：左上角標籤，例如「新貼文」「今日分享」
- `footer`：底部引導文字
- `handle`：底部顯示的帳號，例如 `@your_ig`
- `accent`：主色 RGB，例如 `[255, 196, 0]`

改完先用 `--sample` 產生圖片給使用者看，確認後再 commit。

## 疑難排解

| 錯誤 | 原因 / 解法 |
|---|---|
| `code 190` | 權杖過期或無效 → 重做設定步驟 4，更新 `META_PAGE_TOKEN` |
| `code 10` / `code 200` | 缺權限 → 確認步驟 3 的權限都有勾、App 已上線或你是 App 管理員 |
| `code 100` 在 `photo_stories` | 粉專不支援限動 API 或 photo_id 無效 → 確認是新版粉專體驗、圖片已上傳成功 |
| IG container `ERROR` | 圖片太大或格式不符 → 程式產生的是 1080x1920 PNG，若被自訂改過請改回 |
| 中文變成方塊 | 找不到中文字型 → 安裝 Noto Sans CJK 或設定 `STORY_FONT` |
| 每天都沒發 | workflow 不在 main 分支、或 Secrets 沒設 → 看 Actions 的執行紀錄 |

Meta 的 API 常常改版。如果錯誤訊息和上面不符，先查 Meta 官方文件（Instagram Content Publishing、Page Stories API）再修程式，不要猜。
