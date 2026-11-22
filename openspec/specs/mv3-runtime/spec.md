# mv3-runtime Specification

## Purpose

TBD - created by archiving change 'modernize-chrome-extension-mv3'. Update Purpose after archive.

## Requirements

### Requirement: Manifest V3 declaration

The extension SHALL declare `manifest_version: 3` and SHALL NOT include any Manifest V2 only fields (such as `background.page`, `background.persistent`, `browser_action`, or top-level `content_security_policy` strings).

#### Scenario: manifest is loadable on current Chrome

- **WHEN** the built `dist/` directory is loaded via Chrome's "Load unpacked" with Chrome ≥ 120
- **THEN** the browser SHALL accept the manifest without errors and SHALL display the extension toolbar icon

##### Example: required manifest fields

| Field | Required value |
| ----- | -------------- |
| `manifest_version` | `3` |
| `background.service_worker` | string pointing to compiled service worker entry |
| `background.type` | `"module"` |
| `action` | object (replaces `browser_action`) |
| `host_permissions` | array (host patterns moved out of `permissions`) |
| `content_security_policy` | object with `extension_pages` key |
| `web_accessible_resources` | array of `{ resources, matches }` objects |


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
### Requirement: Service worker entry point

The background script SHALL be a service worker, MUST be registered through `background.service_worker` in the manifest, and SHALL be authored as an ES module so it can `import` other modules directly.

#### Scenario: service worker registers and survives a stop / restart

- **WHEN** the extension is installed and the user opens Chrome DevTools → Application → Service Workers and clicks "Stop" on the Cetus worker
- **THEN** the worker SHALL be in the stopped state, and the next message sent from popup or content script SHALL wake the worker, which SHALL respond without uncaught errors


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
### Requirement: Typed message protocol

All cross-context messages exchanged between background, content scripts, popup, devtools panel, and options page SHALL be expressed as a TypeScript discriminated union keyed by a string `type` field, and every sender and receiver SHALL exhaustively handle the union (verified at compile time via an `assertNever` helper).

#### Scenario: receiver rejects unknown message types

- **WHEN** a message arrives whose `type` is not a member of the declared union
- **THEN** the receiver SHALL log the offending message and SHALL NOT mutate any instance state, and the build SHALL refuse to compile if any handler omits a case from the union


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
### Requirement: Action and devtools surfaces preserved

The extension SHALL preserve the existing user surfaces — toolbar popup, DevTools panel labeled "Cetus", and options page — under Manifest V3 equivalents (`action.default_popup`, `devtools_page`, `options_ui`).

#### Scenario: popup and devtools panel still open

- **WHEN** the user clicks the Cetus toolbar icon
- **THEN** the popup HTML SHALL load and SHALL display the same primary tabs (Search, Bookmarks, Patches, Memory Viewer, Speedhack, Stack Traces) as version 1.05

- **WHEN** the user opens Chrome DevTools on a page that has loaded a WebAssembly module
- **THEN** a panel named "Cetus" SHALL be available and SHALL load without errors

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