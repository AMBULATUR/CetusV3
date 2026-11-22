# state-persistence Specification

## Purpose

TBD - created by archiving change 'modernize-chrome-extension-mv3'. Update Purpose after archive.

## Requirements

### Requirement: Two-tier storage separation

The extension SHALL split persisted state into two tiers: a session tier backed by `chrome.storage.session` for runtime / volatile data that MUST NOT outlive the browser process, and a persistent tier backed by `chrome.storage.local` for user-configured data that MUST survive a browser restart.

#### Scenario: persistent tier accepts only configuration data

- **WHEN** any code writes to the persistent tier
- **THEN** the value SHALL belong to the set { `bookmarks`, `watchpoints` configuration entries, `patchForm` patches saved by the user, `speedhack.multiplier`, options-page settings }, and writes that include `memoryViewer.memData`, `searchForm.results`, `stringForm.results`, or `stackTraces` SHALL fail a runtime assertion in development builds

##### Example: data routing

| Data | Tier | Reason |
| ---- | ---- | ------ |
| `bookmarks` | persistent | user wants to keep across browser restarts |
| `watchpoints` configuration | persistent | matches bookmarks lifetime |
| `patchForm` saved patches | persistent | re-applying after restart |
| `speedhack.multiplier` | persistent | user preference |
| `stackTraces` | session | bound to current debug run |
| `memoryViewer.memData` | session | large volatile snapshot |
| `searchForm.results` | session | recomputed per session |
| `symbols` | session | re-extracted on WASM load |


<!-- @trace
source: modernize-chrome-extension-mv3
updated: 2026-05-17
code:
  - src/popup/view.ts
  - .nvmrc
  - crates/cetus-wail/src/watchpoint.rs
  - extension/popupview.html
  - src/popup/wail-stubs.ts
  - src/shared/messages.ts
  - src/shared/bigint-json.ts
  - docs/security-debt.md
  - extension/background.html
  - src/shared/storage.ts
  - README.md
  - crates/cetus-wail/src/rewrite.rs
  - extension/libs/navigation.js
  - .github/dependabot.yml
  - src/content/cetus.ts
  - src/devtools/devtools.ts
  - src/types/globals.d.ts
  - extension/view.js
  - extension/background.js
  - crates/cetus-wail/src/error.rs
  - shared/contentutils.js
  - .mcp.json
  - .github/workflows/CI.yml
  - docs/handoff-task-5.5.md
  - extension/extension.js
  - extension/options.html
  - rust-toolchain.toml
  - src/popup/libs/assembler.ts
  - src/popup/libs/disassembler.ts
  - src/options/index.ts
  - src/popup/index.ts
  - shared/utils.js
  - src/options/options.html
  - src/content/content.ts
  - src/shared/memory.ts
  - src/popup/popup.html
  - CLAUDE.md
  - src/popup/libs/theme.ts
  - src/shared/format.ts
  - src/popup/libs/navigation.ts
  - src/background/instances.ts
  - src/shared/contentutils.ts
  - extension/devtools.html
  - crates/cetus-wail/src/list.rs
  - .spectra.yaml
  - extension/libs/patch.js
  - CHANGELOG.md
  - extension/optionspage.js
  - manifest.json
  - crates/cetus-wail/src/fixtures.rs
  - src/background/index.ts
  - crates/cetus-wail/src/patch.rs
  - src/background/router.ts
  - src/options/optionspage.ts
  - crates/cetus-wail/src/lib.rs
  - src/shared/utils.ts
  - tsconfig.json
  - package.json
  - src/content/init.ts
  - docs/progress.md
  - extension/libs/disassembler.js
  - crates/cetus-wail/Cargo.toml
  - vite.config.ts
  - src/popup/extension.ts
  - extension/devpanelview.html
  - src/popup/libs/patch.ts
  - extension/devtools.js
  - scripts/_gen-globals.py
  - extension/libs/theme.js
  - src/devtools/panel.html
  - scripts/retrofit-types.mjs
  - src/devtools/devtools.html
  - src/shared/instance-data.ts
  - extension/libs/assembler.js
tests:
  - tests/background-hydration.test.ts
  - tests/storage.test.ts
  - tests/bigint-json.test.ts
  - tests/format.test.ts
  - tests/instance-restore.test.ts
  - tests/messages.test.ts
  - tests/instance-data.test.ts
  - crates/cetus-wail/tests/integration.rs
  - tests/memory.test.ts
-->

---
### Requirement: InstanceData serialization round-trip

`InstanceData` SHALL be serializable through a single helper pair (`serializeInstanceData` / `deserializeInstanceData`) that preserves all fields defined in the v1.05 in-memory shape (`initialized`, `url`, `bookmarks`, `watchpoints`, `symbols`, `stackTraces`, `searchForm`, `stringForm`, `patchForm`, `speedhack`, `memoryViewer`, `currentTab`) and SHALL round-trip `BigInt` values without loss.

#### Scenario: round-trip preserves BigInt watch values

