// Games hosted in an <iframe> (itch.io style) must be discoverable with their frame id.
const { chromium } = await import(process.env.PW_CORE || "playwright-core");
import wabtInit from "../../node_modules/wabt/index.js";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const dist = resolve(new URL("../../dist", import.meta.url).pathname);
const wabt = await wabtInit();
const wasm = Buffer.from(wabt.parseWat("g.wat", `(module (memory (export "memory") 1) (func (export "f") (i32.store (i32.const 64) (i32.const 1234))))`, {}).toBinary({}).buffer);
const server = http.createServer((req, res) => {
  if (req.url === "/game.wasm") { res.setHeader("content-type", "application/wasm"); res.end(wasm); }
  else if (req.url.startsWith("/inner")) { res.setHeader("content-type", "text/html"); res.end(`<title>inner</title><script>WebAssembly.instantiateStreaming(fetch('/game.wasm'),{}).then(r=>{window.g=r.instance.exports;g.f()})</script>`); }
  else { res.setHeader("content-type", "text/html"); res.end(`<title>Portal</title><iframe id=f src="/inner" width=300 height=200></iframe>`); }
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;
let failed = 0; const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) failed++; };
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "cetus-if-")), { executablePath: process.env.CHROME_PATH, headless: false, args: ["--headless=new", "--no-sandbox", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const extId = new URL(sw.url()).host;
const game = await ctx.newPage(); await game.goto(url); await game.waitForTimeout(800);
const ui = await ctx.newPage(); await ui.goto(`chrome-extension://${extId}/app/index.html`);
await ui.waitForFunction(() => document.querySelector("#target option")?.value, null, { timeout: 15000 });
const label = await ui.locator("#target option").first().textContent();
ok(/frame \d+/.test(label), "iframe instance listed with its frame id: " + label);
await ui.click("nav button[data-view=memory]");
await ui.fill("#view-memory input.mono", "0x40"); await ui.press("#view-memory input.mono", "Enter");
await ui.waitForSelector("#view-memory .hexrow");
ok((await ui.locator("#view-memory .hexrow .b").nth(0).textContent()) === "d2", "memory of the iframe game readable (1234 = 0x4d2)");
await ctx.close(); server.close();
console.log(failed ? "FAILED" : "iframe e2e passed"); process.exit(failed ? 1 : 0);
