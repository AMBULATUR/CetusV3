## ADDED Requirements

### Requirement: cetus-wail Rust crate

The repository SHALL contain a Rust crate at `crates/cetus-wail` that compiles to WebAssembly via `wasm-pack --target web`; the crate SHALL replace the legacy `shared/wail.min.js` for the high-level binary instrumentation entry point invoked from `src/content/cetus.ts` (patch application and WAIL parser construction at line 531). Low-level WAIL usage in `src/content/init.ts`, `src/popup/libs/assembler.ts`, and `src/popup/libs/disassembler.ts` (covering `WailParser`, `BufferReader`, opcode constants, and helper functions such as `VarUint32`) is intentionally retained and deferred to a follow-up change `harden-cetus-runtime` (see `docs/security-debt.md` S-10 and design.md §Decisions "Scope narrowing discovered during Stage 4 → 5 transition").

#### Scenario: wasm-pack build produces a loadable ESM bundle

- **WHEN** `wasm-pack build crates/cetus-wail --target web` is executed in a clean working tree
- **THEN** the build SHALL exit successfully, SHALL emit a `pkg/` directory containing a `.wasm` binary plus an ESM `.js` glue file, and the ESM file SHALL be importable from TypeScript without runtime errors

### Requirement: Watchpoint instrumentation correctness

The crate SHALL expose a function whose role is to insert read / write / freeze watchpoints into a parsed WebAssembly module at a caller-specified address with caller-specified flag bits, returning a new module byte vector that passes `WebAssembly.validate` and emits watchpoint notifications consistent with the flag semantics. Byte-equivalent fixture parity with v1.05 `wail.min.js` output is NOT required for this change (see design.md §Decisions "Scope narrowing discovered during Stage 4 → 5 transition" — Rust-side unit tests use synthesised hand-written WASM modules rather than v1.05 reference outputs).

#### Scenario: write-watchpoint fires when target address is written

- **WHEN** a watchpoint with write flag is inserted at address `A` in a synthesised module and the resulting module is instantiated and executes a store to `A`
- **THEN** the instrumented module SHALL pass `WebAssembly.validate` and SHALL emit at least one watchpoint notification matching the write-flag semantics

### Requirement: Function patch application

The crate SHALL expose a function whose role is to replace a function body identified by its function index with a caller-supplied byte sequence, returning a new module byte vector; the function MUST reject input that fails WebAssembly validation rather than emit a corrupted module.

#### Scenario: patched module validates and runs

- **WHEN** a valid replacement body is applied to function index `N` of a valid module
- **THEN** the returned bytes SHALL pass `WebAssembly.validate` in the browser, and instantiating it SHALL execute the new body for calls to function `N`

#### Scenario: invalid patch is rejected

- **WHEN** a replacement body that fails WebAssembly validation is supplied
- **THEN** the crate SHALL return an error result and SHALL NOT emit a partially modified module

### Requirement: Rust-side unit tests

The crate SHALL ship unit tests runnable via `cargo test --manifest-path crates/cetus-wail/Cargo.toml`, covering at minimum: watchpoint insertion at a known address, function patching of a valid body, and rejection of an invalid patch. Test fixtures SHALL be synthesised hand-written WASM modules; the suite SHALL NOT depend on running v1.05 `wail.min.js` to generate reference outputs (see design.md §Decisions "Scope narrowing discovered during Stage 4 → 5 transition").

#### Scenario: cargo test passes on a clean checkout

- **WHEN** `cargo test --manifest-path crates/cetus-wail/Cargo.toml` runs against a freshly cloned repository
- **THEN** the suite SHALL exit successfully with all listed test cases passing, using only synthesised in-test WASM fixtures

### Requirement: Legacy WAIL high-level entry-point removed

After this change ships, `src/content/cetus.ts` SHALL NOT import or reference `WailParser`; the only high-level binary instrumentation entry available to `cetus.ts` SHALL be the `cetus-wail` Rust output. Low-level WAIL usage (the `WailParser` class, `BufferReader` class, opcode constants, and helpers) in `src/content/init.ts`, `src/popup/libs/assembler.ts`, and `src/popup/libs/disassembler.ts` is intentionally retained pending the follow-up change `harden-cetus-runtime`; consequently `shared/wail.min.js/` SHALL remain present in the repository tree as a git submodule (see `docs/security-debt.md` S-10).

#### Scenario: cetus.ts no longer references WailParser

- **WHEN** `grep -n WailParser src/content/cetus.ts` is run on the post-change tree
- **THEN** the grep SHALL produce no matches

#### Scenario: submodule retained for low-level callers

- **WHEN** `git submodule status shared/wail.min.js` is run on the post-change tree
- **THEN** the submodule SHALL still be registered (entry present in `.gitmodules` and `git submodule status` lists `shared/wail.min.js` with its pinned commit hash); the retention is documented in `docs/security-debt.md` S-10
