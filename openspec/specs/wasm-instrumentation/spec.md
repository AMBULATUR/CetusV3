# wasm-instrumentation Specification

## Purpose

TBD - created by archiving change 'modernize-chrome-extension-mv3'. Update Purpose after archive.

## Requirements

### Requirement: cetus-wail Rust crate

The repository SHALL contain a Rust crate at `crates/cetus-wail` that compiles to WebAssembly via `wasm-pack --target web`; the crate SHALL replace the legacy `shared/wail.min.js` for the high-level binary instrumentation entry point invoked from `src/content/cetus.ts` (patch application and WAIL parser construction at line 531). Low-level WAIL usage in `src/content/init.ts`, `src/popup/libs/assembler.ts`, and `src/popup/libs/disassembler.ts` (covering `WailParser`, `BufferReader`, opcode constants, and helper functions such as `VarUint32`) is intentionally retained and deferred to a follow-up change `harden-cetus-runtime` (see `docs/security-debt.md` S-10 and design.md §Decisions "Scope narrowing discovered during Stage 4 → 5 transition").

#### Scenario: wasm-pack build produces a loadable ESM bundle

- **WHEN** `wasm-pack build crates/cetus-wail --target web` is executed in a clean working tree
- **THEN** the build SHALL exit successfully, SHALL emit a `pkg/` directory containing a `.wasm` binary plus an ESM `.js` glue file, and the ESM file SHALL be importable from TypeScript without runtime errors


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
### Requirement: Watchpoint instrumentation correctness

The crate SHALL expose a function whose role is to insert read / write / freeze watchpoints into a parsed WebAssembly module at a caller-specified address with caller-specified flag bits, returning a new module byte vector that passes `WebAssembly.validate` and emits watchpoint notifications consistent with the flag semantics. Byte-equivalent fixture parity with v1.05 `wail.min.js` output is NOT required for this change (see design.md §Decisions "Scope narrowing discovered during Stage 4 → 5 transition" — Rust-side unit tests use synthesised hand-written WASM modules rather than v1.05 reference outputs).

#### Scenario: write-watchpoint fires when target address is written

- **WHEN** a watchpoint with write flag is inserted at address `A` in a synthesised module and the resulting module is instantiated and executes a store to `A`
- **THEN** the instrumented module SHALL pass `WebAssembly.validate` and SHALL emit at least one watchpoint notification matching the write-flag semantics


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
### Requirement: Function patch application

The crate SHALL expose a function whose role is to replace a function body identified by its function index with a caller-supplied byte sequence, returning a new module byte vector; the function MUST reject input that fails WebAssembly validation rather than emit a corrupted module.

#### Scenario: patched module validates and runs

- **WHEN** a valid replacement body is applied to function index `N` of a valid module
- **THEN** the returned bytes SHALL pass `WebAssembly.validate` in the browser, and instantiating it SHALL execute the new body for calls to function `N`

#### Scenario: invalid patch is rejected

- **WHEN** a replacement body that fails WebAssembly validation is supplied
- **THEN** the crate SHALL return an error result and SHALL NOT emit a partially modified module


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
### Requirement: Rust-side unit tests

The crate SHALL ship unit tests runnable via `cargo test --manifest-path crates/cetus-wail/Cargo.toml`, covering at minimum: watchpoint insertion at a known address, function patching of a valid body, and rejection of an invalid patch. Test fixtures SHALL be synthesised hand-written WASM modules; the suite SHALL NOT depend on running v1.05 `wail.min.js` to generate reference outputs (see design.md §Decisions "Scope narrowing discovered during Stage 4 → 5 transition").

#### Scenario: cargo test passes on a clean checkout

- **WHEN** `cargo test --manifest-path crates/cetus-wail/Cargo.toml` runs against a freshly cloned repository
- **THEN** the suite SHALL exit successfully with all listed test cases passing, using only synthesised in-test WASM fixtures


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
### Requirement: Legacy WAIL high-level entry-point removed

After this change ships, `src/content/cetus.ts` SHALL NOT import or reference `WailParser`; the only high-level binary instrumentation entry available to `cetus.ts` SHALL be the `cetus-wail` Rust output. Low-level WAIL usage (the `WailParser` class, `BufferReader` class, opcode constants, and helpers) in `src/content/init.ts`, `src/popup/libs/assembler.ts`, and `src/popup/libs/disassembler.ts` is intentionally retained pending the follow-up change `harden-cetus-runtime`; consequently `shared/wail.min.js/` SHALL remain present in the repository tree as a git submodule (see `docs/security-debt.md` S-10).

#### Scenario: cetus.ts no longer references WailParser

- **WHEN** `grep -n WailParser src/content/cetus.ts` is run on the post-change tree
- **THEN** the grep SHALL produce no matches

#### Scenario: submodule retained for low-level callers

- **WHEN** `git submodule status shared/wail.min.js` is run on the post-change tree
- **THEN** the submodule SHALL still be registered (entry present in `.gitmodules` and `git submodule status` lists `shared/wail.min.js` with its pinned commit hash); the retention is documented in `docs/security-debt.md` S-10

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