## ADDED Requirements

### Requirement: Node toolchain pinned

The repository SHALL declare a fixed Node.js major version through `.nvmrc` and SHALL list `engines.node` in `package.json` matching that version; both files MUST stay in sync.

#### Scenario: node version files agree

- **WHEN** a contributor reads `.nvmrc` and `package.json.engines.node`
- **THEN** both SHALL reference the same Node major version, and the version SHALL be `>=20`

### Requirement: Vite build produces loadable extension

The repository SHALL provide a Vite configuration using `@crxjs/vite-plugin` such that `npm run build` emits a `dist/` directory containing the compiled manifest, background service worker, content scripts, popup, devtools panel, and options page in shapes loadable by Chrome.

#### Scenario: clean build outputs a loadable dist

- **WHEN** a contributor runs `npm install && npm run build` against a clean working tree
- **THEN** the command SHALL exit successfully, `dist/manifest.json` SHALL exist with `manifest_version: 3`, and loading `dist/` via Chrome "Load unpacked" SHALL succeed without manifest or service-worker errors

### Requirement: TypeScript strict typecheck

The repository SHALL include a `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`, and `exactOptionalPropertyTypes: true`; `npm run typecheck` (or `npx tsc --noEmit`) SHALL succeed on the shipped source tree.

#### Scenario: strict typecheck passes

- **WHEN** `npx tsc --noEmit` is executed against the repository
- **THEN** the command SHALL exit with status `0` and SHALL NOT emit any diagnostics

### Requirement: Vitest unit suite

The repository SHALL include a Vitest unit-test suite runnable via `npm test`, covering at minimum: `InstanceData` serialize / deserialize round-trip, message discriminated-union exhaustiveness, `convertToI64` boundary values, and `bigintJsonParse` / `bigintJsonStringify` round-trip.

#### Scenario: npm test passes

- **WHEN** `npm test` is executed against a clean checkout after `npm install`
- **THEN** the command SHALL exit successfully and SHALL report all listed test cases as passing

### Requirement: wasm-pack integrated with build pipeline

The repository SHALL provide an `npm run wasm` script that invokes `wasm-pack build crates/cetus-wail --target web`, and the Vite build SHALL consume the resulting ESM output as a normal module import; the developer-facing instructions SHALL document the Rust toolchain prerequisites.

#### Scenario: npm-driven wasm rebuild

- **WHEN** a contributor modifies a Rust source under `crates/cetus-wail/` and runs `npm run wasm && npm run build`
- **THEN** the wasm bundle SHALL be regenerated, the Vite build SHALL pick up the new module, and the resulting `dist/` SHALL contain the updated WASM artifact

### Requirement: CI workflow updated

`.github/workflows/CI.yml` SHALL use `actions/checkout@v4`, `actions/setup-node@v4` pinned to the same Node major as `.nvmrc`, SHALL install the Rust toolchain (`dtolnay/rust-toolchain`), SHALL cache both npm and cargo, and SHALL run `npm install`, `npm run wasm`, `npm run build`, `npm run typecheck`, and `npm test` on every push and pull request.

#### Scenario: CI succeeds on a clean push

- **WHEN** a pull request is opened with no source changes other than the modernization itself
- **THEN** the CI workflow SHALL run all listed steps and SHALL report a green status with no skipped or failed jobs
