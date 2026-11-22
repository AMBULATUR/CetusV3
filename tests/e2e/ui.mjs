// UI end-to-end: opens the workspace in a tab next to a wasm page and drives each view.
const { chromium } = await import(process.env.PW_CORE || "playwright-core");
import wabtInit from "../../node_modules/wabt/index.js";
import http from "node:http";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dist = resolve(new URL("../../dist", import.meta.url).pathname);
const shots = process.env.SHOTS || "/tmp/shots";
mkdirSync(shots, { recursive: true });
const wabt = await wabtInit();
let strs = "";
for (let i = 0; i < 3500; i++) strs += `item_${String(i).padStart(5, "0")}_name\\00`;
const wat = `(module
  (memory (export "memory") 4)
  (data (i32.const 8192) "${strs}")
  (data (i32.const 3000) "Hello Cetus world\\00")
  (func $tick (export "tick") (result i32)
    (i32.store (i32.const 1000) (i32.add (i32.load (i32.const 1000)) (i32.const 1)))
    (i32.load (i32.const 2000)))
  (func $damage (export "damage") (param i32)
    (i32.store (i32.const 2000) (i32.sub (i32.load (i32.const 2000)) (local.get 0))))
  (func $init (export "init") (i32.store (i32.const 2000) (i32.const 100)) (f32.store (i32.const 2100) (f32.const 77.5))))`;
const wasm = Buffer.from(wabt.parseWat("g.wat", wat, {}).toBinary({ write_debug_names: true }).buffer);
const page = `<!doctype html><title>Test Game</title><body style="background:#235"><h1 style="color:#fff">game</h1><script>
window.ready = fetch('/game.wasm').then(r => WebAssembly.instantiateStreaming(r, {})).then(({instance}) => { window.g = instance.exports; instance.exports.init(); setInterval(() => instance.exports.tick(), 50); });
</script>`;
const server = http.createServer((req, res) => { if (req.url === "/game.wasm") { res.setHeader("content-type", "application/wasm"); res.end(wasm); } else { res.setHeader("content-type", "text/html"); res.end(page); } }).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

let failed = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) failed++; };
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "cetus-ui-")), {
  executablePath: process.env.CHROME_PATH, headless: false, viewport: { width: 1360, height: 860 },
  args: ["--headless=new", "--no-sandbox", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const extId = new URL(sw.url()).host;
const game = await ctx.newPage();
await game.goto(url);
await game.evaluate(() => window.ready);
await game.waitForTimeout(300);

const ui = await ctx.newPage();
const errors = [];
ui.on("pageerror", (e) => errors.push(String(e)));
ui.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); if (m.type() === "warning") console.log("   [ui warn]", m.text()); });
await ui.setViewportSize({ width: 1360, height: 860 });
await ui.goto(`chrome-extension://${extId}/app/index.html`);
await ui.waitForFunction(() => document.querySelector("#target option")?.value, null, { timeout: 15000 });
ok(true, "workspace tab opened, target listed: " + (await ui.locator("#target option").first().textContent()));
const nav = (id) => ui.click(`nav button[data-view=${id}]`);
const shot = (n) => ui.screenshot({ path: `${shots}/${n}.png` });

console.log("scanner");
await nav("scanner");
await ui.fill("#view-scanner input[placeholder=value]", "100");
await ui.click("text=First Scan");
await ui.waitForSelector("#view-scanner tbody tr");
ok((await ui.locator("#view-scanner tbody tr").count()) >= 1, "first scan shows result rows");
await game.evaluate(() => window.g.damage(7));
await ui.fill("#view-scanner input[placeholder=value]", "93");
await ui.click("text=Next Scan");
await ui.waitForFunction(() => document.querySelectorAll("#view-scanner tbody tr").length === 1);
ok(true, "next scan narrowed to 1 result");
await shot("1-scanner");

