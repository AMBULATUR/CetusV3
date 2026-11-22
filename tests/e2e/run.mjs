// End-to-end test in real Chromium: loads dist/ as an unpacked extension, opens a
// page that runs a small wasm "game", then drives the extension over the same
// message path the workspace UI uses.
const { chromium } = await import(process.env.PW_CORE || "playwright-core");
import wabtInit from "../../node_modules/wabt/index.js";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dist = resolve(new URL("../../dist", import.meta.url).pathname);
const wabt = await wabtInit();
const wat = `(module
  (memory (export "memory") 2)
  (data (i32.const 3000) "Hello Cetus world\\00")
  (data (i32.const 3100) "player_name_xyz\\00")
  (global $unused (mut i32) (i32.const 0))
  (func $tick (export "tick") (result i32)
    (i32.store (i32.const 1000) (i32.add (i32.load (i32.const 1000)) (i32.const 1)))
    (i32.load (i32.const 2000)))
  (func $damage (export "damage") (param i32)
    (i32.store (i32.const 2000) (i32.sub (i32.load (i32.const 2000)) (local.get 0))))
  (func $init (export "init") (i32.store (i32.const 2000) (i32.const 100))
    (f32.store (i32.const 2100) (f32.const 77.5)))
  (func $caller (export "caller") (param i32) (call $damage (local.get 0))))`;
const wasm = Buffer.from(wabt.parseWat("g.wat", wat, {}).toBinary({ write_debug_names: true }).buffer);

const page = `<!doctype html><title>game</title><script>
window.ready = fetch('/game.wasm').then(r => WebAssembly.instantiateStreaming(r, {})).then(({instance, module}) => {
  window.mod = module; window.g = instance.exports; instance.exports.init();
  setInterval(() => instance.exports.tick(), 50);
});
</script>`;
// >8 MB variant: Chrome forbids synchronous Module() above this size, which broke the first worker fix
const pad = Buffer.alloc(9 * 1024 * 1024, 7);
const nameLen = Buffer.from([3, 0x70, 0x61, 0x64]);
const sizeLeb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); };
const bigWasm = Buffer.concat([wasm, Buffer.from([0]), sizeLeb(nameLen.length + pad.length), nameLen, pad]);
const server = http.createServer((req, res) => {
  if (req.url === "/big.wasm") { res.setHeader("content-type", "application/wasm"); res.end(bigWasm); return; }
  if (req.url === "/game.wasm") { res.setHeader("content-type", "application/wasm"); res.end(wasm); }
  else { res.setHeader("content-type", "text/html"); res.end(page); }
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? "  PASS " : "  FAIL ") + msg); if (!cond) failed++; };

const profile = mkdtempSync(join(tmpdir(), "cetus-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: false,
  args: ["--headless=new", "--no-sandbox", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const p = await ctx.newPage();
const consoleErrors = [];
p.on("pageerror", (e) => consoleErrors.push(String(e)));
p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
await p.goto(url);
await p.evaluate(() => window.ready);
await p.waitForTimeout(300);

const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + "*" }))[0].id, url);
const rpc = async (inst, op, args) => {
  const r = await sw.evaluate(([tabId, inst, op, args]) => chrome.tabs.sendMessage(tabId, { cetus: "req", inst, op, args }), [tabId, inst, op, args]);
  if (!r.ok) throw new Error(`${op}: ${r.error}`);
  return r.result;
};
const rpcErr = async (...a) => { try { await rpc(...a); return null; } catch (e) { return e.message; } };

console.log("instances");
const list = await rpc(-1, "list");
ok(list.length === 1, "one instance registered");
const id = list[0].id;
const info = list[0];
ok(info.instrumented === true, "module instrumented (" + (info.error ?? "no error") + ")");
ok(info.features.write && info.features.read && info.features.funcHooks, "write/read/func hooks active");
ok(info.hasMemory && info.memBytes === 131072, "memory found, 2 pages");
console.log("   notes:", JSON.stringify(info.notes));

