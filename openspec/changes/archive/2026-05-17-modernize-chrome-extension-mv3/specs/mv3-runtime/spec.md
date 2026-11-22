## ADDED Requirements

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

### Requirement: Service worker entry point

The background script SHALL be a service worker, MUST be registered through `background.service_worker` in the manifest, and SHALL be authored as an ES module so it can `import` other modules directly.

#### Scenario: service worker registers and survives a stop / restart

- **WHEN** the extension is installed and the user opens Chrome DevTools → Application → Service Workers and clicks "Stop" on the Cetus worker
- **THEN** the worker SHALL be in the stopped state, and the next message sent from popup or content script SHALL wake the worker, which SHALL respond without uncaught errors

### Requirement: Typed message protocol

All cross-context messages exchanged between background, content scripts, popup, devtools panel, and options page SHALL be expressed as a TypeScript discriminated union keyed by a string `type` field, and every sender and receiver SHALL exhaustively handle the union (verified at compile time via an `assertNever` helper).

#### Scenario: receiver rejects unknown message types

- **WHEN** a message arrives whose `type` is not a member of the declared union
- **THEN** the receiver SHALL log the offending message and SHALL NOT mutate any instance state, and the build SHALL refuse to compile if any handler omits a case from the union

### Requirement: Action and devtools surfaces preserved

The extension SHALL preserve the existing user surfaces — toolbar popup, DevTools panel labeled "Cetus", and options page — under Manifest V3 equivalents (`action.default_popup`, `devtools_page`, `options_ui`).

#### Scenario: popup and devtools panel still open

- **WHEN** the user clicks the Cetus toolbar icon
- **THEN** the popup HTML SHALL load and SHALL display the same primary tabs (Search, Bookmarks, Patches, Memory Viewer, Speedhack, Stack Traces) as version 1.05

- **WHEN** the user opens Chrome DevTools on a page that has loaded a WebAssembly module
- **THEN** a panel named "Cetus" SHALL be available and SHALL load without errors