console.log("strings (pagination + filters + export)");
await nav("strings");
await ui.click("#view-strings >> text=Scan memory");
await ui.waitForFunction(() => /\d+ match/.test(document.querySelector("#view-strings .muted")?.textContent ?? ""), null, { timeout: 15000 });
const st = await ui.locator("#view-strings .panel .muted").first().textContent();
ok(/3,?5\d\d matches of/.test(st) || /3,?5\d\d/.test(st), "scan found 3500+ strings: " + st);
ok((await ui.locator("#view-strings tbody tr").count()) === 100, "first page has 100 rows");
const info = await ui.locator("#view-strings .pager-info").textContent();
ok(/of 3,?5\d\d/.test(info) && /page \/ 36/.test(info), "pager reports total + page count: " + info);
await ui.selectOption("#view-strings .pager select", "1000");
await ui.waitForFunction(() => document.querySelectorAll("#view-strings tbody tr").length === 1000);
ok(true, "page size 1000 works");
await ui.fill("#view-strings input[type=search]", "item_0001");
await ui.waitForFunction(() => /of 10\b/.test(document.querySelector("#view-strings .pager-info")?.textContent ?? ""));
ok(true, "contains filter: 10 results");
await ui.selectOption("#view-strings .filter select", "suffix");
await ui.fill("#view-strings input[type=search]", "9_name");
await ui.waitForFunction(() => /of 350\b/.test(document.querySelector("#view-strings .pager-info")?.textContent ?? ""));
ok(true, "suffix filter: 350 results");
await ui.selectOption("#view-strings .filter select", "prefix");
await ui.fill("#view-strings input[type=search]", "item_0034");
await ui.waitForFunction(() => /of 10\b/.test(document.querySelector("#view-strings .pager-info")?.textContent ?? ""));
ok(true, "prefix filter: 10 results");
await ui.selectOption("#view-strings .filter select", "regex");
await ui.fill("#view-strings input[type=search]", "^item_00[0-9]{3}_name$");
await ui.waitForFunction(() => /of 1,?000\b/.test(document.querySelector("#view-strings .pager-info")?.textContent ?? ""));
ok(true, "regex filter: 1000 results");
await shot("2-strings");
const [dl] = await Promise.all([ui.waitForEvent("download"), ui.selectOption("#view-strings select:has(option[value=txt])", "txt")]);
const path = await dl.path();
const lines = readFileSync(path, "utf8").split("\n");
ok(lines.length === 1000 && lines[0] === "item_00000_name", "export TXT downloads all 1000 matches (" + lines.length + " lines)");

console.log("memory");
await ui.fill("#view-strings input[type=search]", "");
await nav("memory");
await ui.fill("#view-memory input.mono", "0x7d0");
await ui.press("#view-memory input.mono", "Enter");
await ui.waitForSelector("#view-memory .hexrow");
ok((await ui.locator("#view-memory .hexrow").count()) === 32, "hex rows rendered (512B/16)");
const first = await ui.locator("#view-memory .hexrow .b").nth(0).textContent();
ok(first === "5d" || first === "64", "byte at 0x7d0 is the health value: " + first);
const insp = await ui.locator("#view-memory .inspector").textContent();
ok(/i32/.test(insp) && /f64/.test(insp) && /utf-16/.test(insp), "inspector shows all data types");
await shot("3-memory");

console.log("cheat table + freeze");
await ui.click("#view-memory >> text=＋ Cheat table");
await nav("cheat");
await ui.waitForSelector("#view-cheat tbody tr");
ok((await ui.locator("#view-cheat tbody tr").count()) === 1, "bookmark added");
await ui.waitForTimeout(700);
const val = await ui.locator("#view-cheat input[data-bid]").inputValue();
ok(val === "93", "live value shown: " + val);
await ui.locator("#view-cheat tbody input[type=checkbox]").first().check();
console.log("   cheat row html:", (await ui.locator("#view-cheat tbody tr").first().evaluate(e=>e.querySelectorAll("input,select").length)), "controls");
await ui.waitForTimeout(300);
await game.evaluate(() => window.g.damage(20));
await ui.waitForTimeout(500);
console.log("   value now", await ui.locator("#view-cheat input[data-bid]").inputValue());
ok((await ui.locator("#view-cheat input[data-bid]").inputValue()) === "93", "hard freeze keeps 93 after damage; toasts=" + JSON.stringify(await ui.locator(".toast").allTextContents()));
await shot("4-cheat");