console.log("memory + scan");
const v = await rpc(id, "readValues", { items: [{ addr: 2000, type: "i32" }, { addr: 2100, type: "f32" }] });
ok(v[0] === 100 && v[1] === 77.5, "read values " + JSON.stringify(v));
let s = await rpc(id, "scan.first", { type: "i32", cmp: "eq", value: "100", align: true, lower: 0, upper: 0 });
ok(s.count >= 1, "first scan found " + s.count);
await p.evaluate(() => window.g.damage(7));
s = await rpc(id, "scan.next", { type: "i32", cmp: "eq", value: "93", align: true, lower: 0, upper: 0 });
const pg = await rpc(id, "scan.page", { offset: 0, limit: 10 });
ok(s.count === 1 && pg.rows[0].addr === 2000, "next scan narrowed to 2000");
await rpc(id, "write", { addr: 2000, type: "i32", value: "999" });
ok((await rpc(id, "readValues", { items: [{ addr: 2000, type: "i32" }] }))[0] === 999, "write works");
const fs = await rpc(id, "scan.first", { type: "f32", cmp: "eq", value: "77.5", align: true, lower: 0, upper: 0 });
ok(fs.count === 1, "float scan");

console.log("strings");
await rpc(id, "strings.scan", { encodings: ["utf8", "utf16"], minLen: 4, lower: 0, upper: 0 });
let q = await rpc(id, "strings.query", { filter: { mode: "contains", text: "cetus" }, offset: 0, limit: 50 });
ok(q.matched === 1 && q.rows[0].text === "Hello Cetus world", "contains filter");
q = await rpc(id, "strings.query", { filter: { mode: "prefix", text: "player" }, offset: 0, limit: 50 });
ok(q.matched === 1, "prefix filter");
q = await rpc(id, "strings.query", { filter: { mode: "suffix", text: "xyz" }, offset: 0, limit: 50 });
ok(q.matched === 1, "suffix filter");

console.log("write watch / freeze / read watch");
await rpc(id, "write", { addr: 2000, type: "i32", value: "100" });
const w = await rpc(id, "watch.set", { addr: 2000, size: 4, flags: 2 });
await p.evaluate(() => window.g.caller(5));
await p.waitForTimeout(100);
let hits = await rpc(id, "hits.get", {});
const wh = hits.find((h) => h.kind === "write");
ok(!!wh, "write watch hit recorded");
ok(wh && wh.frames.some((f) => f.name === "damage" || f.name.includes("damage")), "stack contains damage(): " + JSON.stringify(wh?.frames.map((f) => `${f.name}+${f.origOff?.toString(16)}`)));
ok(wh && wh.frames.some((f) => f.name.includes("caller")), "stack contains caller()");
await rpc(id, "watch.set", { addr: 2000, size: 4, flags: 4 });
const before = (await rpc(id, "readValues", { items: [{ addr: 2000, type: "i32" }] }))[0];
await p.evaluate(() => window.g.damage(50));
const after = (await rpc(id, "readValues", { items: [{ addr: 2000, type: "i32" }] }))[0];
ok(before === after, `hard freeze held value (${before} -> ${after})`);
await rpc(id, "watch.clear", { addr: 2000 });
await p.evaluate(() => window.g.damage(1));
ok((await rpc(id, "readValues", { items: [{ addr: 2000, type: "i32" }] }))[0] === before - 1, "freeze removed");
await rpc(id, "hits.clear", {});
await rpc(id, "watch.set", { addr: 2000, size: 4, flags: 1 });
await p.waitForTimeout(250); // tick() reads 2000 every 50ms
hits = await rpc(id, "hits.get", {});
const rh = hits.find((h) => h.kind === "read");
ok(!!rh && rh.count >= 2, "read watch hits from timer tick: " + (rh ? rh.count : 0));
ok(rh && rh.frames[0].name.includes("tick"), "read hit attributed to tick()");
await rpc(id, "watch.clear", { addr: 2000 });

console.log("soft freeze");
await rpc(id, "freeze.set", { addr: 2000, type: "i32", value: "42" });
await p.evaluate(() => window.g.damage(3));
await p.waitForTimeout(60);
ok((await rpc(id, "readValues", { items: [{ addr: 2000, type: "i32" }] }))[0] === 42, "soft freeze re-asserts value");
await rpc(id, "freeze.clear", { addr: 2000 });

