# Cetus 現代化進度（spectra change: `modernize-chrome-extension-mv3`）

本檔為跨 AI session／跨 model 的 hand-off 檔。任何接續執行的 agent 必須先讀本檔，再參考
`openspec/changes/modernize-chrome-extension-mv3/{proposal,design,tasks}.md` 與
`openspec/changes/modernize-chrome-extension-mv3/specs/**/*.md` 取得完整脈絡。

---

## 1. Stage 勾選清單

> 已完成的 Stage 才能勾選。每個 Stage 都必須通過末尾的 `commit → /spectra-audit → commit`
> 流程後才算完成（見 §4 規約）。

- [x] **Stage 0 — Spectra hand-off 基礎建設** _(完成於 task 1.3 post-audit)_
- [x] **Stage 1 — Build tooling 引入** _(完成；package.json/.nvmrc/tsconfig/vite.config.ts/src/ 骨架；npm run build 與 npx tsc --noEmit 皆通過)_
- [x] **Stage 2 — Manifest V3 遷移**（manifest 改造 3.1–3.6 + task 3.7 acceptance）— **與 Stage 1 合併實作**：`@crxjs/vite-plugin@2.4.0` 拒絕 MV2 manifest，因此 Stage 2 manifest 改造（v3／service_worker／action／host_permissions／CSP object／web_accessible_resources object array／minimum_chrome_version=120）必須提前到 Stage 1 才能讓 `npm run build` 通過。Task 3.7（`#16`）已由 MCP `cetus-chrome` 在 2026-05-17 完成：Chrome 148 載入 `dist/` 為 ext id `icdoekjhkliljidpiokdanldkncpbcph` v2.0.0，無 manifest 錯誤；popup／devtools／options 三個 surface 皆開得起來；service worker 註冊成功；`chrome.runtime.id` 與 `chrome.storage` 可取用。Console 殘留的 `ERR_FILE_NOT_FOUND` 為 legacy HTML 內 classic `<script src>` 對未 bundle 的 `extension/{libs,thirdparty,view,extension,devtools,optionspage}.js`／`shared/{utils,contentutils,wail.min.js}` fetch 失敗，與 `npm run build` 警告一一對應，**屬於 task 5.5（module migration）範圍**，不阻擋 Stage 2 acceptance
- [x] **Stage 3 — Service worker 化與狀態持久化** _(完成；`src/shared/{instance-data,storage,messages}.ts` + `src/background/{router,instances,index}.ts`；26 tests pass，5 個測試檔案；`npx tsc --noEmit` 與 `npm run build` 均通過)_
- [x] **Stage 4 — TypeScript strict 化**（完成；43 tasks 中 29／43 done）
  - [x] 5.1／5.2／5.3：`src/shared/{format,memory,bigint-json}.ts` 拆檔
  - [x] 5.4：除 6 個 deferred 檔外，全部 `// @ts-nocheck` 已移除
  - [x] 5.5：module migration（HTML 搬 `src/`、popup/devtools panel/options entry 化、`Object.assign(globalThis,…)` bridge 取代 v1.05 classic-script 全域、`vite.config.ts` 註冊 panel.html 為 build input、刪除 17 個 popup-side legacy 檔；`content/` injection 鏈與 thirdparty 依 S-9／S-8 deferred）
  - [x] 5.6：Stage 4 收斂（pre-audit `7506443`、`/spectra-audit` PASS 0 finding）