console.log("responsiveness: no timer pile-up, instant freeze/remove, interval settings");
await ui.evaluate(() => { window.__calls = []; const o = chrome.tabs.sendMessage.bind(chrome.tabs); chrome.tabs.sendMessage = (...a) => { window.__calls.push(a[1]?.op || a[1]?.cetus); return o(...a); }; });
await ui.waitForTimeout(11000); // spans an announce cycle, which used to stack a new interval each time
await ui.evaluate(() => (window.__calls.length = 0));
await ui.waitForTimeout(3000);
const polls = await ui.evaluate(() => window.__calls.filter((c) => c === "cheat.poll").length);
ok(polls >= 3 && polls <= 8, `cheat table polls ~every 500ms with ONE timer (${polls} polls in 3s)`);
await ui.evaluate(() => (window.__calls.length = 0));
await nav("tools");
await ui.waitForTimeout(300);
await ui.selectOption("#view-tools select:has(option[value='0']) >> nth=0", "0"); // cheat table interval -> off
await nav("cheat");
await ui.evaluate(() => (window.__calls.length = 0));
await ui.waitForTimeout(2500);
ok((await ui.evaluate(() => window.__calls.filter((c) => c === "cheat.poll").length)) <= 1, "interval 'off' stops background polling of the cheat table");
await nav("tools");
await ui.selectOption("#view-tools select:has(option[value='0']) >> nth=0", "500");
await nav("cheat");
await ui.waitForTimeout(800);
const t0 = Date.now();
await ui.locator("#view-cheat tbody input[type=checkbox]").first().uncheck();
await game.evaluate(() => window.g.damage(1));
await ui.locator("#view-cheat tbody input[type=checkbox]").first().check();
let held = false;
for (let i = 0; i < 20; i++) { const a = await game.evaluate(() => { const m = new DataView(window.g.memory.buffer); return m.getInt32(2000, true); }); await game.evaluate(() => window.g.damage(5)); const b = await game.evaluate(() => new DataView(window.g.memory.buffer).getInt32(2000, true)); if (a === b) { held = true; break; } await ui.waitForTimeout(50); }
ok(held, `freeze took effect after ${Date.now() - t0} ms`);
const t1 = Date.now();
await ui.click("#view-cheat button[title=remove]");
await ui.waitForFunction(() => document.querySelectorAll("#view-cheat tbody tr").length === 0, null, { timeout: 1000 });
ok(Date.now() - t1 < 600, `row removed immediately (${Date.now() - t1} ms)`);
await game.waitForTimeout(150);
const before2 = await game.evaluate(() => new DataView(window.g.memory.buffer).getInt32(2000, true));
await game.evaluate(() => window.g.damage(2));
ok((await game.evaluate(() => new DataView(window.g.memory.buffer).getInt32(2000, true))) === before2 - 2, "freeze released in the page after remove");