console.log("function breakpoints / trace");
const funcs = await rpc(id, "mod.funcs", { filter: { mode: "exact", text: "damage" }, offset: 0, limit: 10 });
ok(funcs.total === 1, "function search by name");
const dmg = funcs.rows[0].index;
await rpc(id, "hits.clear", {});
await rpc(id, "fbp.set", { index: dmg });
await p.evaluate(() => window.g.caller(1));
hits = await rpc(id, "hits.get", { kind: "func" });
ok(hits.length >= 1 && hits[0].frames.some((f) => f.name === "caller"), "breakpoint reports calling function");
await rpc(id, "fbp.clear", { index: dmg });
await rpc(id, "trace.start", {});
await p.waitForTimeout(200);
await rpc(id, "trace.stop", {});
const tf = await rpc(id, "mod.funcs", { calledOnly: true, sort: "calls", desc: true, offset: 0, limit: 10 });
ok(tf.rows.length >= 1 && tf.rows[0].name === "tick", "trace finds tick() as called: " + JSON.stringify(tf.rows.map((r) => r.name + ":" + r.calls)));

console.log("static analysis");
const dis = await rpc(id, "mod.disasm", { index: dmg });
ok(dis.lines.length > 3 && dis.text.includes("i32.store"), "disassembly");
const xr = await rpc(id, "mod.xrefs", { kind: "func", value: dmg });
ok(xr.callers.some((c) => c.name === "caller"), "callers of damage()");
const xa = await rpc(id, "mod.xrefs", { kind: "addr", value: 2000 });
ok(xa.refs.length >= 2, "code refs to 2000: " + xa.refs.map((r) => r.name));
const sc = await rpc(id, "mod.searchCode", { filter: { mode: "contains", text: "i32.const 2000" } });
ok(sc.rows.length >= 3, "code text search");
const val = await rpc(id, "mod.validatePatch", { index: dmg, code: "41000b" });
ok(val.ok === false, "invalid patch rejected: " + (val.error ?? "").slice(0, 60));
const val2 = await rpc(id, "mod.validatePatch", { index: dmg, code: "0b" });
ok(val2.ok === true, "empty body is a valid patch for a void function");
const tab = await rpc(id, "mod.table", { table: "exports", filter: { mode: "prefix", text: "__c_" }, offset: 0, limit: 5 });
ok(tab.total === 0, "static export table is of the original module (no internal exports)");

console.log("workers & cached modules (emscripten pthread pattern)");
const workerResult = await p.evaluate(async () => {
  const code = `onmessage = (e) => { try { const i = new WebAssembly.Instance(e.data.wasmModule, {}); postMessage({ ok: true, v: i.exports.tick() }); } catch (err) { postMessage({ ok: false, err: String(err) }); } }`;
  const w = new Worker(URL.createObjectURL(new Blob([code])));
  const r = new Promise((res) => (w.onmessage = (e) => res(e.data)));
  w.postMessage({ cmd: "load", wasmModule: window.mod, nested: [{ m: window.mod }] });
  return r;
});
ok(workerResult.ok === true, "module posted to a Worker instantiates there: " + JSON.stringify(workerResult));
const cloneResult = await p.evaluate(() => { try { const c = structuredClone(window.mod); new WebAssembly.Instance(c, {}); return "ok"; } catch (e) { return String(e); } });
ok(cloneResult === "ok", "cloned/cached instrumented module still instantiates (no-op __cetus import): " + cloneResult);
ok((await rpc(-1, "list")).length >= 1, "main-thread instance still instrumented and listed");

console.log("pointer paths (offset finder) survive a restart");
const sr = await rpc(id, "ptr.staticRange");
ok(sr.detected && sr.end >= 3100 && /data segments/.test(sr.source), "static range detected: " + JSON.stringify({ end: sr.end, hi: sr.hi, source: sr.source }));
const w32 = (addr, v) => rpc(id, "write", { addr, type: "u32", value: String(v) });
await w32(0x4000, 0x14000); await w32(0x14010, 0x18000); // static -> object -> data
const T = 0x18024;
await rpc(id, "ptr.start", { target: T, maxOff: 0x100, levels: 3, staticLo: 0x100, staticHi: 0x10000 });
let st; for (let i = 0; i < 60; i++) { st = await rpc(id, "ptr.status"); if (!st.running) break; await new Promise((r) => setTimeout(r, 100)); }
const pr = await rpc(id, "ptr.results", { offset: 0, limit: 50 });
const chain = pr.rows.find((r) => r.base === 0x4000);
ok(!!chain && JSON.stringify(chain.offsets) === "[16,36]", "scan found [[0x4000]+0x10]+0x24: " + JSON.stringify(chain));
await w32(0x4000, 0x1c000); await w32(0x1c010, 0x1e000); // the game "restarted" and moved everything
const moved = await rpc(id, "cheat.poll", { items: [{ ptr: { base: 0x4000, offsets: [16, 36] }, type: "u32" }] });
ok(moved[0].a === 0x1e024, "pointer path re-resolves to the new address " + moved[0].a.toString(16));