- **WHEN** an `InstanceData` containing a watch value of `BigInt("0x7fffffffffffffff")` is serialized and immediately deserialized
- **THEN** the resulting object SHALL be structurally equal to the input, including the exact `BigInt` value


<!-- @trace
source: modernize-chrome-extension-mv3
updated: 2026-05-17
code:
  - src/popup/view.ts
  - .nvmrc
  - crates/cetus-wail/src/watchpoint.rs
  - extension/popupview.html
  - src/popup/wail-stubs.ts
  - src/shared/messages.ts
  - src/shared/bigint-json.ts
  - docs/security-debt.md
  - extension/background.html
  - src/shared/storage.ts
  - README.md
  - crates/cetus-wail/src/rewrite.rs
  - extension/libs/navigation.js
  - .github/dependabot.yml
  - src/content/cetus.ts
  - src/devtools/devtools.ts
  - src/types/globals.d.ts
  - extension/view.js
  - extension/background.js
  - crates/cetus-wail/src/error.rs
  - shared/contentutils.js
  - .mcp.json
  - .github/workflows/CI.yml
  - docs/handoff-task-5.5.md
  - extension/extension.js
  - extension/options.html
  - rust-toolchain.toml
  - src/popup/libs/assembler.ts
  - src/popup/libs/disassembler.ts
  - src/options/index.ts
  - src/popup/index.ts
  - shared/utils.js
  - src/options/options.html
  - src/content/content.ts
  - src/shared/memory.ts
  - src/popup/popup.html
  - CLAUDE.md
  - src/popup/libs/theme.ts
  - src/shared/format.ts
  - src/popup/libs/navigation.ts
  - src/background/instances.ts
  - src/shared/contentutils.ts
  - extension/devtools.html
  - crates/cetus-wail/src/list.rs
  - .spectra.yaml
  - extension/libs/patch.js
  - CHANGELOG.md
  - extension/optionspage.js
  - manifest.json
  - crates/cetus-wail/src/fixtures.rs
  - src/background/index.ts
  - crates/cetus-wail/src/patch.rs
  - src/background/router.ts
  - src/options/optionspage.ts
  - crates/cetus-wail/src/lib.rs
  - src/shared/utils.ts
  - tsconfig.json
  - package.json
  - src/content/init.ts
  - docs/progress.md
  - extension/libs/disassembler.js
  - crates/cetus-wail/Cargo.toml
  - vite.config.ts
  - src/popup/extension.ts
  - extension/devpanelview.html
  - src/popup/libs/patch.ts
  - extension/devtools.js
  - scripts/_gen-globals.py
  - extension/libs/theme.js
  - src/devtools/panel.html
  - scripts/retrofit-types.mjs
  - src/devtools/devtools.html
  - src/shared/instance-data.ts
  - extension/libs/assembler.js
tests:
  - tests/background-hydration.test.ts
  - tests/storage.test.ts
  - tests/bigint-json.test.ts
  - tests/format.test.ts
  - tests/instance-restore.test.ts
  - tests/messages.test.ts
  - tests/instance-data.test.ts
  - crates/cetus-wail/tests/integration.rs
  - tests/memory.test.ts
-->

---
### Requirement: Hydration before message handling

The background service worker SHALL hydrate any required `InstanceData` from the storage tiers before mutating it in response to an incoming message; messages arriving while hydration is still in flight SHALL be queued and processed in arrival order once hydration completes.

#### Scenario: worker restart preserves user state

- **WHEN** the service worker is stopped by Chrome and a popup sends an `updateBookmarks` message that wakes it
- **THEN** the worker SHALL first hydrate `InstanceData` from storage, SHALL THEN apply the bookmark update, and SHALL respond to the popup with a state matching the user's pre-stop bookmarks plus the new entry


<!-- @trace
source: modernize-chrome-extension-mv3
updated: 2026-05-17
code:
  - src/popup/view.ts
  - .nvmrc
  - crates/cetus-wail/src/watchpoint.rs
  - extension/popupview.html
  - src/popup/wail-stubs.ts
  - src/shared/messages.ts
  - src/shared/bigint-json.ts
  - docs/security-debt.md
  - extension/background.html
  - src/shared/storage.ts
  - README.md
  - crates/cetus-wail/src/rewrite.rs
  - extension/libs/navigation.js
  - .github/dependabot.yml
  - src/content/cetus.ts
  - src/devtools/devtools.ts
  - src/types/globals.d.ts
  - extension/view.js
  - extension/background.js
  - crates/cetus-wail/src/error.rs
  - shared/contentutils.js
  - .mcp.json
  - .github/workflows/CI.yml
  - docs/handoff-task-5.5.md
  - extension/extension.js
  - extension/options.html
  - rust-toolchain.toml
  - src/popup/libs/assembler.ts
  - src/popup/libs/disassembler.ts
  - src/options/index.ts
  - src/popup/index.ts
  - shared/utils.js
  - src/options/options.html
  - src/content/content.ts
  - src/shared/memory.ts
  - src/popup/popup.html
  - CLAUDE.md
  - src/popup/libs/theme.ts
  - src/shared/format.ts
  - src/popup/libs/navigation.ts
  - src/background/instances.ts
  - src/shared/contentutils.ts
  - extension/devtools.html
  - crates/cetus-wail/src/list.rs
  - .spectra.yaml
  - extension/libs/patch.js
  - CHANGELOG.md
  - extension/optionspage.js
  - manifest.json
  - crates/cetus-wail/src/fixtures.rs
  - src/background/index.ts
  - crates/cetus-wail/src/patch.rs
  - src/background/router.ts
  - src/options/optionspage.ts
  - crates/cetus-wail/src/lib.rs
  - src/shared/utils.ts
  - tsconfig.json
  - package.json
  - src/content/init.ts
  - docs/progress.md
  - extension/libs/disassembler.js
  - crates/cetus-wail/Cargo.toml
  - vite.config.ts
  - src/popup/extension.ts
  - extension/devpanelview.html
  - src/popup/libs/patch.ts
  - extension/devtools.js
  - scripts/_gen-globals.py
  - extension/libs/theme.js
  - src/devtools/panel.html
  - scripts/retrofit-types.mjs
  - src/devtools/devtools.html
  - src/shared/instance-data.ts
  - extension/libs/assembler.js
