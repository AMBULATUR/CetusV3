# build-tooling Specification

## Purpose

TBD - created by archiving change 'modernize-chrome-extension-mv3'. Update Purpose after archive.

## Requirements

### Requirement: Node toolchain pinned

The repository SHALL declare a fixed Node.js major version through `.nvmrc` and SHALL list `engines.node` in `package.json` matching that version; both files MUST stay in sync.

#### Scenario: node version files agree

- **WHEN** a contributor reads `.nvmrc` and `package.json.engines.node`
- **THEN** both SHALL reference the same Node major version, and the version SHALL be `>=20`


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
### Requirement: Vite build produces loadable extension

The repository SHALL provide a Vite configuration using `@crxjs/vite-plugin` such that `npm run build` emits a `dist/` directory containing the compiled manifest, background service worker, content scripts, popup, devtools panel, and options page in shapes loadable by Chrome.

#### Scenario: clean build outputs a loadable dist

- **WHEN** a contributor runs `npm install && npm run build` against a clean working tree
- **THEN** the command SHALL exit successfully, `dist/manifest.json` SHALL exist with `manifest_version: 3`, and loading `dist/` via Chrome "Load unpacked" SHALL succeed without manifest or service-worker errors


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
### Requirement: TypeScript strict typecheck

The repository SHALL include a `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`, and `exactOptionalPropertyTypes: true`; `npm run typecheck` (or `npx tsc --noEmit`) SHALL succeed on the shipped source tree.

#### Scenario: strict typecheck passes

- **WHEN** `npx tsc --noEmit` is executed against the repository
- **THEN** the command SHALL exit with status `0` and SHALL NOT emit any diagnostics


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
### Requirement: Vitest unit suite

The repository SHALL include a Vitest unit-test suite runnable via `npm test`, covering at minimum: `InstanceData` serialize / deserialize round-trip, message discriminated-union exhaustiveness, `convertToI64` boundary values, and `bigintJsonParse` / `bigintJsonStringify` round-trip.

#### Scenario: npm test passes

- **WHEN** `npm test` is executed against a clean checkout after `npm install`
- **THEN** the command SHALL exit successfully and SHALL report all listed test cases as passing


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
### Requirement: wasm-pack integrated with build pipeline

The repository SHALL provide an `npm run wasm` script that invokes `wasm-pack build crates/cetus-wail --target web`, and the Vite build SHALL consume the resulting ESM output as a normal module import; the developer-facing instructions SHALL document the Rust toolchain prerequisites.

#### Scenario: npm-driven wasm rebuild

- **WHEN** a contributor modifies a Rust source under `crates/cetus-wail/` and runs `npm run wasm && npm run build`
- **THEN** the wasm bundle SHALL be regenerated, the Vite build SHALL pick up the new module, and the resulting `dist/` SHALL contain the updated WASM artifact


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
### Requirement: CI workflow updated

`.github/workflows/CI.yml` SHALL use `actions/checkout@v4`, `actions/setup-node@v4` pinned to the same Node major as `.nvmrc`, SHALL install the Rust toolchain (`dtolnay/rust-toolchain`), SHALL cache both npm and cargo, and SHALL run `npm install`, `npm run wasm`, `npm run build`, `npm run typecheck`, and `npm test` on every push and pull request.

#### Scenario: CI succeeds on a clean push

- **WHEN** a pull request is opened with no source changes other than the modernization itself
- **THEN** the CI workflow SHALL run all listed steps and SHALL report a green status with no skipped or failed jobs

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