- [x] **Stage 6 — 測試／CI／文件／版本**（完成；43／43 tasks done）
- [x] **Stage 5 — Rust WASM 取代 WAIL**（scope narrowed，路徑 3；完成）
  - [x] 6.1：`crates/cetus-wail/Cargo.toml` + `src/lib.rs` 骨架（`cdylib`+`rlib`、`wasm-bindgen`、`js-sys`、`wasmparser`、`wasm-encoder[wasmparser]`、`thiserror`；`rust-toolchain.toml` 鎖 1.94.0）
  - [x] 6.2：`instrument_watchpoint` 對 `i32.store`／`i32.load` 注入導向 `cetus.watchpoint` 進口的 conditional 呼叫；3 個 unit tests pass
  - [x] 6.3：`apply_patch` 取代指定 func body；輸出走 `wasmparser::validate`；invalid body → `InvalidPatchBody`；3 個 unit tests pass
  - [x] 6.4：`npm run wasm` 已存在於 `package.json`；vite.config.ts 新增 `cetus:expose-wail-globals` plugin；`dist/assets/cetus_wail_bg-*.wasm` 660 KB + ESM glue 6.96 KB
  - [x] 6.5：`src/content/cetus.ts` `_resolveFunctions` 改 `await import("../../crates/cetus-wail/pkg/cetus_wail.js")` + `listFunctionBodies`；`queryFunction` 升級為 async 並改用 promise chain；`src/popup/wail-stubs.ts` BufferReader stub 拆除（保留 `browser → chrome` polyfill）；`src/popup/index.ts` import 真實 `shared/wail.min.js/wail.min.js`，vite plugin 把 top-level `const`/`class`/`function` bridge 到 globalThis；MCP cetus-chrome 已驗證 popup 載入後 BufferReader/WailParser 都在 globalThis 上、無 stub error；`src/background/index.ts` 加 static import 把 cetus-wail glue 拉進 background bundle（避免 tree-shake）
  - [x] 6.6：`docs/security-debt.md` S-10 已就位（含選項 a/b/c）；`git submodule status shared/wail.min.js` 仍 list 該 submodule
  - [x] 6.7：`crates/cetus-wail/tests/integration.rs` 含 watchpoint 插入／apply_patch valid／apply_patch invalid 三個 integration tests；全部 pass
  - [x] 6.8：Stage 5 收斂（pre-audit／audit／post-audit 見 §2）

進度：7 / 7 Stage 完成（43 / 43 tasks done）。Stage 6 audit PASS（0 Critical／0 High；M-1／S-1 折入、L-1／L-2 標 future ops）。

---

## 2. 最近 git HEAD

| 欄位                | 值                                                                  |
| ------------------- | ------------------------------------------------------------------- |
| Stage 0 起          | `7f7b851b9200ca6d9c2214a98135f924484ec84e` _(原 v1.05 最後 commit)_ |
| Stage 0 pre-audit   | `10a55bb` — 🏗️ build: 引入 Spectra SDD workflow                     |
| Stage 0 post-audit  | `7445067` — 📝 docs(stage-0-post-audit): 折入 spectra-audit M1/M2/M3/L1 |
| Stage 1+2 pre-audit | `bacd0ed` — 🏗️ build(stage-1+2-pre-audit): 引入 Vite + TS toolchain 與 src/ TypeScript 骨架，並把 manifest MV3 改造捲入 |
| Stage 1+2 post-audit| `2d2b5c4` — 🔒 docs(stage-1+2-post-audit): 將 spectra-audit 7 條 finding 分類為繼承 v1.05 安全債務 |
| Stage 3 pre-audit   | `63bc590` — ✨ feat(stage-3-pre-audit): service worker 化、雙層 storage、訊息 discriminated union 與 storage-backed instance store |
| Stage 3 audit       | **PASS — 0 finding**（Stage 0 折入的 M1／M2／M3／L1 全數驗證為已正確實作；無 source 修改需求） |
| Stage 3 post-audit  | `a15b0fe` — ✅ docs(stage-3-post-audit): Stage 3 audit 0 finding，紀錄收斂並進入 Stage 4 |
| Stage 4 pre-audit   | `7506443` — ✨ feat(stage-4-pre-audit): 完成 Stage 4 TypeScript strict 化與 task 5.5 module migration |
| Stage 4 audit       | **PASS — 0 finding**（M1／M2／M3／L1 在 Stage 3 已折入；Stage 4 task 5.5 只動 popup HTML 入口與 globalThis bridge，未引入新 sharp edge；S-1..S-7 仍記錄於 docs/security-debt.md，本 change scope 外） |
| Stage 4 post-audit  | `f504e36` — ✅ docs(stage-4-post-audit): Stage 4 audit 0 finding，紀錄收斂並進入 Stage 5 |
| Stage 5 ingest      | `1ba2a4d` — 📝 docs(stage-5-scope-narrow): 路徑 3 scope narrow 決議 |
| Stage 5 pre-audit   | `849fede` — ✨ feat(stage-5-pre-audit): cetus-wail Rust crate 取代 wail.min.js 高階入口，並把真實 WAIL 接回 popup |
| Stage 5 audit       | **2 Critical + 2 High + 2 Medium + 2 Low + 1 Suggestion**（C-1 silent failure on cetus-wail error；C-2 wasm-pack init 未呼叫；H-1 `_resolveFunctions` 競爭；H-2 vite plugin regex fragile；M-2 watchpoint flags 未驗證；L-1 `apply_patch` body 無上限；L-2 JsError 缺結構化 code；M-1／S-Sug-1 deferred） |
| Stage 5 post-audit  | `b7d46a7` — 🔒 fix(stage-5-post-audit): 折入 spectra-audit C-1/C-2/H-1/H-2/M-2/L-1/L-2 findings |
| Stage 5 converge    | `a65bd5f` — 📝 docs(stage-5-converge): 更新 progress.md |
| Stage 6 pre-audit   | `20beac2` — 🏗️ build(stage-6-pre-audit): CI／README／CHANGELOG／CSP wasm-eval |
| Stage 6 audit       | **PASS（0 Critical／0 High）** — M-1 (CI 3rd-party action 浮動 tag)、L-1 (submodule recursive nested .gitmodules trust)、L-2 (wasm-pack 下載 wasm-bindgen-cli 未驗 checksum)、S-1 (CHANGELOG 揭露 S-1..S-7 太簡) |
| Stage 6 post-audit  | `a65db69` — 🔒 chore(stage-6-post-audit): 折入 M-1／S-1，L-1／L-2 加註 |