console.log("multi-select freeze");
const addRow = async (addr, type) => {
  await ui.click("#view-cheat >> text=＋ Add address");
  await ui.locator(".modal input.mono").first().fill(addr);
  await ui.selectOption(".modal select", type);
  await ui.click(".modal-foot button.primary");
  await ui.waitForTimeout(150);
};
await addRow("0x3e8", "i32"); await addRow("0x7d0", "i32"); await addRow("0x834", "f32");
await ui.waitForFunction(() => document.querySelectorAll("#view-cheat tbody tr").length === 3);
const cell = (r) => ui.locator("#view-cheat tbody tr").nth(r).locator("td").nth(6);
await cell(0).click({ position: { x: 2, y: 2 } });
await cell(2).click({ position: { x: 2, y: 2 }, modifiers: ["Shift"] });
ok((await ui.locator("#view-cheat tbody tr.sel").count()) === 3, "click + Shift+click selects 3 rows");
await cell(1).click({ position: { x: 2, y: 2 }, modifiers: ["Control"] });
ok((await ui.locator("#view-cheat tbody tr.sel").count()) === 2, "Ctrl+click toggles a row off");
await cell(1).click({ position: { x: 2, y: 2 }, modifiers: ["Control"] });
await ui.click("#view-cheat >> text=❄ Freeze selected");
await ui.waitForTimeout(400);
const rd = (a) => game.evaluate((a) => new DataView(window.g.memory.buffer).getInt32(a, true), a);
const c1 = await rd(1000); await game.waitForTimeout(300); const c2 = await rd(1000);
ok(c1 === c2, `counter at 0x3e8 stays frozen while the game keeps ticking (${c1} -> ${c2})`);
const hp = await rd(2000); await game.evaluate(() => window.g.damage(9));
ok((await rd(2000)) === hp, "health frozen by the same selection");
ok((await ui.locator("#view-cheat tbody input[type=checkbox]:checked").count()) === 3, "all three freeze boxes ticked");
await ui.click("#view-cheat >> text=Unfreeze selected");
await ui.waitForTimeout(400);
const d1 = await rd(1000); await game.waitForTimeout(250); const d2 = await rd(1000);
ok(d2 > d1, "unfreeze selected lets the counter run again");
await ui.click("#view-cheat >> text=Select all");
await ui.click("#view-cheat >> text=Remove selected");
await ui.waitForFunction(() => document.querySelectorAll("#view-cheat tbody tr").length === 0);
ok(true, "remove selected clears the rows");

console.log("pointer window keeps its candidates (address + value per row)");
await game.evaluate(() => { const d = new DataView(window.g.memory.buffer); d.setUint32(0x4000, 0x14000, true); d.setUint32(0x14010, 0x18000, true); d.setInt32(0x18024, 777, true); });
await addRow("0x18024", "i32");
const openPtr = async () => { await ui.click("#view-cheat tbody tr >> nth=0 >> button[title*='pointer']"); await ui.waitForSelector(".modal"); };
await openPtr();
await ui.locator(".modal input.mono").nth(2).fill("0x10000");
await ui.click(".modal >> text=Scan this address");
await ui.waitForFunction(() => /done/.test(document.querySelector(".modal .tabs .muted")?.textContent ?? ""), null, { timeout: 20000 });
await ui.waitForSelector(".modal tbody tr");
const txt1 = await ui.locator(".modal tbody").textContent();
ok(txt1.includes("[[0x4000]+0x10]+0x24") && txt1.includes("777"), "scan result shows the path and the value 777 it leads to");
await ui.click(".modal-foot >> text=Keep scan results");
await ui.waitForTimeout(300);
await ui.click(".modal-foot >> text=Close");
await openPtr(); // reopen: must NOT be empty
await ui.waitForSelector(".modal tbody tr");
const tabTxt = await ui.locator(".modal .tabs").textContent();
const txt2 = await ui.locator(".modal tbody").textContent();
ok(/Saved candidates \(\d+\)/.test(tabTxt) && txt2.includes("[[0x4000]+0x10]+0x24") && txt2.includes("777"), "reopened window shows saved candidates with address + value: " + tabTxt.replace(/\s+/g, " ").slice(0, 60));
await shot("8-pointer");
await ui.click(".modal-foot >> text=Close");
// "restart": everything moves
await game.evaluate(() => { const d = new DataView(window.g.memory.buffer); d.setUint32(0x4000, 0x1c000, true); d.setUint32(0x1c010, 0x1e000, true); d.setInt32(0x1e024, 555, true); });
await openPtr();
await ui.locator(".modal input.mono").nth(3).fill("0x1e024");
await ui.click(".modal >> text=Rescan this run & compare");
await ui.waitForFunction(() => /identical|No overlap|No identical/.test(document.querySelector(".modal .banner")?.textContent ?? ""), null, { timeout: 20000 });
ok(/identical in both runs/.test(await ui.locator(".modal .banner").first().textContent()), "compare finds the path stable across the simulated restart");
await ui.click(".modal .banner button.primary");
await ui.waitForTimeout(700);
const addrTxt = await ui.locator("#view-cheat tbody tr >> nth=0").textContent();
const valNow = await ui.locator("#view-cheat tbody tr >> nth=0 >> input[data-bid]").inputValue();
ok(addrTxt.includes("0x0001e024") && valNow === "555", "entry now follows the pointer path to the new address and shows 555");
await ui.click("#view-cheat >> text=Select all"); await ui.click("#view-cheat >> text=Remove selected");

