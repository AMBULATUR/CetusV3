# Cetus 現代化 — Stage 4 module migration 接續執行

接續 Spectra change `modernize-chrome-extension-mv3` 的 task 5.5（與 5.6 Stage 4 收斂）。

---

## 0. 新 session 開機第一步（不可跳過）

> 本節為 2026-05-17 補入：上一個 session 沒有先做 MCP baseline 就動 code 的紀錄，這裡固化開機流程。

### 0.1 批准 project MCP server `cetus-chrome`

`.mcp.json` 已配置 `cetus-chrome` server（用 `--load-extension=/Users/phoenix/dev/ctf-tools/Cetus/dist`
啟動 Chrome 並載入 Cetus）。新 session 啟動時，Claude Code 會詢問是否批准這個 project MCP
server，**必須按 yes**，否則無法做 Chrome 載入驗證。

驗證 MCP 工具就緒：

```
ToolSearch query="+cetus chrome"  # 應該列出 mcp__cetus-chrome__* 系列
```

若仍只看到 `mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`（plugin MCP，**沒**載 Cetus），
代表 project MCP 沒批准成功，**暫停**並回報使用者，不得改 fallback。

### 0.2 確認 `dist/` 是最新的

```bash
ls dist/manifest.json                              # 應存在
jq '.manifest_version' dist/manifest.json          # 應為 3
jq -r '.version' dist/manifest.json                # 應為 2.0.0
```

若 `dist/` 不存在或是舊的，先跑 `npm run build`。

### 0.3 跑自動驗證 baseline

```bash
npx tsc --noEmit                                   # 應 0 errors
npm test                                           # 應 51 tests pass（8 個測試檔）
npm run build                                      # 應成功（會有 prism / view.js 不能 bundle 警告，這是 task 5.5 要解決的）
git status --short                                 # 與上一個 session 的 hand-off 一致
spectra status --change modernize-chrome-extension-mv3 --json
```

任何一條爆掉，**暫停**回報使用者，不要在不一致狀態下動 task 5.5。

### 0.4 跑 MCP baseline（依下方 Step 1 的指令逐條跑）

跑完把 console error 列表寫進 `docs/progress.md` 暫存區（建一個「Stage 4 / task 5.5 baseline」
小節）。這是後面對比的依據。

### 0.5 開工順序

baseline 都記錄完才開始 Step 2（HTML 搬進 src/）。每改一段就立刻用 `mcp__cetus-chrome__*`
驗證；不要囤積多檔改動才測。

---

## 現況交接（請先 sanity check）

**Progress**：25/43 tasks done。Task 5.4（`#26`）上一個 session 剛標完，下一個 pending 是
task 5.5（`#27`）→ Stage 4 module migration。

**Working tree**：有未 commit 的工作（前 agent 加上一次 session 的 retrofit）。git status 含：

- `scripts/retrofit-types.mjs`（型別 retrofit 腳本，已用過、可保留）
- `src/types/globals.d.ts`（v1.05 ambient declarations）
- `src/shared/{format,memory,bigint-json}.ts`（task 5.1–5.3 產物）
- `tests/{format,memory,bigint-json,instance-data,storage,messages,background-hydration,instance-restore}.test.ts`
- 多個 `src/{background,content,popup,devtools,options}/*.ts` 已被部分 retrofit
- `src/background/background.ts` 已被刪除
- `openspec/changes/modernize-chrome-extension-mv3/tasks.md` 的 task 5.4 描述已更新
  （明文記錄 6 個檔保留 `@ts-nocheck`）

**基本驗證**（開工前先跑）：

```bash
npx tsc --noEmit          # 應 0 errors
npm run build             # 應成功
npm test                  # 應通過 51 tests（8 個測試檔）
git status --short        # 看上面列的那些檔
spectra status --change modernize-chrome-extension-mv3 --json
```

任何驗證爆掉，先暫停回報。不要在不一致的狀態下動 task 5.5。

---

## 任務本體 — Task 5.5 完整 module migration

### 為什麼這 task 比表面複雜（必讀）

擴充套件「實際執行」的是 `extension/*.js`，**不是** `src/*.ts`。

前 agent 把 `.js` 複製成 `.ts` 補上 `: any`，但**沒有重構為 ES modules**。
`manifest.json` 仍指向 `extension/popupview.html`，那個 HTML 用 classic
`<script src="...">` 載入 legacy `.js`，靠 global scope 共享變數
（`cetusInstances`、`extension`、`WailParser` 等）。

