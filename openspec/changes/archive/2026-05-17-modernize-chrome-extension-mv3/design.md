## Context

Cetus 是 Jack Baker 於 2020 年發布的 WebAssembly 動態分析 Chrome／Firefox 擴充套件，提供類似 Cheat Engine 的記憶體搜尋、watchpoint、bookmarks、code patch、memory viewer 與 disassembly 功能。專案已停止維護，目前 repo 狀態：

- `manifest.json` 為 Manifest V2，`background.page` 採 `persistent: true`，違反 Chrome 現行 MV3 規範。
- `extension/`、`content/`、`shared/` 三個目錄全為 vanilla JavaScript；無 `package.json`，無建構工具，無型別系統。
- 第三方套件以未壓縮／壓縮過的檔案內嵌（`bliss.js`、`prism.js`、`stacktrace.min.js`、`wail.min.js`），版本封死且難以更新。
- 主要狀態（`WASMInstance.instanceData`、`WindowInstance`）以 in-memory JavaScript 物件保存於 background page；MV3 service worker 隨時可能被瀏覽器回收，導致 watchpoints、bookmarks、patches 等使用者資料遺失。
- 無單元測試；`.github/workflows/CI.yml` 使用 `actions/setup-node@v2` 與 Puppeteer 16.6.0（皆過時），CI 倚賴外部 repo `Qwokka/CetusCITests`。
- 使用者明確指示：本 spectra change 在執行階段必須能跨多個 AI session 與不同 AI model 接續執行；每個 Stage 結束都要走 `commit → /spectra-audit → commit` 流程。

Stakeholders：

- 使用者（接手 Cetus 的新維護者）。
- 未來執行 `/spectra-apply` 的 AI agent（可能不同 model、不同 session）。
- Cetus 終端使用者（WebAssembly 安全研究者、CTF 玩家）。

## Goals / Non-Goals

**Goals:**

- 提供可在最新版 Chrome（≥ 120）安裝執行的 Manifest V3 擴充套件，不破壞既有使用者面對的功能（memory search、watchpoint、bookmark、patch、speedhack、memory viewer、disassembly）。
- 將原始碼遷移到 TypeScript strict mode 並建立 Vite 建構流程，使後續修改具備型別檢查、模組化、現代化套件管理。
- 將 binary instrumentation 引擎以 Rust crate 重寫並編譯為 WASM，使核心邏輯具備記憶體安全、可單元測試、可重現建置。
- 提供 service worker 重啟後仍可還原使用者狀態的持久化機制。
- 確保本 change 的 tasks 與 design 文件足以讓不同 AI session／model 在中斷後接續實作；提供標準 hand-off 機制（`docs/progress.md`）與 strict audit gate。

**Non-Goals:**

- 不引入 AI/LLM 整合（如 Claude／OpenAI API），由後續 spectra change 評估。
- 不重寫 memory search、disassembly、UI 互動為 Rust；本 change 只將 binary instrumentation（WAIL）改為 Rust。
- 不維持 MV2 雙清單並存；Chrome 已不再支援 MV2，Firefox 相容由後續 change 處理。
- 不變更使用者操作流程與快捷鍵；只在無法保留 MV2 行為時記錄差異到 CHANGELOG。
- 不引入完整的 E2E 測試（Puppeteer 整合測試）；本 change 只覆蓋 Vitest 單元測試，E2E 改用獨立 change 處理。
- 不在本 change 中遷移 host permissions 以外的權限策略改變（例如改用 `optionalPermissions`）。

## Decisions

### 採用 Vite + `@crxjs/vite-plugin` 作為建構工具

選擇 Vite 而非 Webpack／Parcel／esbuild：Vite 對 Chrome Extension 有官方等級的社群外掛 `@crxjs/vite-plugin`，原生支援 manifest.json 作為入口、自動處理 HMR、service worker bundling，且維護活躍。Webpack 需要大量手工設定，esbuild 缺少 manifest 感知，Parcel MV3 支援不穩定。

替代方案考慮：