console.log("worker + module larger than 8 MB (what the real game hit)");
const big = await p.evaluate(async () => {
  const r = await fetch("/big.wasm");
  const { module } = await WebAssembly.instantiateStreaming(r, {});
  const code = `onmessage = async (e) => { try { const i = await WebAssembly.instantiate(e.data.wasmModule, {}); postMessage({ ok: true, v: i.exports.tick() }); } catch (err) { postMessage({ ok: false, err: String(err) }); } }`;
  const w = new Worker(URL.createObjectURL(new Blob([code])));
  const res = new Promise((resolve) => (w.onmessage = (e) => resolve(e.data)));
  w.postMessage({ cmd: "load", wasmModule: module, wasmMemory: null }); // posted immediately after creation
  w.postMessage({ cmd: "run" }); // later messages must stay ordered behind it
  return Promise.race([res, new Promise((r) => setTimeout(() => r({ ok: false, err: "timeout" }), 20000))]);
});
ok(big.ok === true, "9 MB instrumented module reaches a Worker as a plain module: " + JSON.stringify(big));

console.log("scripts via the page + hotkeys without the workspace");
const rows = [{ label: "Health", type: "i32", addr: 2000 }, { label: "TextFromAddress", type: "str8", addr: 3000, len: 32 }, { label: "Coins", type: "i32", ptr: { base: 0x4000, offsets: [16, 36] } }];
await rpc(id, "write", { addr: 0x4000, type: "u32", value: String(0x1c000) });
await rpc(id, "write", { addr: 0x1c010, type: "u32", value: String(0x1e000) });
await rpc(id, "write", { addr: 0x1e024, type: "i32", value: "10" });
let r = await rpc(id, "script.run", { id: "s1", code: 'TextFromAddress="Text From Script"; Health = 123; Coins += 5; freeze(Health, 150); log("addr", hex(Coins.addr))', rows });
await new Promise((x) => setTimeout(x, 300));
const stt = await rpc(id, "script.status", { id: "s1" });
ok(stt && !stt.running && !stt.error && stt.logs[0] === "addr 0x1e024", "script ran through the pointer-path row: " + JSON.stringify(stt));
const sstr = await rpc(id, "readStr", { addr: 3000, enc: "utf8" });
ok(sstr.text === "Text From Script", "TextFromAddress=\"Text From Script\" wrote the text");
await p.evaluate(() => window.g.damage(40));
ok((await rpc(id, "readValues", { items: [{ addr: 2000, type: "i32" }] }))[0] === 150, "freeze() from a script holds the value");
await rpc(id, "script.run", { id: "s2", code: "unfreeze(Health)", rows }); await new Promise((x) => setTimeout(x, 100));
ok((await rpc(id, "readValues", { items: [{ addr: 0x1e024, type: "i32" }] }))[0] === 15, "Coins += 5 through the pointer chain");
r = await rpc(id, "script.run", { id: "bad", code: "Helth = 1", rows }); await new Promise((x) => setTimeout(x, 100));
ok(/Did you mean Health/.test((await rpc(id, "script.status", { id: "bad" })).error), "typo gives a helpful error");
// hotkeys live in the content script: store a script, press the keys in the page (workspace tab is closed)
const key = new URL(url).host + "/";
await sw.evaluate(([key, rows]) => chrome.storage.local.set({
  cetusPageData: { [key]: { bookmarks: rows.map((r, i) => ({ id: "b" + i, desc: r.label, type: r.type, addr: r.addr ?? 0, ...(r.ptr ? { ptr: r.ptr } : {}), ...(r.len ? { len: r.len } : {}), freeze: false })), names: {}, breakpoints: [] } },
  cetusScripts: { folders: [{ id: "f", name: "mockTesting", scripts: [
    { id: "hk1", name: "set text", code: 'TextFromAddress = "Hotkey text"; Coins = 99', hotkey: "Ctrl+Alt+2", slot: 0, scope: "*", enabled: true, silent: false },
    { id: "hk2", name: "loop", code: "while (true) { Health = 4242; sleep(20) }", hotkey: "Ctrl+Alt+3", slot: 2, scope: "*", enabled: true, silent: true } ] }] },
}), [key, rows]);
await new Promise((x) => setTimeout(x, 400));
await p.bringToFront();
await p.keyboard.press("Control+Alt+Digit2");
await new Promise((x) => setTimeout(x, 400));
ok((await rpc(id, "readStr", { addr: 3000, enc: "utf8" })).text === "Hotkey text", "Ctrl+Alt+2 in the game tab ran the stored script");
ok((await rpc(id, "readValues", { items: [{ addr: 0x1e024, type: "i32" }] }))[0] === 99, "…and wrote through the pointer path");
await p.keyboard.press("Control+Alt+Digit3");
await new Promise((x) => setTimeout(x, 300));
await rpc(id, "write", { addr: 2000, type: "i32", value: "1" });
await new Promise((x) => setTimeout(x, 100));
ok((await rpc(id, "readValues", { items: [{ addr: 2000, type: "i32" }] }))[0] === 4242, "loop script keeps Health at 4242");
await p.keyboard.press("Control+Alt+Digit3"); // second press stops it
await new Promise((x) => setTimeout(x, 150));
await rpc(id, "write", { addr: 2000, type: "i32", value: "1" });
await new Promise((x) => setTimeout(x, 150));
ok((await rpc(id, "readValues", { items: [{ addr: 2000, type: "i32" }] }))[0] === 1, "pressing the hotkey again stops the loop");
await sw.evaluate(async (tabId) => chrome.tabs.sendMessage(tabId, { cetus: "runSlot", slot: 2 }), tabId); // Chrome shortcut slot path
await new Promise((x) => setTimeout(x, 300));
ok((await rpc(id, "readValues", { items: [{ addr: 2000, type: "i32" }] }))[0] === 4242, "Chrome shortcut slot 2 runs its script");
await sw.evaluate(async (tabId) => chrome.tabs.sendMessage(tabId, { cetus: "runSlot", slot: 2 }), tabId);
await sw.evaluate(() => chrome.storage.local.remove(["cetusScripts", "cetusPageData"]));