console.log("pointer expression in Add address + text rows");
await game.evaluate(() => { const d = new DataView(window.g.memory.buffer); d.setUint32(0x4000, 0x14000, true); d.setUint32(0x14010, 0x18000, true); d.setInt32(0x18024, 321, true); });
await ui.click("#view-cheat >> text=＋ Add address");
await ui.locator(".modal input.mono").first().fill("[[0x4000]+0x10]+0x24");
await ui.waitForFunction(() => /pointer path → 0x00018024/.test(document.querySelector(".modal .muted")?.textContent ?? ""), null, { timeout: 5000 });
ok(true, "live preview resolves the pointer expression: " + (await ui.locator(".modal .muted").first().textContent()));
await ui.locator('.modal input[placeholder^="description"]').fill("Coins");
await ui.click(".modal-foot button.primary");
await ui.waitForTimeout(600);
const coinRow = ui.locator("#view-cheat tbody tr").first();
ok((await coinRow.textContent()).includes("0x00018024") && (await coinRow.textContent()).includes("⛓"), "row added as a pointer-path entry");
ok((await coinRow.locator("input[data-bid]").inputValue()) === "321", "pointer row shows the value 321");
await addRow("0xbb8", "str8");
await ui.locator("#view-cheat tbody tr").nth(1).locator('input[placeholder^="description"]').fill("TextFromAddress");
await ui.locator("#view-cheat tbody tr").nth(1).locator('input[placeholder^="description"]').press("Tab");
await addRow("0x7d0", "i32");
await ui.locator("#view-cheat tbody tr").nth(2).locator('input[placeholder^="description"]').fill("Health");
await ui.locator("#view-cheat tbody tr").nth(2).locator('input[placeholder^="description"]').press("Tab");
await ui.waitForTimeout(700);
ok((await ui.locator("#view-cheat tbody tr").nth(1).locator("input[data-bid]").inputValue()) === "Hello Cetus world", "text row reads the string at 0xbb8");