- **Webpack 5 + copy-webpack-plugin**：成熟度高但設定冗長；放棄。
- **esbuild + 自製腳本**：速度快但 manifest／HMR 需自己寫；放棄。
- **Rollup + rollup-plugin-chrome-extension**：可用但社群活躍度落後 `@crxjs/vite-plugin`；放棄。

### 採用 TypeScript strict mode

`tsconfig.json` 啟用 `strict: true`、`noUncheckedIndexedAccess: true`、`exactOptionalPropertyTypes: true`。原始 `instanceData` 結構含大量 optional 欄位（`bookmarks`、`watchpoints`、`stackTraces` 等），strict mode 能在編譯期攔截 service worker 重啟後讀到 `undefined` 的常見錯誤。

### Manifest V3 service worker 採模組化 import

`background.service_worker` 指向 `src/background/index.ts`，並在 manifest 中設定 `"type": "module"`，使 service worker 可直接 `import` 其他模組，避免 IIFE bundle 全部塞在單檔。`@crxjs/vite-plugin` 已支援此模式。

替代方案考慮：

- **單一 bundle**：相容性最高但模組界線消失，違反「跨 model 接續」需求；放棄。

### 狀態持久化策略：`chrome.storage.session` + `chrome.storage.local` 雙層

`chrome.storage.session`（瀏覽器運行期間可用，重開瀏覽器清空）儲存 `WASMInstance` runtime state（含 stackTraces、searchForm.results、memoryViewer.memData 等可能很大的資料）；`chrome.storage.local`（跨瀏覽器 session）儲存使用者選擇要保留的「設定性」資料（bookmarks、watchpoints 設定、patches、speedhack.multiplier）。Service worker `onStartup` 與訊息處理進入點都會先 hydrate 狀態，避免在尚未還原時處理訊息。

替代方案考慮：

- **全部用 `chrome.storage.local`**：簡單但會把瞬時的大量資料（memData）寫入永久儲存，浪費 quota；放棄。
- **`IndexedDB`**：容量大但 API 複雜，對於 < 5MB 資料 overhead 高；放棄，留作 disassembly cache 等大型資料的未來選項。

### Binary instrumentation 改寫為 Rust（cetus-wail crate）

原 `wail.min.js` 為 JavaScript 寫的 WASM binary patcher。改寫為 Rust crate `crates/cetus-wail` 透過 `wasm-bindgen` 與 `wasm-pack --target web` 編譯為 ESM；TypeScript 端以 `import init, { instrument } from "cetus-wail"` 取用。Rust 編寫 binary parser 具備明確的型別、可單元測試、可在 `crates/cetus-wail/tests/` 內存放黃金樣本。

替代方案考慮：

- **沿用 wail.min.js**：違反使用者要求；放棄。
- **以 TypeScript 重寫**：可行但效能與型別安全不如 Rust；放棄。
- **AssemblyScript**：學習成本與生態系規模不如 Rust；放棄。

Scope 限制：本 change 只將 `wail.min.js` 的功能集（watchpoint 插入、函式 patch、disassembly 所需的 binary 讀取）改為 Rust。Memory search、UI、訊息處理留在 TypeScript。

#### Scope narrowing discovered during Stage 4 → 5 transition (2026-05-17)

Stage 4 task 5.5（module migration）實作期間驗證了原 design 對「Rust crate API 範圍」的估計不足：

- 原 design 預設 cetus-wail crate 只需暴露兩個高階函式 `instrument_watchpoint` 與 `apply_patch` 即可完整取代 `shared/wail.min.js`。
- 實作期發現：除了 `src/content/cetus.ts` line 531 的高階 `new WailParser(buffer)` 使用點之外，下列三檔大量使用 WAIL low-level API（`WailParser`、`BufferReader`、約 200 個 `OP_*`／`ARG_*`／`VALUE_TYPE_*`／`SIMD_*` 等 opcode 常數，以及 `VarUint32`／`VarUint32ToArray`／`VarSint32ToArray`／`KIND_MEMORY` 等 helper）：
  - `src/content/init.ts`（1300 行；instrumentation logic、symbol export、WebAssembly proxy）
  - `src/popup/libs/disassembler.ts`（753 行；`class InstructionReader extends BufferReader`）
  - `src/popup/libs/assembler.ts`（1063 行；wasm 文字組譯）