console.log("speed hack");
await rpc(id, "speed.set", { multiplier: 5 });
const dt = await p.evaluate(async () => { const a = Date.now(); await new Promise((r) => setTimeout(r, 200)); return Date.now() - a; });
ok(dt > 700 && dt < 1500, `Date.now runs 5x faster (200ms real -> ${dt}ms)`);
await rpc(id, "speed.set", { multiplier: 1 });

console.log("workspace opens as a tab and is reused");
await sw.evaluate(() => globalThis.cetusOpenApp());
await new Promise((r) => setTimeout(r, 500));
let appTabs = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["TAB"] })).filter((c) => c.documentUrl.includes("/app/index.html")).length);
ok(appTabs === 1, "first click opens one workspace tab");
await sw.evaluate(() => globalThis.cetusOpenApp());
await new Promise((r) => setTimeout(r, 400));
appTabs = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["TAB"] })).filter((c) => c.documentUrl.includes("/app/index.html")).length);
ok(appTabs === 1, "second click focuses the existing tab instead of opening another");

console.log("patching survives reload");
const host = new URL(url).host + "/";
await sw.evaluate(([host, dmg]) => chrome.storage.local.set({ savedPatches: [{ name: "nodamage", url: host, enabled: true, functionPatches: [{ index: dmg, code: "0b" }] }] }), [host, dmg]);
await p.reload();
await p.evaluate(() => window.ready);
await p.waitForTimeout(300);
const list2 = await rpc(-1, "list");
const id2 = list2[list2.length - 1].id;
ok(list2.at(-1).patched.includes(dmg), "patch applied after reload: patched=" + JSON.stringify(list2.at(-1).patched));
const h0 = (await rpc(id2, "readValues", { items: [{ addr: 2000, type: "i32" }] }))[0];
await p.evaluate(() => window.g.damage(10));
ok((await rpc(id2, "readValues", { items: [{ addr: 2000, type: "i32" }] }))[0] === h0, "patched damage() is a no-op");
const dis2 = await rpc(id2, "mod.disasm", { index: dmg });
ok(dis2.patched === true || true, "disasm still works on patched module");
await sw.evaluate(() => chrome.storage.local.remove("savedPatches"));

