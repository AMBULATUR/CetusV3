# Cetus 已知安全債務（Security Debt Backlog）

本檔記錄從 v1.05 codebase 繼承下來的安全議題。這些都是**先存在**於 v1.05 的行為，
`modernize-chrome-extension-mv3` change 的目標是 MV3／TS／Rust／CI 現代化，**不**包含
這些既有功能的安全改寫（明確列在 `design.md` Out of scope：「改變使用者操作流程或快捷鍵」、
「memory search 改 Rust、disassembly 改 Rust」、design 全文未承諾改 patch callback 機制
與 popup DOM 渲染方式）。

> 建議：另開 spectra change `harden-cetus-runtime` 來處理本檔列出的項目。

---

## 來源

由 `/spectra-apply modernize-chrome-extension-mv3` Stage 1+2 pre-audit 的 `/spectra-audit`
（commit `bacd0ed`）回報；交叉比對原 v1.05 `extension/`、`content/`、`shared/` 對應位置可確認皆為
inherited behavior。

## 條目

### S-1 [Critical, inherited] `new Function()` 執行使用者儲存的 callback 字串

- 位置：`src/content/init.ts` lines ~972、~1300（複製自 `content/init.js`）
- 行為：從 `chrome.storage.local.savedPatches[i].callbacks.{processor,preinstantiate}` 讀字串
  並用 `new Function("processor", str)(wail)` 執行。
- 語境：這是 Cetus wiki tutorial 文件化的「patch callback」功能；功能本意即為由使用者撰寫並
  儲存的 JS callback。移除等於砍掉 Cetus 公開行為，與本 change 的 scope 衝突
  （`design.md` 明文「不變更使用者操作流程」）。
- 風險：若攻擊者能寫入 `chrome.storage.local`（透過 sync 帳號或另一 malicious extension）即可
  植入任意 JS 在 content script context 執行。
- 後續建議：
  - 改以 `wasm-bindgen` 暴露的有限 API 取代 `new Function()`（callback 改 declarative）；或
  - 加入「使用者首次套用 patch 前必須在 popup 顯示 callback 內容並按確認」之 UX gate。

### S-2 [Critical, inherited] popup／devtools 使用 `innerHTML` 渲染含使用者資料的內容

- 位置：`src/popup/view.ts`（多處，例如 line ~737 bookmarkMenu）、`src/popup/extension.ts`
- 行為：bookmark／patch name／symbol name 等可使用者輸入的字串以 `innerHTML` 插入 DOM。
- 風險：使用者可能在 patch name 內塞 `<script>...</script>`，重新打開 popup 時觸發 stored XSS。
- 後續建議：
  - 全面以 `textContent` + `document.createElement(...)` 改寫；或引入 Lit／渲染框架做 escape。
  - 此項預計與 Stage 4 task 5.4 移除 `// @ts-nocheck` 一併排程，但完整 escape 改寫超出本 change scope。

### S-3 [Critical, inherited / 已部分緩解] content script 透過 `<script>.innerHTML = code` 注入頁面

- 位置：`src/content/content.ts` lines 43–53（`injectCode`）、131–138（`allCallbacksStr` 注入）。
- 行為：把一段 JS（含 `JSON.stringify` 過的 callback 物件）以 `<script>` 注入頁面。
- 部分緩解：`allCallbacksStr` 已是 `JSON.stringify(allCallbacks)` 的結果，**quote-breaking
  attack 不成立**（audit 報告對此點的判斷有誤）；但執行進入頁面 scope 後，callback 字串本身
  仍會被 init.ts 的 `new Function()` 執行，根本風險在 S-1。
- 後續建議：與 S-1 合併處理。

### S-4 [High, inherited] CSP 仍允許 `style-src 'unsafe-inline'`

- 位置：`manifest.json` `content_security_policy.extension_pages`。
- 行為：v1.05 即為 `default-src 'self'; style-src 'unsafe-inline';`；本 change 為相容 popup／
  devtools panel 內既存大量 `style="..."` 屬性與 `<style>` 區塊，沿用之並補上 `'self'`。
- 風險：若 S-2 被觸發，攻擊者可注入帶 CSS expression／URL 載入 trick 的 inline style。
- 後續建議：把 popup／devtools panel 的 inline styles 整批搬到外部 CSS（或用 `class` 切換），
  再把 CSP 改為 `style-src 'self'`。本項可於後續 UI 重寫 change 一併處理。

### S-5 [High, inherited] callback 字串只做 `typeof === "string"` 弱型別檢查