把這 3100 行 WAIL low-level 依賴整段改寫為 Rust crate 等價 API（任一選項：擴充 crate 暴露 low-level surface，或把整段 instrumentation 邏輯搬進 Rust）估 5–10 工作天，超出本 change 已對齊的 scope（task 5.4 已把這 6 個檔列為 deferred `// @ts-nocheck`，理由為 `docs/security-debt.md` S-1..S-7 既存安全債務）。

決議（路徑 3）：本 change Stage 5 範圍縮小為——

- 建立 `crates/cetus-wail` Rust crate，暴露 `instrument_watchpoint` 與 `apply_patch` 兩個高階函式（原 design 不變）。
- 透過 `wasm-pack` + Vite 整合到 build pipeline（原 design 不變）。
- `src/content/cetus.ts` line 531 的 `new WailParser(buffer)` 改 import Rust crate（原 design task 6.5 字面執行）。
- **不**刪除 `shared/wail.min.js` submodule；`src/content/init.ts`、`src/popup/libs/{assembler,disassembler}.ts` 仍透過該 submodule 使用 WAIL，等同 task 5.4 的 6 個 deferred `// @ts-nocheck` 檔策略。
- 順手把 `src/popup/wail-stubs.ts` 的 `BufferReader` stub 移除，改在 `src/popup/index.ts` import 真實的 `shared/wail.min.js/wail.min.js`，讓 popup disassembler／assembler tab 真正可用（`browser → chrome` polyfill 保留）。
- Deferral 紀錄於 `docs/security-debt.md` S-10；後續由 `harden-cetus-runtime` change 統一處理 init／disassembler／assembler 的 WAIL low-level 依賴。

替代方案考慮：

- **路徑 1（完整 byte-parity 重寫）**：cetus-wail crate 擴充至覆蓋 init.ts／disassembler／assembler 全部 WAIL low-level usage，並對比 v1.05 `wail.min.js` 做 byte-equivalent fixture 驗證。估 5–10 工作天，需要 reverse-engineer 80 KB minified 程式碼；放棄，理由為 scope 失控、Stage 6 release 時程不可控、byte-parity debug 成本高。
- **路徑 2（完整 behaviour-parity 重寫）**：crate 擴充同路徑 1，但改用 wiki tutorial 行為等價驗證。估 4–8 工作天；放棄，理由同上。

### 訊息協定型別化為 discriminated union

`src/shared/messages.ts` 定義所有 background ↔ content ↔ popup 之間的訊息為 discriminated union（以 `type` 欄位區辨），所有訊息收發端透過 `assertNever` 強制完整 switch。原版以字串 `type` 對應任意 `body` 形狀，service worker 喚醒後特別容易因 shape mismatch 失效。

### 跨 session／跨 model 工作流程：`docs/progress.md` 作為 hand-off 檔

由於本 change 預計跨多個 AI session 與 model 執行，採以下強制規則：

- 每個 Stage 結束時，執行者必須更新 `docs/progress.md`，內容包含：已完成的 task 編號、目前 git HEAD、下一個 Stage 入口（章節編號）、用以驗證該 Stage 的具體命令（例如 `npm run build && ls dist/manifest.json`）。
- 所有 task 必須 self-contained：含絕對檔案路徑、要達成的可觀察行為、驗證命令；不得用「延續上一個 task 的修改」這類依賴對話記憶的描述。
- 每個 Stage 結束前必須跑 `/spectra-audit` 並通過（無 Critical／Warning finding），未通過不得進入下一個 Stage。
- 所有技術決策（如 Vite、TypeScript、Rust + wasm-pack、雙層 storage、訊息 discriminated union）的選擇理由由本 design.md 記錄，apply 期間不得隨意推翻。

## Implementation Contract

### Behavior