要刪 legacy `.js` 不破壞功能，必須先：

1. 把 HTML 搬進 `src/` 並改用 `<script type="module">`
2. 每個 TS 檔加 globalThis 橋接（module scope 不再共享 global，但 v1.05 code 依賴）
3. 第三方依賴改 npm 或保留 in-tree
4. 更新 `manifest.json` 路徑
5. 用 `mcp__cetus-chrome__*` 跑 Chrome 載入測試
6. 確認 OK 才能刪 legacy

### 步驟詳述

**Step 1 — Baseline 測試（改 code 前必做）**

```
# 1. 列出 pages
mcp__cetus-chrome__list_pages

# 2. 開 chrome://extensions/ 拿 Cetus extension ID
mcp__cetus-chrome__navigate_page type=url url=chrome://extensions/
mcp__cetus-chrome__evaluate_script function="
  () => Array.from(document.querySelectorAll('extensions-item')).map(el => ({
    name: el.shadowRoot?.querySelector('#name')?.textContent?.trim(),
    id: el.id,
  }))
"
# 應該看到 Cetus 與其 ID（chrome-devtools-mcp 啟動時用 --load-extension 載的）

# 3. 開 popup
mcp__cetus-chrome__new_page url=chrome-extension://<ID>/extension/popupview.html
mcp__cetus-chrome__take_snapshot
mcp__cetus-chrome__list_console_messages

# 4. 記錄 baseline console errors 到 progress.md 暫存區，後面要對比
```