> 每完成一個 Stage，將 pre-audit 與 post-audit commit 的短 sha 填入本表，方便接續的 agent
> 用 `git log <sha>..HEAD` 比對該 Stage 的全部改動。

---

## 3. 下一個 Stage 入口

> 接續的 agent 從這裡開始：

**目前位置**：Stage 0／1／2／3／4／5／6 皆已完成（43／43 tasks done）。Change 已可 archive。

**下一步**：`/spectra-archive modernize-chrome-extension-mv3` 把 change 從 `openspec/changes/`
搬到 `openspec/changes/archive/`；同時請於 `openspec/specs/` 內把 capability spec 更新為
v2.0 行為（build-tooling／mv3-runtime／state-persistence／wasm-instrumentation）。

**建議的後續 changes**（per design.md §Future Work 與 docs/security-debt.md）：

1. `harden-cetus-runtime`（FW-1，高優先）— 處理 S-1..S-7、S-9、S-10；估 15–25 工作天，scope 偏大可拆兩個（propose 前先 `/spectra-discuss`）。
2. `upgrade-thirdparty`（FW-2）— S-8 第三方 npm 化。
3. `cetus-e2e-tests`（FW-5）— 補完整 E2E acceptance，回填本 change 因 S-9 deferred 而無法覆蓋的 Cetus 101 流程。

## 4. Stage 6 acceptance — MCP cetus-chrome 驗證紀錄（task 7.6）

在 Chrome 148（>= 120）載入 `dist/`（extension id `icdoekjhkliljidpiokdanldkncpbcph`），以
`mcp__cetus-chrome__evaluate_script` 對 background service worker（`sw-15`）與 popup 各執行
下列檢查，結果如下：

| 項目 | 結果 |
| --- | --- |
| Background SW 載入 | ✓ `globalThis.cetusWail.ready` 解析為 `{instrumentWatchpoint, applyPatch, listFunctionBodies}` 三個 function |
| WASM 真實執行 | ✓ `instrumentWatchpoint(bytes, 0x100, 0)` 在 SW 內成功拋出 `{ code: "invalid-flags", message: "invalid watchpoint flags 0x00: must be a non-zero subset of FLAG_READ\|FLAG_WRITE\|FLAG_FREEZE (0x07)" }`（L-2 結構化 error code 驗證；同時驗證 M-2 flags validation 路徑） |
| Popup 載入 | ✓ 唯一 console 訊息為 benign `runtime.lastError: Could not establish connection`（chrome.runtime 訊息路由 noise，與 Stage 4 一致） |
| WAIL globals on popup `globalThis` | ✓ `BufferReader=function`／`WailParser=function`／`OP_I32_STORE=number`／`OP_I32_LOAD=number`／`SECTION_CODE=number`（vite `cetus:expose-wail-globals` plugin 正確 bridge） |
| `browser → chrome` polyfill | ✓ `globalThis.browser=object` |
| Persistent storage round-trip | ✓ `chrome.storage.local.set({bookmarks: ...})` → `get("bookmarks")` 取回完整資料 |
| Session storage round-trip | ✓ `chrome.storage.session` 可用；`set({stackTraces: ...})` → `get("stackTraces")` round-trip 成功 |
| CSP `wasm-unsafe-eval` | ✓ task 7.6 期間補上 `manifest.json` `content_security_policy.extension_pages` 加入 `script-src 'self' 'wasm-unsafe-eval'`，否則 SW 內 `WebAssembly.instantiateStreaming` 會被 default `default-src 'self'` 擋下（為 audit C-3 等級的隱形 blocker，已在 task 7.6 順手修） |