- 安裝目錄：載入 `dist/` 後，瀏覽器顯示「Cetus」擴充套件圖示，可開啟 popup 與 DevTools `Cetus` panel。
- Memory search：使用者於 popup 輸入數值與比較條件後，content script 觸發搜尋並回傳結果至 popup；結果可加入 bookmark。
- Watchpoint：對 bookmark 設定 read／write／freeze flag 後，content script 透過 cetus-wail 改寫 WASM module 並注入 watchpoint；watchpoint 觸發時送出 stack trace 訊息給 background，再轉發給 popup／devtools。
- 狀態持久化：service worker 被瀏覽器 stop／restart 後，下一次訊息進來時可從儲存層還原 instance state；瀏覽器重啟後，bookmarks／watchpoints 設定／patches／speedhack.multiplier 仍存在。
- 行為等價：上述使用者面行為與舊版（v1.05）相同；唯一可見差異為安裝來源從 repo root 改為 `dist/`。

### Interface / Data shape

- `manifest.json` 結構：`manifest_version: 3`、`action`、`background.service_worker: "src/background/index.ts"`、`background.type: "module"`、`host_permissions: ["<all_urls>"]`、`permissions: ["activeTab", "storage"]`、`web_accessible_resources: [{ resources, matches }]`、`content_security_policy: { extension_pages: "..." }`。
- `src/shared/messages.ts` 訊息型別：以 `type` 欄位區分的 discriminated union，至少涵蓋 `init`、`updateBookmarks`, `updateWatch`, `searchMemory`, `searchResult`, `addStackTrace`, `applyPatch`, `setSpeedhack`, `updateMemView`, `restoreInstance`。
- `src/shared/instance-data.ts` `InstanceData` interface：保留原 `instanceData` 全部欄位（`initialized`, `url`, `bookmarks`, `watchpoints`, `symbols`, `stackTraces`, `searchForm`, `stringForm`, `patchForm`, `speedhack`, `memoryViewer`, `currentTab`），並提供 `serialize` 與 `deserialize` helper，能 round-trip `BigInt` 值（沿用原 `bigintJsonParse` 邏輯）。
- `crates/cetus-wail` 公開 API：`pub fn instrument_watchpoint(module: &[u8], addr: u32, flags: u8) -> Vec<u8>`、`pub fn apply_patch(module: &[u8], func_index: u32, body: &[u8]) -> Vec<u8>` 並透過 `wasm-bindgen` 匯出。
- npm scripts：`dev`（vite dev）、`build`（vite build → dist/）、`test`（vitest run）、`wasm`（wasm-pack build crates/cetus-wail --target web）、`typecheck`（tsc --noEmit）。

### Failure modes

- Service worker 在尚未 hydrate 狀態時收到訊息：訊息處理器在進入點 `await hydrateInstances()`，避免處理 `undefined` instance。Hydrate 過程中再次收到訊息時排入待辦佇列，在 hydrate 完成後依序執行。
- `chrome.storage.session` 在某些 Chromium 衍生瀏覽器不可用：偵測後 fallback 到 in-memory map，並在 popup 顯示警示「狀態僅在 service worker 存活期間保留」。**session-tier 不可用時不得把 session-only 資料（stackTraces／memoryViewer.memData／searchForm.results／symbols）silently 寫入 persistent tier** — 必須維持 in-memory fallback 或乾脆放棄該資料；persistent tier 永遠只接受 spec 列舉的設定性欄位。
- WASM module 不符合預期（cetus-wail 解析失敗）：Rust 端回傳 `Err`，TypeScript 端轉成訊息 `{ type: "error", code: "instrument-failed", message }` 給 popup 顯示。**TypeScript caller MUST 檢查 `Result`（或同等錯誤通道）後才能把 bytes 傳給 `WebAssembly.instantiate`**；任何 cetus-wail 失敗都必須以訊息形式上拋給 popup／devtools，不得 silently 把半改 module 餵給瀏覽器。
- 跨 model 接續：若 `docs/progress.md` 顯示某 Stage 未通過 audit，後續 model 不得跳過直接進入下一個 Stage。

### Acceptance criteria

