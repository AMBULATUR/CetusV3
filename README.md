# Cetus 3 — WebAssembly analysis workbench (Manifest V3)

A rewrite of the Cetus fork around a **full-tab workspace** (no more popup that closes when you click the wasm app),
a **new WebAssembly rewriter** that handles modern wasm, and a Cheat-Engine / Ghidra-style toolset.

## Build & load

```bash
npm install
npm run build          # -> dist/
```
Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `dist/` (Chrome 120+).
Click the toolbar icon: the workspace opens in a tab (or a window — Tools & Settings → “Open workspace in”).
**Reload the game tab once** after installing/reloading the extension so Cetus can hook WebAssembly while the page loads.

Other scripts: `npm test` (unit), `npm run typecheck`, `npm run e2e` (real-Chromium end-to-end; needs `playwright-core`
and env `PW_CORE=<path to playwright-core/index.mjs>` and `CHROME_PATH=<chromium binary>`), `npm run dev` (watch build).

## What’s in the workspace

| View | What it does |
|---|---|
| **Scanner** | Cheat-Engine style first/next scan: exact, ≠, <, >, between, unknown initial value, changed/unchanged/increased/decreased (by X); i8…u64, f32, f64; aligned or not; range; ASCII / UTF-16 / hex-with-`??` pattern search. Results are paged (millions OK), editable in place, exportable (CSV/TXT). Row actions: add to cheat table, show in memory, find writes / reads. |
| **Strings** | Scan ASCII / UTF-8 / UTF-16, then filter by **contains / starts with / ends with / equals / wildcard / regex**, case, invert, length, encoding; sort; **pagination (50…5000 rows/page)** for thousands of strings; **export all matches** (TXT, TSV, CSV, JSON). Row actions: memory, cheat table, *code that references this address*, copy. |
| **Memory** | Hex grid (8/16/32 cols, 256 B…16 KiB), live auto-refresh with change highlighting, click/shift-click/arrow selection, double-click a byte to edit. **Data inspector**: u8/i8/u16/i16/u32/i32/u64/i64/f32/f64, hex, binary, ASCII, UTF-8, UTF-16, pointer preview, **big/little endian**, edit any value. **Table view**: array/struct dissect with chosen types and stride. Goto accepts `0x1000+0x20`. |
| **Cheat table** | Live values, freeze (see below), description, type, **W / R watch toggles**, **⌖ show in memory view** on every row, save/load tables. Saved per page. |
| **Functions** | Filter by name/export/index with all match modes, import/defined/exported, sort by size/name/callers/trace count, rename (persisted), breakpoint, **find code that loads a constant** (±range), **code search** over all function bodies (e.g. `i32.const 2000`, `f32.mul`, `call 55`). |
| **Code** | IDE-style listing (offsets, bytes, branch targets, call names, **string previews on pointer constants**), callers/callees panes, back/forward, double-click a constant to open it in Memory. **Edit** a function in text, **Validate** with the real wasm validator, **Save as patch**; patch manager (enable/disable/export/import). |
| **Module** | Summary, imports, exports, globals, tables, memories, types, data segments, custom sections — all filterable/paged. |
| **Debugger** | **Memory watchpoints** (read / write / freeze) with call stacks; **function breakpoints** (“who calls this function?”); **call trace** (start, do something, stop → every function that ran, with baseline subtraction to isolate it); hit log grouped by calling code, each frame links into the disassembly. |
| **Tools & Settings** | Speed hack, download original `.wasm`, diagnostics, instrumentation options. |

### Live updates & performance
Every view refreshes through a *single-flight poller*: one timer, one request at a time, the next run only after the previous one
finished, and it steps aside while one of your own clicks is in flight. Intervals (cheat table, memory, scanner, debugger), a global
**● Live / ⏸ Paused** button and “pause while this tab is in the background” are in **Tools & Settings → Live updates** and apply
immediately. Freeze, watch toggles and remove each take one round trip and update the UI optimistically.

### Line breakpoints (Code view)
Click the gutter next to any instruction (`+0012  36020c  i32.store offset=12`). A line breakpoint is a *logging* breakpoint compiled into the
module (a page cannot pause wasm mid-instruction without DevTools): when the line runs, Cetus records the **effective address** (base +
offset), the **value written** and the **old value** that was there (for stores) or the value read (loads), the **call stack**, a **snapshot of
the function's params/locals**, and shows a live **memory dump** around the address. Any instruction can be used (non-memory lines record
stack + locals). Optional **condition** (`ea == 0x7d0 && value > 100`; variables `ea`, `value`, `old`, `size`) and optional **⏸ `debugger;`**
so DevTools really stops there. New breakpoints are compiled in when the page loads (a banner offers *Reload*); enabling/disabling and
editing conditions afterwards is instant. They are saved per page; shown in the Code view (this function) and Debugger → *Line breakpoints* (all).

### Scripts, hotkeys and text rows
Give cheat-table rows a **description** — it becomes a variable in the **Scripts** view. The language is JavaScript-like but interpreted
(no `eval`, so it works under strict page CSP, can be stopped at any time, and never freezes the wasm app):

```
TextFromAddress = "Text From Script"     // write text (row type: text utf-8 / utf-16, has a max length)
Health = 999;  Gold += 100                // numbers, + - * / % **, ++ --
if (Gold < 100) { Gold = 5000 } else unfreeze(Gold)
for (let i = 0; i < 5; i++) { Ammo = 30; sleep(200) }
while (true) { Mana = 100; sleep(250) }  // press the hotkey again to stop it
freeze(Health, 999)  toggle(Health)  setStr(Name, "x")  str(Name)  read(0x1000, "i32")  call("exportedFn", 1, 2)  log(…)  toast(…)
```
* **Folders** (default: `mockTesting`, `UiTesting`, `UserButtonTesting`; add your own), editor, run/stop with live log, move/duplicate,
  **import / export** per script, per folder or everything (JSON; imports never steal a hotkey that is already used).