console.log("scripts: folders, hotkey, run, import/export");
await nav("scripts");
await ui.waitForSelector("#view-scripts");
const treeTxt = await ui.locator("#view-scripts .scroll").first().textContent();
ok(["mockTesting", "UiTesting", "UserButtonTesting"].every((n) => treeTxt.includes(n)), "default folders mockTesting / UiTesting / UserButtonTesting exist");
await ui.locator("#view-scripts .row:has-text('UiTesting') button[title='new script in this folder']").click();
await ui.locator(".modal input").fill("ChangeText"); await ui.click(".modal-foot button.primary");
await ui.waitForSelector("#view-scripts textarea");
await ui.fill("#view-scripts textarea", 'TextFromAddress="Text From Script"\nHealth = 777\nlog("ran", Health)');
await ui.focus("#view-scripts input[placeholder^='click']");
await ui.keyboard.press("Control+Alt+Digit2");
ok((await ui.inputValue("#view-scripts input[placeholder^='click']")) === "Ctrl+Alt+2", "hotkey recorder captured Ctrl+Alt+2");
await ui.click("#view-scripts >> text=▶ Run / Stop");
await ui.waitForFunction(() => /finished/.test(document.querySelector("#view-scripts pre")?.textContent ?? ""), null, { timeout: 8000 });
const rd32 = (a) => game.evaluate((a) => new DataView(window.g.memory.buffer).getInt32(a, true), a);
const rdStr = (a) => game.evaluate((a) => { const u = new Uint8Array(window.g.memory.buffer); let s = ""; for (let i = a; u[i]; i++) s += String.fromCharCode(u[i]); return s; }, a);
ok((await rdStr(3000)) === "Text From Script" && (await rd32(2000)) === 777, "script wrote the text and Health in the game: " + (await rdStr(3000)));
ok(/ran 777/.test(await ui.locator("#view-scripts pre").textContent()), "log() output shown");
await game.evaluate(() => { new DataView(window.g.memory.buffer).setInt32(2000, 5, true); });
await game.keyboard.press("Control+Alt+Digit2"); // the in-page hotkey, workspace not involved
await game.waitForTimeout(500);
ok((await rd32(2000)) === 777, "Ctrl+Alt+2 pressed in the GAME tab runs the script");
ok((await game.locator("#__cetus_toasts").count()) === 1, "on-page toast shown");
const [dl2] = await Promise.all([ui.waitForEvent("download"), ui.locator("#view-scripts .row:has-text('UiTesting') button[title='export this folder (JSON)']").click()]);
const exported = JSON.parse(readFileSync(await dl2.path(), "utf8"));
ok(exported.cetusScripts === 1 && exported.folders[0].name === "UiTesting" && exported.folders[0].scripts[0].hotkey === "Ctrl+Alt+2" && exported.folders[0].scripts[0].code.includes("Text From Script"), "folder export contains the script, code and hotkey");
await ui.locator("#view-scripts input[type=file]").count();
const fileChooser = ui.waitForEvent("filechooser");
await ui.click("#view-scripts >> text=Import");
await (await fileChooser).setFiles(await dl2.path());
await ui.waitForTimeout(600);
await shot("9-scripts");
ok((await ui.locator("#view-scripts .scroll").first().textContent()).includes("ChangeText (2)"), "import merges into the same folder and renames the duplicate");

console.log("functions / code / module / debugger / tools");
await nav("functions");
await ui.waitForSelector("#view-functions tbody tr");
ok((await ui.locator("#view-functions tbody tr").count()) >= 3, "functions listed");
await ui.fill("#view-functions input[type=search]", "damage");
await ui.waitForFunction(() => document.querySelectorAll("#view-functions tbody tr").length === 1);
await ui.click("#view-functions tbody tr a.link >> nth=0");
await ui.waitForSelector("#view-code .lrow");
ok((await ui.locator("#view-code .lrow").count()) > 5, "disassembly listing opened from functions");
await ui.click("#view-code >> text=✎ Edit");
const txt = await ui.locator("#view-code textarea").inputValue();
ok(txt.includes("i32.sub") && txt.includes("i32.store"), "editor contains assembler text");
await ui.click("#view-code >> text=Validate");
await ui.waitForSelector("#view-code > .banner");
ok(/Valid/.test(await ui.locator("#view-code > .banner").textContent()), "validate passes on unmodified text");
await ui.fill("#view-code textarea", ".locals\ni32.const 5\nend");
await ui.click("#view-code >> text=Validate");
await ui.waitForFunction(() => /Rejected/.test(document.querySelector("#view-code > .banner")?.textContent ?? ""));
ok(true, "bad edit rejected by validator");
await shot("5-code");
await nav("module");
await ui.click("#view-module >> text=Exports");
await ui.waitForSelector("#view-module .table-wrap tbody tr");
ok((await ui.locator("#view-module .table-wrap tbody tr").count()) >= 4, "exports table");
await nav("debugger");
await ui.fill("#view-debugger input[placeholder=address]", "0x7d0");
await ui.click("#view-debugger >> text=Add");
await game.evaluate(() => window.g.damage(1));
await ui.waitForFunction(() => document.querySelectorAll("#view-debugger table")[3]?.querySelectorAll("tbody tr .badge").length > 0, null, { timeout: 5000 }).catch(() => {});
await ui.waitForTimeout(1300);
const hitText = await ui.locator("#view-debugger").textContent();
ok(/write/.test(hitText) && /damage/.test(hitText), "debugger shows write hit by damage()");
await shot("6-debugger");
await nav("tools");
await ui.waitForTimeout(400);
ok(/instrument\s+yes/.test(await ui.locator("#view-tools pre").textContent()), "tools diagnostics show instrumentation");
await shot("7-tools");