- `npm run build` 在 clean repo 成功，產出 `dist/manifest.json` 為 v3，且 `dist/` 可直接以 Chrome 「載入未封裝項目」載入無 manifest 錯誤。
- `npx tsc --noEmit` 在 strict mode 下無錯誤。
- `npm test` 中 Vitest 套件全綠，至少覆蓋：`InstanceData` 序列化 round-trip、訊息 discriminated union 完整 switch、`convertToI64` 邊界值、`bigintJsonParse`/`bigintJsonStringify` round-trip。
- `wasm-pack build crates/cetus-wail --target web` 成功；Rust 端 `cargo test --manifest-path crates/cetus-wail/Cargo.toml` 通過。
- Rust 端單元測試以**合成 WASM 模組**（手寫小型 valid module）為 fixture 驗證 `instrument_watchpoint` 與 `apply_patch` 的功能正確性與錯誤處理；**不**進行 v1.05 `wail.min.js` byte-equivalent fixture parity 比對（per §Decisions「Scope narrowing discovered during Stage 4 → 5 transition」）。
- `src/content/cetus.ts` 不再 import 或 reference `WailParser`；`grep -n WailParser src/content/cetus.ts` 無命中。其他檔（`src/content/init.ts`、`src/popup/libs/{assembler,disassembler}.ts`）保留 WAIL 依賴；對應 deferral 紀錄於 `docs/security-debt.md` S-10。
- 手動驗證：載入後依 wiki tutorial「Cetus 101 - Invincibility」流程，能找到值、加入 bookmark、設定 watchpoint、觸發 stack trace、套用 patch；行為與 v1.05 等價。
- 手動驗證：DevTools → Application → Service Workers → Stop service worker，重新觸發後 bookmarks／watchpoints 仍存在；瀏覽器重啟後 `chrome.storage.local` 中的設定性資料還原。
- 每個 Stage 結束時 `docs/progress.md` 含對應條目；`spectra audit` 通過無 Critical／Warning finding。

### Scope boundaries

In scope：

- Manifest 結構升級、service worker 化、訊息協定型別化、狀態雙層持久化、binary instrumentation 改 Rust、Vite + TS 建構流程、Vitest 單元測試、CI 更新、版本／文件更新、cross-stage hand-off 機制。

Out of scope：

- Memory search 改 Rust、disassembly 改 Rust。
- Firefox MV3 / MV2 雙清單。
- AI/LLM 輔助分析。
- 改變使用者操作流程或快捷鍵。
- 套件 store（Chrome Web Store／AMO）上架流程。
- 完整 E2E（Puppeteer）整合測試。
- 變更 `MAX_WATCHPOINTS = 10` 上限或其他既有設定預設值。
- `src/content/init.ts`、`src/popup/libs/{assembler,disassembler}.ts` 對 WAIL low-level API（`WailParser`、`BufferReader`、opcode 常數等）的依賴替換；defer 到 `harden-cetus-runtime` change（`docs/security-debt.md` S-10）。
- `shared/wail.min.js/` submodule 移除（與上一條同 deferral）。
- Rust crate 與 v1.05 `wail.min.js` 的 byte-equivalent fixture parity 驗證；改用 wiki tutorial 行為等價（per §Decisions「Scope narrowing」）。

## Risks / Trade-offs