**Step 2 — HTML 搬進 src/**

| 舊路徑 | 新路徑 | 備註 |
|---|---|---|
| `extension/popupview.html` | `src/popup/popup.html` | |
| `extension/devpanelview.html` | `src/devtools/panel.html` | |
| `extension/devtools.html` | `src/devtools/devtools.html` | |
| `extension/options.html` | `src/options/options.html` | |
| `extension/background.html` | **刪除** | MV3 service worker 不需要 |

CSS 引用路徑同步調整。可選方案：

- A：保留 `extension/css/` 暫時不搬，HTML 用相對路徑 `../../extension/css/`
- B：搬到 `src/popup/css/` 等對應位置，HTML 用同層相對路徑

推薦 A（範圍小）。

**Step 3 — 每個 deploy 的 TS 檔加 globalThis 橋接**

範例（`src/shared/utils.ts` 結尾）：

```ts
// Re-expose as globals for legacy v1.05 popup/content code that hasn't been
// migrated to ES module imports yet (see harden-cetus-runtime change).
Object.assign(globalThis, {
  toHex, toHexByte, formatValue, formatInteger,
  storageSet, storageGet, isValidMemType, getElementSize,
  getMemoryType, indexToRealAddress, realAddressToIndex,
  convertToI64, downloadText,
  bigintJsonParse, bigintJsonStringify, bigintIsNaN,
});
export {};
```

**注意**：`src/shared/utils.ts` 跟 `src/shared/contentutils.ts` 帶 `@ts-nocheck`，
但 task 5.4 的 scope 不含 `src/shared/`（task 5.4 已標 done）。這兩個檔可保留
`@ts-nocheck` 直到刪除。

Task 5.1–5.3 已把 utils.ts 拆成 `format.ts`、`memory.ts`、`bigint-json.ts`。
理論上 utils.ts 應該被它們取代。但 popup HTML 載的是 utils.ts。處理方式：

- 把 utils.ts 改成 re-export `format`／`memory`／`bigint-json` 的內容
- 或讓 popup HTML 直接 import 三個拆出來的檔

推薦後者（乾淨）。

**Step 4 — 第三方依賴**

| 套件 | npm package | Fallback（套件不存在或差太多） |
|---|---|---|
| `extension/thirdparty/bliss/bliss.js` | `npm install blissfuljs`（先 `npm view blissfuljs` 確認存在） | 保留 in-tree、寫到 docs/security-debt.md |
| `extension/thirdparty/prism/*` | `npm install prismjs` | 保留 in-tree |
| `content/thirdparty/stacktrace/stacktrace.min.js` | `npm install stacktrace-js` | 保留 in-tree |

裝完後 src/ TS 用 `import Prism from "prismjs"` 等取代 global 引用。
版本 lock 在 `package.json`，並提交 `package-lock.json`。

如果採 fallback「保留 in-tree」：

- popup HTML 用 `<script type="module" src="...">` 載
- 在 docs/security-debt.md 加一條 S-8「thirdparty 仍 in-tree，待 upgrade-thirdparty change」

**Step 5 — manifest.json 路徑更新**

```json
{
  "action": { "default_popup": "src/popup/popup.html" },
  "devtools_page": "src/devtools/devtools.html",
  "options_ui": { "page": "src/options/options.html", "open_in_tab": false }
}
```

`web_accessible_resources` 已指向 `src/`，不用動。
`content_scripts` 已指向 `src/`，不用動。
`background.service_worker` 已指向 `src/background/index.ts`，不用動。

**Step 6 — Build 與 MCP 驗證**

```bash
npm run build
```

Chrome 不會自動 reload extension。手動觸發：

```
mcp__cetus-chrome__navigate_page type=url url=chrome://extensions/
mcp__cetus-chrome__evaluate_script function="
  () => document.querySelector('extensions-item')?.shadowRoot
    ?.querySelector('#dev-reload-button')?.click()
"
```

接著驗 popup／devtools／options：

```
mcp__cetus-chrome__new_page url=chrome-extension://<ID>/src/popup/popup.html
mcp__cetus-chrome__take_snapshot
mcp__cetus-chrome__list_console_messages
# 對比 baseline。不應出現新的 module load failure、404、未定義變數錯誤。
```

**Step 7 — 刪除 legacy（驗證通過才能做）**

刪除清單：

```
extension/background.js
extension/background.html        # 已從 manifest 移除
extension/devtools.js
extension/extension.js
extension/view.js
extension/optionspage.js
extension/libs/{assembler,disassembler,navigation,patch,theme}.js
extension/thirdparty/bliss/      # 改 npm 才刪；保留 in-tree 就留
extension/thirdparty/prism/      # 同上
extension/popupview.html         # 已搬到 src/
extension/devpanelview.html      # 已搬到 src/
extension/devtools.html          # 已搬到 src/
extension/options.html           # 已搬到 src/
content/cetus.js
content/content.js
content/init.js
content/thirdparty/stacktrace/   # 改 npm 才刪
shared/utils.js
shared/contentutils.js
```

**保留**：

- `shared/wail.min.js/`（Stage 5 task 6.6 才刪）
- `extension/css/`（CSS 還在用）
- `src/shared/utils.ts`、`src/shared/contentutils.ts`（可保留 @ts-nocheck 或刪掉，看是否還有引用）

驗證：

```bash
git ls-files | grep -E '^(extension|content|shared)/.+\.js$' | grep -v wail.min.js
# 應該沒有結果
```

**Step 8 — 最終 build + MCP smoke test**

```bash
npx tsc --noEmit
npm run build
npm test
```

MCP：

- popup 開得起來、console 沒 module load failure
- devtools panel 開得起來
- options 開得起來
- service worker 沒 crash（從 `chrome://extensions/` 看 service worker 狀態）

如果 watchpoint／patch／speedhack 等行為要驗，需要 WASM demo 頁面 — 自己起
`python3 -m http.server` 跑簡易 WASM 測試頁，用 `mcp__cetus-chrome__new_page` 開。
或承認這部分留給使用者親自驗。

---

## Stage 4 收斂 — task 5.6（`#28`）

```bash
git add -A
# 呼叫 /tw-emoji-commit skill 取得 message
# 自行 git commit -m "<msg>"（pre-audit commit）

# 呼叫 /spectra-audit
# 若有 Critical／Warning finding，修正：
#   git add -A
#   /tw-emoji-commit
#   git commit -m "<msg>"（post-audit commit）
# 若無 finding，可只做一個 commit 並標 post-audit

# 更新 docs/progress.md：
#   - 勾 Stage 4 框
#   - 填 §2 pre-audit、post-audit commit sha
#   - 更新 §3 下一 Stage 入口為 Stage 5 (task 6.1 / `#29`)

spectra task done --change "modernize-chrome-extension-mv3" 28
```

---

## 嚴格規範（不得違反）

1. **`/tw-emoji-commit` skill 只回 message，不自動 commit**。拿到 message 後**自己**
   執行 `git commit -m "<msg>"`。memory 已有此規則
   （`memory/feedback_tw_emoji_commit_flow.md`）。
   違規（自寫 message 繞過 skill）會在 `/spectra-audit` 被標。

2. **每個 Stage 結尾必走 `commit → /spectra-audit → commit`**。Audit 未通過不得進
   下一 Stage。

3. **語言**：所有中文輸出（commit message、progress.md、註解、回覆使用者）一律
   **台灣慣用繁體中文**。**禁止簡體字與大陸用語**：
   - 軟件 → 軟體；網絡 → 網路；代碼 → 程式碼；視頻 → 影片
   - 默認 → 預設；用戶 → 使用者；數據 → 資料／數據
   - 文件夾 → 資料夾；菜單 → 選單；屏幕 → 螢幕

   技術名詞照英文（commit、PR、cache、API、build、log、debug）不強翻。

4. **6 個 deferred 檔不要動 `@ts-nocheck`**：
   - `src/content/{cetus,init}.ts`
   - `src/popup/{extension,view}.ts`
   - `src/popup/libs/{assembler,disassembler}.ts`

   理由：含 S-1（`new Function()`）、S-2/S-3（`innerHTML`）、S-5（弱型別 callback）
   等 v1.05 既存安全債務，整檔型別化超出本 change scope。已 defer 到
   `harden-cetus-runtime` change，記錄在 `docs/security-debt.md`。Task 5.4 描述已明文。

5. **不要刪 `shared/wail.min.js/`**：那是 Stage 5 task 6.6（`#34`）的工作。

6. **task 描述與 design.md Implementation Contract 衝突或描述含糊時**：暫停回報
   使用者，不自行推翻 design Decisions
   （per design.md §跨 session／跨 model 工作流程）。

7. **不要用 TaskCreate／TaskUpdate 等 built-in task tracker**。`/spectra-apply`
   skill 明文：「No external task tracking — the tasks file is the only system」。
   進度只靠編輯 tasks.md 的 `- [ ]` ↔ `- [x]` 與 `spectra task done` 命令。

8. **`docs/security-debt.md` 是 deferral 的事實來源**。若 task 5.5 過程中發現新的
   security debt 且決定 defer，必須在該檔加新條目（S-8、S-9...），不得只用
   inline comment。

---

## 重要參考檔（依使用頻率排序）

- `openspec/changes/modernize-chrome-extension-mv3/tasks.md` — 43 個 task 細節 + 驗證命令
- `openspec/changes/modernize-chrome-extension-mv3/design.md` — Implementation Contract
  **必讀**：§Failure modes、§Risks／Trade-offs、§跨 session／跨 model 工作流程
- `openspec/changes/modernize-chrome-extension-mv3/proposal.md` — Why／What／Capabilities
- `docs/progress.md` — 跨 session hand-off，每 Stage 結束必更新
- `docs/security-debt.md` — S-1..S-7 v1.05 遺留安全債務（task 5.4 deferral 根據）
- `.spectra.yaml` — 專案設定：`tdd: true`、`audit: true`、`parallel_tasks: true`
- `scripts/retrofit-types.mjs` — 型別 retrofit 腳本（task 5.4 用過）

---

## MCP 設定（已在 repo root `.mcp.json`）

```json
{
  "mcpServers": {
    "cetus-chrome": {
      "command": "npx",
      "args": [
        "chrome-devtools-mcp@latest",
        "--isolated",
        "--categoryExtensions",
        "--chrome-arg=--load-extension=/Users/phoenix/dev/ctf-tools/Cetus/dist",
        "--ignore-default-chrome-arg=--disable-extensions"
      ]
    }
  }
}
```

新 session 啟動時 Claude Code 會問你（使用者）要不要批准這個 project MCP
server，請按 yes。批准後可用 `mcp__cetus-chrome__*` 工具。

如果 ToolSearch 查不到 `cetus-chrome`：

- ToolSearch query：`+cetus chrome`
- 用 skill `chrome-devtools-mcp:troubleshooting` 排查
- 確認 `dist/` 存在（沒有就先 `npm run build`）
- 確認 Chrome 版本 ≥ 120（manifest 要求；目前環境 Chrome 148 OK）

要載入新版 dist/，每次改完跑 `npm run build`，然後用上面 Step 6 的
reload trick 觸發 extension reload。

---

## 開工

讀完 `tasks.md` 與 `design.md` 後 announce「Starting task 5.5: module migration」，
依 Step 1–8 推進。每改一段就用 `mcp__cetus-chrome__*` 驗證；不要囤積多檔改動才測。

遇到不確定的設計決策（npm 套件選擇、HTML 搬遷位置、是否 defer 某項）→ 暫停
回報使用者。