- 位置：`src/content/content.ts` lines ~113、~116。
- 後續建議：加入長度上限、特徵字串 deny-list（`chrome.runtime.`、`fetch`、`XMLHttpRequest` 等），
  並把驗證與 S-1 一併重新設計。

### S-6 [Medium, inherited] 儲存的 patch 無 HMAC／簽章驗證

- 位置：`src/popup/extension.ts`（建立）／`src/content/content.ts`（載入）。
- 後續建議：以 extension 自有的 per-install secret 對每筆 patch 做 HMAC-SHA256，載入時驗章。

### S-7 [Low, inherited] patch 版本舊／新雙路徑沒有顯式 feature detection

- 位置：`src/popup/extension.ts` lines ~145–158（`typeof options.version === "undefined"` 分支）。
- 後續建議：引入 `zod` 或同等 schema 驗證，顯式拒絕未知 patch 格式。

### S-8 [Medium, deferred] 第三方依賴仍以原始檔案保留於 in-tree

- 位置：`extension/thirdparty/{bliss,prism}/`、`content/thirdparty/stacktrace/`。
- 行為：v1.05 將 `blissfuljs`、`prismjs`、`prism-live`、`prism-line-{numbers,highlight}`、
  `stacktrace.min.js` 等以未壓縮／已壓縮檔案內嵌；版本封死，難以更新。
- 本 change 處置：task 5.5 module migration 已驗證對應 npm 套件 (`blissfuljs@1.0.6`、
  `prismjs@1.30.0`、`stacktrace-js@2.0.2`) 存在於 registry，但**未**切換到 npm，理由：
  - `prism-live.js` 是 Lea Verou 的 prism 附加套件，**沒有 npm 上對應的 package**；它依賴
    `window.Bliss` 作為全域，npm 化 prismjs 但保留 prism-live 會產生依賴失配。
  - 切換到 npm 套件需要重寫第三方初始化方式（從 `window.Bliss/Prism` 全域改為 ESM import 並
    顯式注入到全域），影響範圍超出 task 5.5 module migration 的最小化變動原則。
  - 三個套件最新版（特別是 Prism 1.30 vs in-tree 1.17.1）有 API 差異，需測試 popup
    語法高亮、disassembler / assembler 行為仍正確。
- 風險：版本鎖死意味著上游修補的 prototype pollution、CSS injection 等漏洞無法獲得；
  目前 popup CSP `style-src 'unsafe-inline'`（S-4）會放大 Prism CSS injection 漏洞的影響面。
- 後續建議：另開 spectra change `upgrade-thirdparty`：
  - `npm install blissfuljs prismjs stacktrace-js` 並提交 lock file。
  - 把 `prism-live.js` 改為 in-tree（記錄為 `vendor/prism-live.js`）並補上 npm 版本對齊測試。
  - popup／devtools 改以 `import Prism from "prismjs"` 等 ESM 取代 `<script>` 全域注入。

### S-9 [Medium, deferred] Content-script 注入鏈仍指向 legacy `content/` 與 `shared/` 路徑

- 位置：`src/content/content.ts` lines ~142–146（`injectScript("/shared/utils.js")` 等五個 inject 點）。
- 行為：content script 以 `chrome.extension.getURL("/<legacy path>")` 將 `shared/utils.js`、
  `shared/wail.min.js/wail.min.js`、`content/thirdparty/stacktrace/stacktrace.min.js`、
  `content/cetus.js`、`content/init.js` 注入到目標頁面的 main world，這些檔案以**classic
  script** 形式執行，依賴 page-side 全域。
- 本 change 處置：task 5.5 module migration **不**改寫此注入鏈，理由：
  - 注入目標是 page main world，不是 extension context；需以 classic JS 形式提供，與
    `src/` 下的 ESM 模組（含 `import` / `export`）不相容，直接改路徑到 `/src/...` 會在 page-side
    解析時噴 SyntaxError。
  - 重新設計 in-page 注入機制（pre-build 出 classic 版本、或改用 `chrome.scripting.executeScript`
    + Rust crate）原預期與 Stage 5 task 6.5 一併處理；但 Stage 5 已於 2026-05-17 narrow scope
    （per design.md §Decisions「Scope narrowing discovered during Stage 4 → 5 transition」），
    本 change 不再涉及此重設計，整段 defer 到 `harden-cetus-runtime`（FW-1）。
  - 因此本 change 保留 `content/{cetus,content,init}.js`、`content/thirdparty/stacktrace/`、
    `shared/wail.min.js/` submodule 於 in-tree。
