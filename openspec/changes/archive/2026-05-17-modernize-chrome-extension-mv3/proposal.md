## Why

Cetus 是 2020 年發布的 WebAssembly 動態分析瀏覽器擴充套件，原作者已停止維護。原始版本仍使用 Manifest V2、persistent background page、無建構工具、無型別系統、無單元測試，目前最新版 Chrome 已逐步停用 MV2，使原擴充套件無法安裝。同時，使用者後續希望以 spectra change 流程持續維運此專案，並要求每個階段都能在不同 AI session 與不同 model 之間順利接續，因此本次提案除了技術現代化外，也需在 design 與 tasks 上採用 self-contained 的撰寫風格與固定的 hand-off 機制。

## What Changes

- **BREAKING** Manifest 由 v2 升級至 v3；`background.page` + `persistent: true` 改為 `background.service_worker`；`browser_action` 改為 `action`；`web_accessible_resources` 改為新格式物件陣列；`content_security_policy` 改為 `{extension_pages, sandbox}` 物件；host permissions 從 `permissions` 拆到 `host_permissions`。
- **BREAKING** 引入 Node.js 工具鏈：新增 `package.json`、`tsconfig.json`、`vite.config.ts`、`.nvmrc`；改用 `@crxjs/vite-plugin` 打包；產出目錄改為 `dist/`，使用者載入未封裝項目時需指向 `dist/` 而非 repo root。
- 原始碼結構由 `extension/` + `content/` + `shared/` 重組為 `src/{background,content,popup,devtools,options,shared}/`，全數改寫為 TypeScript（strict mode）。
- 將 binary instrumentation 引擎（原 `shared/wail.min.js`）改寫為 Rust crate `crates/cetus-wail`，以 `wasm-bindgen` + `wasm-pack` 編譯為 WASM 模組供 content script 載入。
- 將原本掛在 background page 記憶體的 `WASMInstance` 與 `WindowInstance` 狀態（bookmarks、watchpoints、symbols、stackTraces、searchForm、stringForm、patchForm、speedhack、memoryViewer）改寫為可序列化結構，透過 `chrome.storage.session` + `chrome.storage.local` 持久化，service worker 重啟時自動還原。
- 引入 Vitest 單元測試覆蓋 shared utils 與訊息協定；更新 `.github/workflows/CI.yml` 改用 `actions/setup-node@v4`、Node 20、cache npm、cache cargo、執行 `wasm-pack build` 與 `npm test`。
- 版本由 1.05 升至 2.0.0，新增 `CHANGELOG.md`，更新 `README.md` 安裝與開發步驟（含 Rust toolchain 需求）。
- 新增 `docs/progress.md` 作為跨 Stage 的 hand-off 檔；新增 design.md 中強制規範：每個 task 必須 self-contained、含完整檔案路徑與可驗證準則。
- 移除 in-tree 的 `extension/thirdparty/{bliss,prism}`、`content/thirdparty/stacktrace`、`shared/wail.min.js/`，改以 npm 依賴或 Rust crate 取代。

## Capabilities

### New Capabilities

- `mv3-runtime`: Manifest V3 service worker 入口、訊息協定、生命週期事件，以及與 popup／devtools／content script 的雙向通訊規則。
- `state-persistence`: 跨 service worker 與跨瀏覽器 session 的擴充套件狀態持久化，包含 instance state 序列化、儲存層選擇（session vs local）、還原與遷移規則。
- `wasm-instrumentation`: 使用 Rust 編寫並編譯為 WASM 的 binary instrumentation 能力，取代既有 WAIL，提供 watchpoint 插入、函式 patch、disassembly 輸入處理。
- `build-tooling`: Vite + TypeScript + wasm-pack 的開發、打包與發布流程，包含 npm scripts、CI 工作流程、Node／Rust toolchain 版本管理。

### Modified Capabilities

（無；本專案的 OpenSpec specs 目錄原本即為空，沒有可被修改的既有 capability。）

## Impact

- Affected specs: 新增 `mv3-runtime`、`state-persistence`、`wasm-instrumentation`、`build-tooling` 四個 capability spec。
- Affected code:
  - New: package.json, tsconfig.json, vite.config.ts, .nvmrc, src/background/index.ts, src/background/instances.ts, src/background/messaging.ts, src/content/index.ts, src/content/cetus.ts, src/content/init.ts, src/popup/index.ts, src/devtools/index.ts, src/devtools/panel.ts, src/options/index.ts, src/shared/format.ts, src/shared/memory.ts, src/shared/bigint-json.ts, src/shared/storage.ts, src/shared/messages.ts, src/shared/instance-data.ts, crates/cetus-wail/Cargo.toml, crates/cetus-wail/src/lib.rs, tests/shared.test.ts, tests/messages.test.ts, docs/progress.md, CHANGELOG.md
  - Modified: manifest.json, .github/workflows/CI.yml, README.md
  - Removed: extension/background.html, extension/background.js, extension/popupview.html, extension/view.js, extension/devtools.html, extension/devpanelview.html, extension/devpanelview.js, extension/options.html, extension/optionspage.js, extension/thirdparty/bliss, extension/thirdparty/prism, content/content.js, content/cetus.js, content/init.js, content/thirdparty/stacktrace, shared/utils.js, shared/contentutils.js, shared/wail.min.js
