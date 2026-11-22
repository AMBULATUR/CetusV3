## ADDED Requirements

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

### Requirement: InstanceData serialization round-trip

`InstanceData` SHALL be serializable through a single helper pair (`serializeInstanceData` / `deserializeInstanceData`) that preserves all fields defined in the v1.05 in-memory shape (`initialized`, `url`, `bookmarks`, `watchpoints`, `symbols`, `stackTraces`, `searchForm`, `stringForm`, `patchForm`, `speedhack`, `memoryViewer`, `currentTab`) and SHALL round-trip `BigInt` values without loss.

#### Scenario: round-trip preserves BigInt watch values

- **WHEN** an `InstanceData` containing a watch value of `BigInt("0x7fffffffffffffff")` is serialized and immediately deserialized
- **THEN** the resulting object SHALL be structurally equal to the input, including the exact `BigInt` value

### Requirement: Hydration before message handling

The background service worker SHALL hydrate any required `InstanceData` from the storage tiers before mutating it in response to an incoming message; messages arriving while hydration is still in flight SHALL be queued and processed in arrival order once hydration completes.

#### Scenario: worker restart preserves user state

- **WHEN** the service worker is stopped by Chrome and a popup sends an `updateBookmarks` message that wakes it
- **THEN** the worker SHALL first hydrate `InstanceData` from storage, SHALL THEN apply the bookmark update, and SHALL respond to the popup with a state matching the user's pre-stop bookmarks plus the new entry

### Requirement: Cross-browser-session restoration

After the browser process exits and is restarted, the extension SHALL restore the persistent tier so the popup shows the user's previous bookmarks, watchpoint configuration entries, saved patches, and `speedhack.multiplier`; session-tier data MAY be empty.

#### Scenario: bookmarks survive browser restart

- **WHEN** the user adds three bookmarks, fully quits Chrome, and reopens Chrome to the same WebAssembly page
- **THEN** the popup SHALL display the same three bookmarks, and the corresponding watchpoint flags SHALL match their pre-restart values