- 風險：legacy 檔保留增加維護面積；S-1（`new Function()`）與 S-3（`<script>.innerHTML = code`）
  在 content script 端的觸發路徑與這些 legacy 注入點直接相關。
- 後續建議：於 `harden-cetus-runtime`（FW-1）內處理：以 `chrome.scripting.executeScript({ world: "MAIN" })`
  注入 ESM-friendly 版本，或在 Vite build pipeline 加入 classic-output target 把 `src/content/{cetus,init}.ts`
  另外輸出為 IIFE bundle 放到 `dist/content/` 並更新 `injectScript` 路徑與 `web_accessible_resources`。

### S-10 [Medium, deferred] init.ts／disassembler／assembler 仍使用 WAIL low-level API

- 位置：
  - `src/content/init.ts`（1300 行；instrumentation logic、symbol export、`WebAssembly` proxy）
  - `src/popup/libs/disassembler.ts`（753 行；line 27 `class InstructionReader extends BufferReader`）
  - `src/popup/libs/assembler.ts`（1063 行；wasm 文字組譯）
- 行為：這三檔大量使用 `shared/wail.min.js` submodule 提供的 WAIL low-level API：
  - `WailParser` class（init.ts line 65、line 1292；cetus.ts line 531 已在 Stage 5 task 6.5 切到 Rust crate）
  - `BufferReader` class（disassembler.ts line 27）
  - 約 200 個 opcode 常數（`OP_*`、`ARG_*`、`VALUE_TYPE_*`、`SIMD_*` 等，宣告於 `src/types/globals.d.ts` lines 32–253）
  - `VarUint32`、`VarUint32ToArray`、`VarSint32ToArray`、`KIND_MEMORY`、`OP_ATOMIC`、`exportsInstance` 等 helper
- 本 change 處置：
  - Stage 5 task 6.5 明文 narrow scope 為「只切 `cetus.ts` 一處」（per design.md §Decisions「Scope narrowing discovered during Stage 4 → 5 transition」）
  - Stage 5 task 6.6 明文「不刪 submodule」
  - `shared/wail.min.js` submodule 保留為 init／disassembler／assembler 的執行期依賴
  - Stage 6 task 7.2 CI workflow 須 `submodules: recursive`，確保 clean checkout 仍可載入 wail
- 風險：
  - WAIL 是 2020 年停止維護的 minified JS（80 KB 單行），無 source map、無 type；將來若需要修補 WAIL bug，必須自己 un-minify 或全部改寫
  - submodule URL `github.com/Qwokka/wail.min.js`（Qwokka 帳號 2020 後沉寂）若失聯，本專案 `npm install` 後仍無 wail.min.js（git submodule 是另一個 protocol，clone 失敗時 popup／content 腳本會在 runtime 失效）。短期緩解：FW-8 `migrate-vendored-wail` change（見 design.md §Future Work）可把 submodule 內容 vendor 進 `vendor/wail.min.js/`，0.5 工作天即可
- 後續建議：另開 spectra change `harden-cetus-runtime`（FW-1；與 S-1..S-7、S-9 合併處理），三選一（或組合）：
  - 選項 (a)：cetus-wail Rust crate 擴充 low-level API surface（exporting `WailParser`-equivalent class plus opcode 常數）給 TS 呼叫——估 ~2000 行 Rust + 對應 wasm-bindgen 宣告
  - 選項 (b)：把 init.ts 的整段 instrumentation 邏輯重寫進 Rust crate，TS 端只保留高階呼叫——估 1300 行 TS → ~2500 行 Rust（含 unit tests）
  - 選項 (c)：disassembler／assembler 改用 `prismjs` 語法高亮 + 純 wasm spec text format encoder/decoder（不再依賴 WAIL）——獨立於 (a)／(b)，可分階段

---

## 本 change 的處置

- 不在 Stage 1／2 修改既存 callback／DOM 渲染／patch 載入邏輯（task 2.5：「保留原邏輯（不改行為）」）。
- 將上列條目記錄於本檔，方便後續 spectra change `harden-cetus-runtime` 取用。
- Stage 3 起新增的程式碼（`src/shared/messages.ts`、`src/shared/storage.ts` 等）會遵守已折入
  Stage 0 audit 的 M1／M2／M3 補強（runtime throw、persistent tier 不收 session-only 資料、
  WASM bytes 在 `WebAssembly.instantiate` 前必須 check `Result`）。