* **In-page hotkeys** (any combo such as `Ctrl+Alt+2`, unlimited) run while the wasm tab has focus — *with the workspace closed*.
  Press again to stop a looping script. Scripts can be scoped to “this page” or “all pages”.
* **Chrome shortcut slots 1–4**: pick a slot in the script, then assign a key in `chrome://extensions/shortcuts`; works from anywhere in the browser.
* Rows can be **pointer paths**: *Add address* accepts `[[[[0x4a2220]+0x34]+0x24]+0xd8]+0x18` (live preview, resolved on every read/write),
  and double-clicking an address edits it. Rows can also be **text** (utf-8 / utf-16) with a maximum length so neighbouring memory is never overwritten.

### Multi-select in the cheat table
Click, **Shift+click** (range), **Ctrl+click** (toggle) or drag over rows; **Ctrl+A** selects all. *❄ Freeze selected* / *Unfreeze selected* /
*Remove selected* act on the selection in one round trip; **Space** toggles freeze, **Delete** removes. Ticking *Freeze* on a selected row
applies to the whole selection. Hard (in-instruction) freezes fall back to the timer mode automatically when the hard slots are full.

### Pointer paths (offset finder) for the cheat table
Heap addresses change every run. The **⛓** button on a cheat-table row scans for chains `[[base]+o1]+o2…` that start in *static*
memory (range auto-detected from the data segments, editable), shows them with live "now" addresses, and saves the one you pick on
the entry. The window keeps the **saved candidates** (with the scan settings) on the entry and shows, for every row, the address it resolves to *now*
and the **value found there**. After restarting the wasm app, find the value again with the Scanner, open ⛓, type its address into *Real address of
the value now* and press **Rescan this run & compare**: it reports the paths that are identical in both runs (stable), or explains why none are.
The search breadth and the number of kept paths are adjustable for large heaps.

### Freeze
* **hard** – reverts the value *inside the wasm store instruction* (no flicker; needs write instrumentation; limited by watch slots, default 8).
* **timer** – a JS loop re-writes the value (unlimited, works even if instrumentation is unavailable).

## Why watch/freeze/patch-search were broken, and what changed

* **Watchpoints/freeze**: the old code rewrote modules with a 2020 parser (`wail.min.js`) that cannot round-trip modern wasm
  (bulk-memory, sign-ext, SIMD, atomics, exceptions, multi-value, …). On any parse problem it silently fell back to the
  *un-instrumented* binary, so nothing ever fired. It is replaced by a new TypeScript rewriter (`src/wasm/`) driven by one full opcode
  table. Modules that still can’t be instrumented now say so (header badge + Tools → Diagnostics) instead of failing silently, and
  Cetus degrades step by step (without read hooks → without instrumentation → without patches).
* **Function search / patching**: the page script `import()`ed a Rust-crate JS file via a relative path, which can never resolve from
  the page context. Function listing/disassembly now use the built-in parser. The Rust crate (`crates/`, absent from the zip) is no
  longer needed — no `wasm-pack`/Rust toolchain.
* **Popup closing**: analysis state lives in the page, not in the popup or service worker; the workspace is a normal tab and can be
  closed/reopened freely. WebAssembly apps in `<iframe>`s are detected.
* Page script now runs as a manifest `world: "MAIN"` content script (works on pages with strict CSP); build is plain esbuild.
* Fixed along the way: `i64` values no longer go through floats; scans keep results in typed arrays (no 1000-result cap).

## Notes & limits
* WebAssembly created inside **Web Workers** is not reachable from an extension content script.
* `memory64` modules: scanning/viewing works; watchpoints are disabled (reported as a note).
* Read watchpoints add a small per-load cost; turn them off in Settings if a WebAssembly app gets slow. Write hooks and function-entry hooks are
  nearly free until a watch/breakpoint is armed (the call trace mode is slow by design — use it briefly).
* Patches apply when the page loads (reload the tab); the old `savedPatches` format (code-only `bytes`) is still read.
* Stack-trace offsets are mapped back to the **original** module’s function indices and instruction offsets.

## Layout
`src/wasm` binary parser, opcode table, rewriter, assembler/disassembler · `src/page` main-world runtime (hooks, scan, strings, RPC) ·
`src/content` bridge · `src/background` opens the workspace · `src/app` UI · `legacy/` the old 1.x sources, kept for reference.


### Development

- **CXPhoenix** — Previous Cetus fork and upstream modifications.
- **Jack Baker (Qwokka)** — Original Cetus project and development.
- **Tigran Tumasov** — Original Cetus UI/UX and frontend design.
- **Bradlee Keith Setliff** — Original WAIL and Cetus logo designs.
- **AMBULATUR** — Manifest V3 implementation, new UI/UX design, improvements and maintenance.

### Original Projects

- [AMBULATUR/CetusV3](https://github.com/AMBULATUR/CetusV3) — Current project.
- [CXPhoenix/Cetus](https://github.com/CXPhoenix/Cetus) — Previous upstream fork.
- [Qwokka/Cetus](https://github.com/Qwokka/Cetus) — Original project.
- [WAIL](https://github.com/Qwokka/wail) — WebAssembly instrumentation.

### License

CetusV3 is distributed under the **Apache License 2.0**, retaining the original project's licensing terms and applicable attribution requirements.

See the [LICENSE](LICENSE) file for the full license text.

Third-party libraries and components remain subject to their respective licenses and copyright notices. Their original attribution and license terms must be preserved where applicable.

All rights reserved to their respective authors and contributors.