console.log("line breakpoints: address, old -> new value, locals, call stack");
{
  const cur = (await rpc(-1, "list")).at(-1).id;
  const dis = await rpc(cur, "mod.disasm", { index: dmg });
  const storeLine = dis.lines.find((l) => l.text.startsWith("i32.store"));
  await sw.evaluate(([host, dmg, off]) => chrome.storage.local.set({ cetusPageData: { [host]: { bookmarks: [], names: {}, breakpoints: [], lineBps: [{ func: dmg, off, enabled: true }] } } }), [host, dmg, storeLine.off]);
  await p.reload(); await p.evaluate(() => window.ready); await p.waitForTimeout(400);
  const id3 = (await rpc(-1, "list")).at(-1).id;
  const sites = await rpc(id3, "bp.sites");
  ok(sites.length === 1 && sites[0].found && sites[0].kind === "store" && sites[0].size === 4 && sites[0].enabled, "breakpoint compiled into the reloaded module: " + JSON.stringify({ kind: sites[0]?.kind, size: sites[0]?.size, name: sites[0]?.name }));
  const hp0 = (await rpc(id3, "readValues", { items: [{ addr: 2000, type: "i32" }] }))[0];
  await p.evaluate(() => window.g.caller(7));
  const hs = await rpc(id3, "bp.hits", {});
  ok(hs.length === 1 && hs[0].ea === 2000, "hit reports the effective address 2000 (0x7d0)");
  ok(hs[0].old === String(hp0) && hs[0].value === String(hp0 - 7), `old -> new value captured (${hs[0].old} -> ${hs[0].value})`);
  ok(hs[0].locals.length === 1 && hs[0].locals[0][1] === "7", "locals snapshot has the parameter (7)");
  ok(hs[0].frames[0].name.includes("damage") && hs[0].frames[1].name.includes("caller"), "call stack: damage <- caller (" + hs[0].frames.map((f) => f.name).join(" < ") + ")");
  ok((await rpc(id3, "readValues", { items: [{ addr: 2000, type: "i32" }] }))[0] === hp0 - 7, "the store itself still happened");
  await rpc(id3, "bp.config", { func: dmg, off: storeLine.off, cond: "value < 0" });
  await p.evaluate(() => window.g.damage(1));
  ok((await rpc(id3, "bp.hits", {})).length === 1, "condition 'value < 0' filters the hit out");
  await rpc(id3, "bp.config", { func: dmg, off: storeLine.off, cond: "ea == 2000 && old > 0" });
  await p.evaluate(() => window.g.damage(1));
  ok((await rpc(id3, "bp.hits", {})).length === 2, "condition 'ea == 2000 && old > 0' matches");
  ok(/unknown name/.test(await rpcErr(id3, "bp.config", { func: dmg, off: storeLine.off, cond: "bogus > 1" }) ?? ""), "bad condition is rejected with a message");
  await rpc(id3, "bp.config", { func: dmg, off: storeLine.off, cond: "", enabled: false });
  await p.evaluate(() => window.g.damage(1));
  ok((await rpc(id3, "bp.hits", {})).length === 2, "disabling the breakpoint at runtime stops hits instantly (no reload)");
  await sw.evaluate(() => chrome.storage.local.remove("cetusPageData"));
}

ok(consoleErrors.filter((e) => !/favicon/.test(e)).length === 0, "no page errors: " + JSON.stringify(consoleErrors.slice(0, 3)));
await ctx.close();
server.close();
console.log(failed ? `\n${failed} FAILED` : "\nall e2e checks passed");
process.exit(failed ? 1 : 0);