- [`@crxjs/vite-plugin` 對 MV3 service worker `type: "module"` 在 Chrome 早期版本有限制] → 鎖定支援 Chrome ≥ 120（於 README 與 manifest `minimum_chrome_version: "120"` 標明）。
- [Rust + wasm-pack 引入額外 toolchain 需求，提高貢獻門檻] → README 提供安裝步驟、`.nvmrc` 鎖定 Node 版本、`rust-toolchain.toml` 鎖定 Rust 版本；CI 自動安裝。
- [雙層 storage（session vs local）誤把瞬時資料寫入 local 會吃 quota] → 在 `src/shared/storage.ts` 提供明確區隔的 `sessionStore` 與 `persistentStore` 兩個介面：(1) 介面以 TypeScript discriminated key union 約束允許寫入的 key（compile-time 阻擋誤用）；(2) runtime 違規寫入**在所有 build（含 production）一律 `throw new TypeError(...)`**，禁止只在 development build 觸發 assertion——production 必須一樣會炸出來，否則 quota 還是會被吃光。
- [跨 model 接續時，新 model 可能對前一個 model 的決策有不同見解，導致設計漂移] → design.md 明文要求 apply 階段不得推翻已記錄之 Decisions；如需推翻，必須改寫 design.md 並重新跑 `/spectra-audit`。
- [Service worker 喚醒 latency 可能影響首次訊息回應] → 在 popup 端對首次訊息設 timeout 與 retry；訊息處理器 hydrate 完成前佇列訊息。
- [Vitest 在 Chrome Extension API 模擬上依賴 mock] → 透過 `@vitest/web-worker` 或自寫 `chrome` global mock，僅覆蓋 shared utils 與訊息協定，避免依賴實際 chrome.* API。
- [移除 in-tree 第三方套件改用 npm，可能引入版本漂移] → `package.json` 鎖定 minor 版本範圍並提交 `package-lock.json`。
- [Stage 5 scope narrowed → spec capability `wasm-instrumentation` 中「Legacy WAIL removed」requirement 從 binary 條件改為 entry-point-scoped 條件] → spec.md 對應 requirement 改名為「Legacy WAIL high-level entry-point removed」（見 §Implementation Contract §Acceptance criteria）；完整 WAIL 移除需 `harden-cetus-runtime` change 統一處理 init／disassembler／assembler 的 WAIL low-level 依賴，估 5–10 工作天，與安全債務 S-1..S-7 一併解決有 scope synergy。

## Future Work

本 change 完成後，仍有若干面向需獨立的後續 spectra changes 處理。以下為建議草案，每條註明 trigger（什麼時候應該開）、scope（解決哪些 `docs/security-debt.md` 條目或本 design.md §Non-Goals／§Scope boundaries Out of scope 條目）、估計工作量、與其他 change 的依賴。

#### FW-1 `harden-cetus-runtime`【高優先級／安全】

- Trigger：本 change archive 後立即開。
- Scope：
  - S-1 (Critical)：移除或閘門化 `new Function()` patch callback
  - S-2 (Critical)：popup／devtools `innerHTML` 改 `textContent` + `createElement`
  - S-3 (Critical)：content script `<script>.innerHTML = code` 改 message-passing
  - S-4 (High)：移除 CSP `style-src 'unsafe-inline'`
  - S-5 (High)：callback 字串加長度／特徵驗證
  - S-6 (Medium)：patch HMAC-SHA256 簽章
  - S-7 (Low)：patch 版本 schema 驗證（`zod` 或同等）
  - S-9 (Medium)：content-script in-page 注入鏈重設計
  - S-10 (Medium)：`init.ts`／`disassembler`／`assembler` 的 WAIL low-level 依賴重寫（採選項 a「Rust crate 擴充 low-level API」或選項 b「init.ts 整段搬進 Rust」，詳見 `docs/security-debt.md` S-10 後續建議）
  - 6 個 deferred `// @ts-nocheck` 檔型別化（task 5.4 例外清單）
- 估計工作量：15–25 工作天（最大宗為 S-10 選項 b 的 1300→2500 行 Rust 改寫）。
- 依賴：本 change（`modernize-chrome-extension-mv3`）必須先 archive。
- 拆分建議：scope 偏大，**建議真正 propose 前先 `/spectra-discuss` 釐清拆法**（候選拆法：`harden-cetus-runtime-injection` 處理 S-1／S-3／S-5／S-9，`harden-cetus-runtime-wail` 處理 S-10 與型別化；S-2／S-4／S-6／S-7 散項依需要插入）。

#### FW-2 `upgrade-thirdparty`【中優先級／維護性】

- Trigger：FW-1 後或並行。
- Scope：S-8——`blissfuljs`／`prismjs`／`stacktrace-js` 改 npm；`prism-live` 處理（沒 npm package 對應，需 vendor 或找替代）；移除 `extension/thirdparty/`、`content/thirdparty/`。
- 估計工作量：3–5 工作天（測試 popup 語法高亮、disassembler／assembler 行為不變為主要工時）。
- 依賴：FW-1 之後做較佳（先解 S-10 的話 disassembler／assembler 可能改用 `prismjs` 純高亮）。
- 觸發條件之一：上游 Prism 1.30 或 Bliss 出 CVE 時應提前。

