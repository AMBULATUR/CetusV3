import { describe, it, expect } from "vitest";
import { ScriptRun, ScriptEnv, RowDef, parseScript, rowIdentifier, ScriptError } from "../src/page/script";
import { ValType, TYPE_INFO, readVal, writeVal, parseVal } from "../src/shared/codec";

/** In-memory environment mirroring what the page provides. */
function makeEnv(rowsIn: RowDef[]) {
  const mem = new ArrayBuffer(4096);
  const dv = new DataView(mem);
  const u8 = new Uint8Array(mem);
  const logs: string[] = [], notes: string[] = [];
  const frozen = new Map<string, any>();
  const rows = new Map(rowsIn.map((r) => [r.name, r]));
  const env: ScriptEnv = {
    rows,
    addrOf: (r) => r.addr!,
    readRow: (r) => (r.type === "str8" || r.type === "str16" ? env.readStr(r.addr!, r.type === "str16" ? "utf16" : "utf8", r.len ?? 256) : (() => { const v = readVal(dv, r.addr!, r.type as ValType); return typeof v === "bigint" ? Number(v) : v; })()),
    writeRow: (r, v) => {
      if (r.type === "str8" || r.type === "str16") return env.writeStr(r.addr!, String(v), r.type === "str16" ? "utf16" : "utf8", r.len);
      if (typeof v === "string") throw new Error(`cannot store text in a ${r.type} row`);
      writeVal(dv, r.addr!, r.type as ValType, TYPE_INFO[r.type as ValType].big ? BigInt(Math.trunc(v)) : v);
    },
    readAt: (a, t) => Number(readVal(dv, a, t as ValType)),
    writeAt: (a, t, v) => writeVal(dv, a, t as ValType, parseVal(t as ValType, String(v))),
    readStr: (a, enc, max) => { let s = ""; for (let i = 0; i < max; i++) { const c = enc === "utf8" ? u8[a + i]! : u8[a + i * 2]! | (u8[a + i * 2 + 1]! << 8); if (!c) break; s += String.fromCharCode(c); } return s; },
    writeStr: (a, t, enc, cap) => {
      const bytes = enc === "utf8" ? [...new TextEncoder().encode(t)] : [...t].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]);
      const nul = enc === "utf8" ? 1 : 2;
      if (cap !== undefined && bytes.length + nul > cap) throw new Error(`text needs ${bytes.length + nul} bytes but the row's length is ${cap}`);
      u8.set(bytes, a); for (let i = 0; i < nul; i++) u8[a + bytes.length + i] = 0;
    },
    freeze: (r, v) => { if (v !== undefined) env.writeRow(r, v); frozen.set(r.name, env.readRow(r)); },
    unfreeze: (r) => { frozen.delete(r.name); },
    isFrozen: (r) => frozen.has(r.name),
    log: (m) => logs.push(m), notify: (m) => notes.push(m), call: (n, a) => `${n}(${a.join(",")})`,
  };
  return { env, dv, u8, logs, notes, frozen, mem };
}
const run = async (code: string, rows: RowDef[], setup?: (e: ReturnType<typeof makeEnv>) => void) => {
  const e = makeEnv(rows); setup?.(e);
  const r = new ScriptRun(e.env);
  await r.run(code);
  return e;
};

const ROWS: RowDef[] = [
  { name: "Health", type: "i32", addr: 100 }, { name: "Gold", type: "i32", addr: 104 },
  { name: "TextFromAddress", type: "str8", addr: 200, len: 32 }, { name: "Speed", type: "f32", addr: 120 },
];