**Cetus 101「Invincibility」流程（memory search／bookmark／watchpoint／stack trace／patch／speedhack）受 S-9 deferred 影響**：content-script 注入鏈仍指向 legacy `/content/cetus.js`／`/content/init.js`，
但 `dist/content/` 不存在（@crxjs 不 bundle web_accessible_resources 的 `.ts` 為 classic script）；
這些 page-side 功能要等 `harden-cetus-runtime` change 重寫注入鏈才能完整測試。task 7.6 acceptance
紀錄到「extension 自身可載入、storage 雙層 round-trip 正確、cetus-wail Rust API 端到端可用」這個
最大可驗證範圍，與本 change 的 §Scope boundaries 一致。

**Stage 5 scope narrowed（路徑 3，2026-05-17 決議）**：
Stage 5 只執行 `cetus.ts` 一處高階 WAIL 取代；`src/content/init.ts`（1300 行）／
`src/popup/libs/{assembler,disassembler}.ts` 對 WAIL low-level 依賴 defer 到
`harden-cetus-runtime`（FW-1；見 design.md §Future Work 與 `docs/security-debt.md` S-10）。
Rust crate 單元測試以**合成 WASM module** 為 fixture，**放棄** v1.05 byte-parity。
完整脈絡見 design.md §Decisions「Scope narrowing discovered during Stage 4 → 5 transition (2026-05-17)」
與 tasks.md 6.5／6.6／6.7 修訂條文。

**接續執行指引**：

1. 執行 `/spectra-apply modernize-chrome-extension-mv3`
2. 讀 `openspec/changes/modernize-chrome-extension-mv3/{design.md,tasks.md}` §Stage 5
3. **TDD discipline 生效**（`.spectra.yaml` `tdd: true`）：每個 Rust API 先寫 failing
   test，再實作；fixture 採**合成 WASM module**（不依賴 v1.05 `wail.min.js` reference output）
4. **CI 配套**：task 7.2 改寫 `.github/workflows/CI.yml` 時 `actions/checkout@v4` 必須加
   `with: submodules: recursive`，否則 popup runtime 會壞

**MCP 設定**：repo root 的 `.mcp.json` 已配置 `cetus-chrome` server，會自動載入 `dist/`
為 unpacked extension。新 session 啟動時需批准該 project MCP server。

**Stage 4 task 5.5 已完成（2026-05-17）**：所有 popup-side legacy HTML／JS 搬到 `src/`
並用 ES module 入口取代 classic `<script>` 串；MCP 驗證 popup／devtools panel／options
三 surface 載入無新 console error（僅剩 SW-connection 良性警告）；刪除 17 個檔、累積
減少 6,696 行。詳見 commit `7506443`。

**Stage 2 task 3.7 acceptance 已完成**：見 §1 Stage 2 條目註記。

### Stage 1+2 audit findings（已分類為繼承自 v1.05 的安全債務）

`/spectra-audit` 於 commit `bacd0ed` 回報 7 條 finding（3 Critical／2 High／1 Medium／1 Low），
全部都是 v1.05 既有行為（patch callback `new Function()`、popup `innerHTML`、CSP `'unsafe-inline'`
styles 等）。task 2.5 明文「保留原邏輯（不改行為）」、design.md 明文「不變更使用者操作流程」，
因此這些 finding 不屬於本 change scope。已寫入 `docs/security-debt.md` 留待後續
spectra change `harden-cetus-runtime` 處理。本檔不再重複列出條目。

### Stage 0 audit findings（已折入 design.md／tasks.md）

| ID  | Severity   | 重點摘要 | 折入位置 |
| --- | ---------- | -------- | -------- |
| M1  | Medium     | WASM patch 失敗必須以訊息上拋；TS 端不得 silently 把半改 module 餵給 `WebAssembly.instantiate` | `design.md` §Failure modes |
| M2  | Medium     | `sessionStore`／`persistentStore` 違規寫入須在**所有 build** throw `TypeError`，並加 TS 型別層 key union 約束 | `design.md` §Risks／tasks.md 4.2 |
| M3  | Medium     | `chrome.storage.session` 不可用時，session-only 欄位**不得** silently 寫入 persistent tier | `design.md` §Failure modes／tasks.md 4.5 |
| L1  | Low        | 訊息 handler runtime 必須有 default 分支：log 未知 type 且不變更 state；新增 `instrumentError` 變體 | `tasks.md` 4.4 |

---

## 4. Stage 驗證命令與通用規約

### 4.1 通用流程規約（每個 Stage 結尾共同）

**每個 Stage 結束都必須跑下列流程，且不得跳過任何步驟：**