#### FW-3 `firefox-mv3-port`【低優先級／平台支援】

- Trigger：使用者明確要 Firefox 支援，或 Chrome 政策再次變動威脅 MV3。
- Scope：本 design.md §Non-Goals 明文 defer 的「Firefox MV3 / MV2 雙清單」；`browser` ↔ `chrome` API surface 雙向化（目前 `src/popup/wail-stubs.ts` 的 polyfill 只是 chrome → browser 單向）。
- 估計工作量：5–8 工作天。
- 依賴：FW-1 完成後較容易（callback 機制重設計後，跨瀏覽器差異最大宗已處理）。

#### FW-4 `rustify-cetus-core`【中優先級／效能與正確性】

- Trigger：FW-1 之後（先把安全做好再優化）。
- Scope：本 design.md §Non-Goals 明文 defer 的「memory search 改 Rust、disassembly 改 Rust」。
- 估計工作量：10–15 工作天。
- 依賴：FW-1（搬移 init.ts 邏輯時順手）；與 FW-2 互不干擾。
- 拆分建議：可拆為 `rustify-memory-search` 與 `rustify-disassembly`。

#### FW-5 `cetus-e2e-tests`【中優先級／品質保障】

- Trigger：本 change 完成 Stage 6 acceptance 之後立即。
- Scope：本 design.md §Non-Goals 明文 defer 的「完整 E2E（Puppeteer／Playwright）整合測試」。
- 估計工作量：4–6 工作天。
- 依賴：本 change 完成；`.mcp.json` 的 `cetus-chrome` 設定可作為 E2E 啟動範本。

#### FW-6 `release-cws-upload`【低優先級／發布】

- Trigger：v2.0.0 行為穩定（FW-1 完成）後評估。
- Scope：Chrome Web Store／AMO 上架流程（manifest signing、icon／store-listing 準備、CI 自動產 `.zip` artifact）。
- 估計工作量：2–3 工作天。
- 依賴：本 change v2.0.0 release 完成、FW-1 安全強化完成（CWS 審查會關注 S-1..S-7）。

#### FW-7 `cetus-ai-assist`【探索性／待產品評估】

- Trigger：使用者明確需求。
- Scope：本 design.md §Non-Goals 明文 defer 的「AI／LLM 整合（Claude／OpenAI API）」。
- 估計工作量：未估（需先 brainstorm spec）。
- 依賴：FW-1 完成（callback 安全模型釐清後才適合接 LLM-generated code）。

#### FW-8 `migrate-vendored-wail`【條件性／工程衛生】

- Trigger：S-10 持續存在且 submodule URL `github.com/Qwokka/wail.min.js` 變得不可用時。
- Scope：把 `shared/wail.min.js` submodule 內容 vendor 進 `vendor/wail.min.js/`（直接 commit 進主 repo），脫離對外部 GitHub repo 的依賴；本身不解 S-10（wail.min.js 還在用），但消除 submodule clone 失敗的長期風險。
- 估計工作量：0.5 工作天。
- 依賴：無；可隨時做。如 FW-1 採選項 b（init.ts 整段搬 Rust）則 FW-8 變得不必要。

#### 排序總覽（建議）

```
本 change (modernize-chrome-extension-mv3)
        ↓
   FW-1 harden-cetus-runtime       ← 最高優先；scope 偏大可拆 2 個（propose 前先 /spectra-discuss）
        ↓
   ┌────┴────┬─────────────┬─────────┐
   ↓         ↓             ↓         ↓
 FW-2     FW-3           FW-4      FW-5
upgrade  firefox-port  rustify-core e2e-tests
   ↓                     ↓
   └────────┬────────────┘
            ↓
        FW-6 release-cws-upload
```

FW-7（AI assist）與 FW-8（vendor wail）依需求並行插入。