console.log("line breakpoint from the Code view");
await nav("functions");
await ui.fill("#view-functions input[type=search]", "damage");
await ui.waitForFunction(() => document.querySelectorAll("#view-functions tbody tr").length === 1);
await ui.click("#view-functions tbody tr a.link >> nth=0");
await ui.waitForSelector("#view-code .lrow");
await ui.locator('#view-code .lrow:has-text("i32.store") .bpdot').hover();
await ui.locator('#view-code .lrow:has-text("i32.store") .bpdot').click();
await ui.waitForFunction(() => /●/.test(document.querySelector("#view-code .lrow .bpdot.on")?.textContent ?? ""));
ok(true, "gutter dot set on the i32.store line");
ok(/compiled into the game when the page loads/.test(await ui.locator("#view-code .linebp-banner").textContent()), "pending-reload banner shown");
await game.reload(); await game.evaluate(() => window.ready); await game.waitForTimeout(1500);
await ui.waitForFunction(() => /active|store/.test(document.querySelector("#view-code")?.textContent ?? "") && document.querySelector("#view-code .linebp-banner")?.style.display === "none", null, { timeout: 15000 });
ok(true, "after reload the breakpoint is active (status badge: store)");
ok((await ui.locator("#view-code .lrow").count()) > 5, "Code view reopened the same function after the reload");
const before = await game.evaluate(() => new DataView(window.g.memory.buffer).getInt32(2000, true));
await game.evaluate(() => window.g.damage(7));
await ui.waitForFunction(() => /0x000007d0/.test(document.querySelector("#view-code")?.textContent ?? ""), null, { timeout: 8000 });
const panel = await ui.locator("#view-code").textContent();
ok(panel.includes("0x000007d0") && panel.includes(`${before} (0x${before.toString(16)})`) && panel.includes(`${before - 7} (0x${(before - 7).toString(16)})`), `hit row shows address and old → new (${before} → ${before - 7})`);
await ui.locator("#view-code .cols tbody tr").last().locator("td").first().click();
await ui.waitForFunction(() => /Call stack/.test(document.querySelector("#view-code")?.textContent ?? ""));
const det = await ui.locator("#view-code").textContent();
ok(det.includes("Call stack") && det.includes("Locals & params") && det.includes("Heap around the address"), "detail pane: call stack, locals, heap dump");
await shot("10-linebp");
await nav("debugger");
await ui.click("#view-debugger >> text=Line breakpoints");
await ui.waitForFunction(() => /i32\.store|damage/.test(document.querySelector("#view-debugger")?.textContent ?? ""));
ok(true, "Debugger → Line breakpoints tab lists it");

ok(errors.filter((e) => !/favicon/.test(e)).length === 0, "no UI errors: " + JSON.stringify(errors.slice(0, 3)));
await ctx.close(); server.close();
console.log(failed ? `\n${failed} FAILED` : "\nall UI checks passed");
process.exit(failed ? 1 : 0);