```
git add -A
→ 呼叫 `/tw-emoji-commit` skill 取得 commit message
→ 自行執行 `git commit -m "<msg>"`（pre-audit commit）
→ 呼叫 `/spectra-audit` skill
→ 若有 Critical／Warning finding，修正後重複上述 add → message → commit（post-audit commit）
→ 若 audit 無 finding，可直接進入下個 Stage
→ 更新本 `docs/progress.md`：勾選 Stage 框、填入 §2 的 commit sha、更新 §3 的下一 Stage 入口
```

**兩條關鍵規則（不得違反）：**

1. **`/tw-emoji-commit` skill 只回 message，不自動 commit。** 執行者必須拿到 message 後**自行**
   執行 `git commit -m "<msg>"`。違規（自寫 message 繞過 skill）會在 `/spectra-audit` 階段
   被標記。
2. **每個 Stage 結尾必走 `commit → /spectra-audit → commit`。** Audit 未通過時不得進入下一個
   Stage；接續的 agent 看到本檔上一個 Stage 未勾選或 audit 未通過時，必須先補完，不得跳關。

### 4.2 各 Stage 驗證命令

| Stage | 驗證命令                                                                                                                                                                                                                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | `cat docs/progress.md` 列出四區塊；`grep tw-emoji-commit docs/progress.md && grep spectra-audit docs/progress.md` 各至少一筆；`git log --oneline -5` 含 Stage 0 pre-audit commit。                                                                                                          |
| 1     | `node -e "require('./package.json').engines.node"` 含 `20`；`jq '.scripts \| keys' package.json` 列 `dev`／`build`／`test`／`wasm`／`typecheck` 五項；`npm install && npm run build && ls dist/manifest.json`；`npx tsc --noEmit --showConfig` 列 strict 三旗標皆 true。                  |
| 2     | `jq '.manifest_version, .background, .action, .host_permissions, .web_accessible_resources, .content_security_policy, .minimum_chrome_version' dist/manifest.json` 結構正確；Chrome ≥ 120 載入 `dist/` 無 manifest 錯誤；popup／devtools panel 可開啟。                                  |
| 3     | `npm test` 中 `tests/instance-data.test.ts`／`tests/storage.test.ts`／`tests/messages.test.ts`／`tests/background-hydration.test.ts`／`tests/instance-restore.test.ts` 全綠；DevTools「Stop service worker」後重新觸發訊息行為正常；瀏覽器關閉重開後 bookmark／watchpoint 設定還原。       |
| 4     | `npx tsc --noEmit` 通過；`npm run build` 成功；`git ls-files \| grep -E '^(extension\|content\|shared)/.+\.js$'` 不再列出已搬遷檔；popup／devtools／options 可開啟。                                                                                                                          |
| 5     | `cargo build --manifest-path crates/cetus-wail/Cargo.toml --release` 成功；`cargo test --manifest-path crates/cetus-wail/Cargo.toml` 全綠；`npm run wasm && npm run build` 成功；`git ls-files \| grep wail.min.js` 無結果；`tests/instrumentation-parity.test.ts` 通過。               |
| 6     | `npm test`、`npm run typecheck`、`npm run build`、`cargo test` 皆通過；`jq -r '.version' manifest.json package.json` 皆 `2.0.0`；CI workflow 全綠；手動依 wiki tutorial「Cetus 101 - Invincibility」流程通過並寫入本檔；`spectra audit` 與 `spectra validate "modernize-chrome-extension-mv3"` 通過。 |

### 4.3 跨 Stage 不變式

無論在哪個 Stage，下列條件必須持續成立（任何 Stage 結束時跑這些檢查都必須通過）：

- `spectra audit` 無 Critical／Warning（Stage 結尾跑）。
- `git log --oneline -5` 可以看到本 Stage 的至少一筆 commit。
- `docs/progress.md`（本檔）的 §1 與 §2 與 git 狀態一致。

### 4.4 任何 task 描述含糊或與 design.md 的 Implementation Contract 衝突時

暫停並回報使用者；不得自行推翻 design.md 中既有的 Decisions（per design.md §跨 session／跨 model 工作流程）。
若必須修改 design.md，須改寫該 Decision 並重新跑 `/spectra-audit`。

---

## 附：本檔結構

| 區塊 | 內容                                                       |
| ---- | ---------------------------------------------------------- |
| §1   | Stage 0–6 勾選清單                                         |
| §2   | 最近 git HEAD（每 Stage pre/post-audit commit sha）         |
| §3   | 下一個 Stage 入口（檔案位置、起始 task id）                 |
| §4   | Stage 驗證命令與通用規約（含 `/tw-emoji-commit`、`/spectra-audit` 兩條規則） |