tests:
  - tests/background-hydration.test.ts
  - tests/storage.test.ts
  - tests/bigint-json.test.ts
  - tests/format.test.ts
  - tests/instance-restore.test.ts
  - tests/messages.test.ts
  - tests/instance-data.test.ts
  - crates/cetus-wail/tests/integration.rs
  - tests/memory.test.ts
-->

---
### Requirement: Cross-browser-session restoration

After the browser process exits and is restarted, the extension SHALL restore the persistent tier so the popup shows the user's previous bookmarks, watchpoint configuration entries, saved patches, and `speedhack.multiplier`; session-tier data MAY be empty.

#### Scenario: bookmarks survive browser restart

- **WHEN** the user adds three bookmarks, fully quits Chrome, and reopens Chrome to the same WebAssembly page
- **THEN** the popup SHALL display the same three bookmarks, and the corresponding watchpoint flags SHALL match their pre-restart values

<!-- @trace
source: modernize-chrome-extension-mv3
updated: 2026-05-17
code:
  - src/popup/view.ts
  - .nvmrc
  - crates/cetus-wail/src/watchpoint.rs
  - extension/popupview.html
  - src/popup/wail-stubs.ts
  - src/shared/messages.ts
  - src/shared/bigint-json.ts
  - docs/security-debt.md
  - extension/background.html
  - src/shared/storage.ts
  - README.md
  - crates/cetus-wail/src/rewrite.rs
  - extension/libs/navigation.js
  - .github/dependabot.yml
  - src/content/cetus.ts
  - src/devtools/devtools.ts
  - src/types/globals.d.ts
  - extension/view.js
  - extension/background.js
  - crates/cetus-wail/src/error.rs
  - shared/contentutils.js
  - .mcp.json
  - .github/workflows/CI.yml
  - docs/handoff-task-5.5.md
  - extension/extension.js
  - extension/options.html
  - rust-toolchain.toml
  - src/popup/libs/assembler.ts
  - src/popup/libs/disassembler.ts
  - src/options/index.ts
  - src/popup/index.ts
  - shared/utils.js
  - src/options/options.html
  - src/content/content.ts
  - src/shared/memory.ts
  - src/popup/popup.html
  - CLAUDE.md
  - src/popup/libs/theme.ts
  - src/shared/format.ts
  - src/popup/libs/navigation.ts
  - src/background/instances.ts
  - src/shared/contentutils.ts
  - extension/devtools.html
  - crates/cetus-wail/src/list.rs
  - .spectra.yaml
  - extension/libs/patch.js
  - CHANGELOG.md
  - extension/optionspage.js
  - manifest.json
  - crates/cetus-wail/src/fixtures.rs
  - src/background/index.ts
  - crates/cetus-wail/src/patch.rs
  - src/background/router.ts
  - src/options/optionspage.ts
  - crates/cetus-wail/src/lib.rs
  - src/shared/utils.ts
  - tsconfig.json
  - package.json
  - src/content/init.ts
  - docs/progress.md
  - extension/libs/disassembler.js
  - crates/cetus-wail/Cargo.toml
  - vite.config.ts
  - src/popup/extension.ts
  - extension/devpanelview.html
  - src/popup/libs/patch.ts
  - extension/devtools.js
  - scripts/_gen-globals.py
  - extension/libs/theme.js
  - src/devtools/panel.html
  - scripts/retrofit-types.mjs
  - src/devtools/devtools.html
  - src/shared/instance-data.ts
  - extension/libs/assembler.js
tests:
  - tests/background-hydration.test.ts
  - tests/storage.test.ts
  - tests/bigint-json.test.ts
  - tests/format.test.ts
  - tests/instance-restore.test.ts
  - tests/messages.test.ts
  - tests/instance-data.test.ts
  - crates/cetus-wail/tests/integration.rs
  - tests/memory.test.ts
-->