describe("script language", () => {
  it("the example from the request: TextFromAddress=\"Text From Script\"", async () => {
    const e = await run(`TextFromAddress="Text From Script"`, ROWS);
    expect(e.env.readRow(ROWS[2]!)).toBe("Text From Script");
    expect(e.u8[200 + "Text From Script".length]).toBe(0);
  });
  it("numbers, compound assignment, floats, ++/--", async () => {
    const e = await run(`Health = 999; Gold += 100; Gold *= 2\nSpeed = 1.5\nSpeed += 0.25; Health--`, ROWS, (s) => s.dv.setInt32(104, 5, true));
    expect(e.dv.getInt32(100, true)).toBe(998);
    expect(e.dv.getInt32(104, true)).toBe(210);
    expect(e.dv.getFloat32(120, true)).toBe(1.75);
  });
  it("if/else, for, while, break/continue, let, ternary, strings, logic", async () => {
    const e = await run(`
      let total = 0
      for (let i = 0; i < 10; i++) { if (i % 2 == 0) continue; if (i > 7) break; total += i }   // 1+3+5+7
      Gold = total
      let n = 0
      while (true) { n++; if (n >= 4) break }
      Health = n > 3 ? 7 : 8
      if (Health == 7 && Gold == 16) TextFromAddress = "ok" + n; else TextFromAddress = "bad"
    `, ROWS);
    expect(e.dv.getInt32(104, true)).toBe(16);
    expect(e.dv.getInt32(100, true)).toBe(7);
    expect(e.env.readRow(ROWS[2]!)).toBe("ok4");
  });
  it("freeze / unfreeze / toggle / read / write / addr / str / call / math builtins", async () => {
    const e = await run(`
      freeze(Health, 500)
      toggle(Gold)
      write(300, "i32", 42)
      Speed = max(1, min(9, sqrt(16)))
      log("addr", hex(addr(Health)), read(300, "i32"), Health.frozen, frozen(Gold), call("add", 1, 2))
      setStr(TextFromAddress, "hi"); log(str(TextFromAddress), len(str(TextFromAddress)))
    `, ROWS);
    expect(e.frozen.has("Health")).toBe(true);
    expect(e.frozen.has("Gold")).toBe(true);
    expect(e.dv.getInt32(100, true)).toBe(500);
    expect(e.dv.getFloat32(120, true)).toBe(4);
    expect(e.logs[0]).toBe("addr 0x64 42 true true add(1,2)");
    expect(e.logs[1]).toBe("hi 2");
  });
  it("sleep and stop(): a looping script can be cancelled", async () => {
    const e = makeEnv(ROWS);
    const r = new ScriptRun(e.env);
    const p = r.run(`while (true) { Gold++; sleep(5) }`);
    await new Promise((res) => setTimeout(res, 60));
    const mid = e.dv.getInt32(104, true);
    expect(mid).toBeGreaterThan(2);
    r.stop();
    await p;
    const after = e.dv.getInt32(104, true);
    await new Promise((res) => setTimeout(res, 40));
    expect(e.dv.getInt32(104, true)).toBe(after);
  });
  it("a tight loop without sleep does not starve the event loop and is stoppable", async () => {
    const e = makeEnv(ROWS);
    const r = new ScriptRun(e.env);
    const p = r.run(`while (true) { Gold++ }`);
    let ticks = 0;
    const t = setInterval(() => ticks++, 5);
    await new Promise((res) => setTimeout(res, 120));
    clearInterval(t);
    expect(ticks).toBeGreaterThan(3); // timers still fire while the script spins
    r.stop(); await p;
  });
  it("helpful errors with line numbers", async () => {
    await expect(run(`Health = 1\nHelth = 2`, ROWS)).rejects.toThrow(/line 2: unknown name 'Helth'.*Did you mean Health/);
    await expect(run(`Health = "abc"`, ROWS)).rejects.toThrow(/cannot store text/);
    await expect(run(`TextFromAddress = "this string is definitely longer than thirty-two bytes"`, ROWS)).rejects.toThrow(/row's length is 32/);
    expect(() => parseScript(`if (Health > 5 {`)).toThrow(/line 1/);
    expect(() => parseScript(`Health = = 3`)).toThrow(ScriptError);
    expect(() => parseScript(`a b`)).toThrow(/missing ';'/);
    await expect(run(`nosuch(1)`, ROWS)).rejects.toThrow(/unknown function 'nosuch'/);
  });
  it("row identifiers from descriptions", () => {
    expect(rowIdentifier("Max Health")).toBe("Max_Health");
    expect(rowIdentifier("1st item")).toBe("_1st_item");
    expect(rowIdentifier("  ")).toBe("");
    expect(rowIdentifier("log")).toBe("log_");
  });
});

describe("global / temp values", () => {
  const mkEnv = (globals?: Map<string, any>) => {
    const logs: string[] = [];
    const env: any = { rows: new Map(), addrOf: () => 0, readRow: () => 0, writeRow() {}, readAt: () => 0, writeAt() {}, readStr: () => "", writeStr() {}, freeze() {}, unfreeze() {}, isFrozen: () => false, log: (m: string) => logs.push(m), notify() {}, call: () => 0, ...(globals ? { globals } : {}) };
    return { env, logs };
  };
  it("global.x persists across runs and is shared; temp.x lives for one run", async () => {
    const g = new Map<string, any>();
    const a = mkEnv(g);
    await new ScriptRun(a.env).run("global.kills = 3; global.kills += 2; global.kills++; temp.t = 10; log(global.kills, temp.t)");
    expect(a.logs).toEqual(["6 10"]);
    expect(g.get("kills")).toBe(6);
    const b = mkEnv(g);                                   // a second script on the same page
    await new ScriptRun(b.env).run("log(global.kills, temp.t, getGlobal('nope', 'dflt'), hasGlobal('kills'))");
    expect(b.logs).toEqual(["6 undefined dflt true"]);    // temp is gone, global is still there
  });
  it("setGlobal / getGlobal / delGlobal / setTemp builtins, compound ops and text values", async () => {
    const e = mkEnv(new Map());
    await new ScriptRun(e.env).run(`setGlobal("name", "Bob"); global.hp = 10; global.hp *= 3; setTemp("k", 7); log(getGlobal("name"), global.hp, getTemp("k")); delGlobal("name"); log(hasGlobal("name"))`);
    expect(e.logs).toEqual(["Bob 30 7", "false"]);
  });
  it("only scalar values can be stored and a row named global does not clash", async () => {
    const e = mkEnv(new Map());
    await expect(new ScriptRun(e.env).run("global.x = row('a')")).rejects.toThrow();
    expect(rowIdentifier("global")).toBe("global_");
    expect(rowIdentifier("temp")).toBe("temp_");
  });
});

import { readFileSync } from "node:fs";
import { SCRIPT_DOCS } from "../src/shared/scriptdocs";
import { BUILTIN_NAMES } from "../src/page/script";

describe("scripting documentation", () => {
  const md = readFileSync(new URL("../docs/SCRIPTING.md", import.meta.url), "utf8");
  it("the in-app copy equals docs/SCRIPTING.md", () => { expect(SCRIPT_DOCS).toBe(md); });
  it("every builtin function is documented", () => {
    for (const n of BUILTIN_NAMES) expect(md, n).toContain(n);
  });
  it("the documented global/temp examples actually run", async () => {
    const g = new Map<string, any>(); const logs: string[] = [];
    const env: any = { rows: new Map(), addrOf: () => 0, readRow: () => 0, writeRow() {}, readAt: () => 0, writeAt() {}, readStr: () => "", writeStr() {}, freeze() {}, unfreeze() {}, isFrozen: () => false, log: (m: string) => logs.push(m), notify() {}, call: () => 0, globals: g };
    await new ScriptRun(env).run(`global.runs = getGlobal("runs", 0) + 1\nlog("run #", global.runs)\ntemp.i = 0\nwhile (temp.i < 3) { temp.i++ }\nlog("tries", temp.i)\nglobal.god = !global.god\nlog(global.god)`);
    expect(logs).toEqual(["run # 1", "tries 3", "true"]);
  });
});
