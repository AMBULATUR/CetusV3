import { describe, it, expect } from "vitest";
import { PointerScan, resolveChain } from "../src/page/pointer";

function mem() { return new ArrayBuffer(0x20000); }

describe("pointer scan", () => {
  it("finds a 2-level static path and resolves it after the objects move", async () => {
    const b = mem(); const dv = new DataView(b);
    dv.setUint32(0x4000, 0x14000, true); // static cell -> object
    dv.setUint32(0x14010, 0x18000, true); // object field -> data block
    const T = 0x18024;
    const sc = new PointerScan(() => b, { target: T, maxOff: 0x100, levels: 3, staticLo: 0x100, staticHi: 0x10000 });
    await sc.run();
    expect(sc.error).toBeNull();
    const hit = sc.results.find((r) => r.base === 0x4000);
    expect(hit).toEqual({ base: 0x4000, offsets: [0x10, 0x24] });
    expect(resolveChain(b, hit!)).toBe(T);
    // "restart": everything moves, static cell still points to the new object
    dv.setUint32(0x14010, 0, true); dv.setUint32(0x4000, 0x1c000, true); dv.setUint32(0x1c010, 0x1e000, true);
    expect(resolveChain(b, hit!)).toBe(0x1e024);
  });
  it("direct level-1 static pointer, and respects maxOff / bounds", async () => {
    const b = mem(); const dv = new DataView(b);
    dv.setUint32(0x2000, 0x10000, true);
    const run = async (maxOff: number) => { const s = new PointerScan(() => b, { target: 0x10040, maxOff, levels: 1, staticLo: 0x100, staticHi: 0x8000 }); await s.run(); return s.results; };
    expect((await run(0x100))[0]).toEqual({ base: 0x2000, offsets: [0x40] });
    expect(await run(0x10)).toEqual([]);
    expect(resolveChain(b, { base: 0x2000, offsets: [0xfffffff] })).toBeNull();
  });
  it("can be cancelled and reports progress", async () => {
    const b = new ArrayBuffer(8 << 20);
    const s = new PointerScan(() => b, { target: 0x1000, maxOff: 16, levels: 2, staticLo: 0, staticHi: 0x100 });
    const p = s.run(1);
    s.cancel();
    await p;
    expect(s.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
import { ReverseMap } from "../src/page/pointer";
import { parseAddressExpr, formatChain } from "../src/shared/addrexpr";

describe("reverse pointer map", () => {
  it("indexes only aligned in-range pointers, sorted by target then source", async () => {
    const b = new ArrayBuffer(0x200000); const dv = new DataView(b);
    dv.setUint32(0x2000, 0x150000, true);
    dv.setUint32(0x2004, 0x150000, true);          // same target, higher source
    dv.setUint32(0x2008, 0x150001, true);          // unaligned value: ignored
    dv.setUint32(0x200c, 0x800, true);             // below 0x1000: ignored
    dv.setUint32(0x2010, 0x200000, true);          // == memSize: ignored
    dv.setUint32(0x2014, 0x4000, true);
    dv.setUint32(0x1f0000, 0x4000, true);          // different 64K bucket for the source, same target
    dv.setUint32(0x180000, 0x1fff00, true);
    const m = (await ReverseMap.build(() => b))!;
    expect(Array.from(m.targets)).toEqual([0x4000, 0x4000, 0x150000, 0x150000, 0x1fff00]);
    expect(Array.from(m.sources)).toEqual([0x2014, 0x1f0000, 0x2000, 0x2004, 0x180000]);
    for (let i = 1; i < m.length; i++) expect(m.targets[i]!).toBeGreaterThanOrEqual(m.targets[i - 1]!);
  });
  it("range queries match a brute-force scan on random memory (incl. bucket boundaries)", async () => {
    const b = new ArrayBuffer(0x400000); const w = new Uint32Array(b);
    let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
    for (let i = 0; i < w.length; i += 3) w[i] = (rnd() % 0x100000) * 4;   // lots of pointers, many equal targets
    const m = (await ReverseMap.build(() => b))!;
    const brute = (lo: number, hi: number) => { const o: number[][] = []; for (let i = 0; i < w.length; i++) { const v = w[i]!; if (v >= 0x1000 && v < b.byteLength && (v & 3) === 0 && v >= lo && v <= hi) o.push([v, i * 4]); } return o.sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]!); };
    for (const [lo, hi] of [[0, 0xffff], [0xfff0, 0x10010], [0x1ffff0, 0x200010], [0x12345, 0x12345 + 0x400], [0x3ff000, 0x3fffff]] as const) {
      const got: number[][] = [];
      m.forRange(lo, hi, (t, s) => got.push([t, s]));
      expect(got, `${lo}-${hi}`).toEqual(brute(lo, hi));
    }
  });
  it("handles an empty memory and honours the pointer cap", async () => {
    const empty = new ArrayBuffer(0x10000);
    const m = (await ReverseMap.build(() => empty))!;
    expect(m.length).toBe(0);
    let n = 0; m.forRange(0, 0xffffffff, () => n++); expect(n).toBe(0);
    const b = new ArrayBuffer(0x10000); new Uint32Array(b).fill(0x4000);
    await expect(ReverseMap.build(() => b, { maxPairs: 10 })).rejects.toThrow(/exceeds the index cap/);
  });
});

describe("pointer scan: vtable filter", () => {
  // layout: static cells 0x4000 (-> real object, has a vtable) and 0x4004 (-> list node, no vtable); both reach the target
  function world() {
    const b = mem(); const dv = new DataView(b);
    dv.setUint32(0x300, 0x500, true);        // vtable lives at 0x300 (.rodata, inside the "static data" range)
    dv.setUint32(0x4000, 0x14000, true);     // static cell -> object A
    dv.setUint32(0x14000, 0x300, true);      //   A has a vptr
    dv.setUint32(0x14010, 0x18000, true);    //   A.field -> data block
    dv.setUint32(0x4004, 0x16000, true);     // static cell -> node B
    dv.setUint32(0x16000, 0x1a000, true);    //   B[0] is a "next" pointer, not a vptr
    dv.setUint32(0x16010, 0x18000, true);
    return b;
  }
  const base = { target: 0x18024, maxOff: 0x100, levels: 3, staticLo: 0x100, staticHi: 0x8000 };
  it("without the filter both roots are reported", async () => {
    const w = world();
    const sc = new PointerScan(() => w, base); await sc.run();
    expect(sc.results.map((r) => r.base).sort()).toEqual([0x4000, 0x4004]);
  });
  it("with the filter only the object whose first word points into static data survives", async () => {
    const b = world();
    const sc = new PointerScan(() => b, { ...base, requireVtable: true, vtLo: 0x100, vtHi: 0x1000 }); await sc.run();
    expect(sc.results.map((r) => r.base)).toEqual([0x4000]);
    expect(sc.results[0]!.offsets).toEqual([0x10, 0x24]);
    expect(sc.vtableRejected).toBeGreaterThan(0);
    expect(resolveChain(b, sc.results[0]!)).toBe(0x18024);
  });
});

describe("pointer scan: Wasm globals as roots", () => {
  it("finds [$g7+0x10]+0x24 and resolves it through the global; vtable filter applies to global roots too", async () => {
    const b = mem(); const dv = new DataView(b);
    dv.setUint32(0x300, 0x500, true);
    dv.setUint32(0x14000, 0x300, true);   // object has a vptr
    dv.setUint32(0x14010, 0x18000, true);
    dv.setUint32(0x16000, 0x1a000, true); // no vptr
    dv.setUint32(0x16010, 0x18000, true);
    const globals = [{ idx: 7, value: 0x14000 }, { idx: 9, value: 0x16000 }];
    const p = { target: 0x18024, maxOff: 0x100, levels: 2, staticLo: 0x100, staticHi: 0x200, globals };
    const all = new PointerScan(() => b, p); await all.run();
    expect(all.results.map((r) => r.global).sort()).toEqual([7, 9]);
    const vt = new PointerScan(() => b, { ...p, requireVtable: true, vtLo: 0x100, vtHi: 0x1000 }); await vt.run();
    expect(vt.results).toEqual([{ base: -1, global: 7, offsets: [0x10, 0x24] }]);
    const g = (i: number) => (i === 7 ? 0x14000 : null);
    expect(resolveChain(b, vt.results[0]!, g)).toBe(0x18024);
    // "restart": the global now points at a new object
    dv.setUint32(0x1c010, 0x1e000, true);
    expect(resolveChain(b, vt.results[0]!, (i) => (i === 7 ? 0x1c000 : null))).toBe(0x1e024);
    expect(resolveChain(b, vt.results[0]!)).toBeNull(); // no global reader -> unresolved, not a crash
  });
  it("global roots are exported by the rewriter and can be read; $g syntax round-trips", async () => {
    const { default: wabtInit } = await import("wabt");
    const wabt = await wabtInit();
    const bin = wabt.parseWat("t.wat", `(module (memory 1) (global $a (mut i32) (i32.const 0x1000)) (global $b i32 (i32.const 0x2000)) (global $c (mut i64) (i64.const 1)) (func (export "f") i32.const 0 i32.load drop))`, {}).toBinary({}).buffer as Uint8Array;
    const { parseModule } = await import("../src/wasm/module");
    const { rewriteModule, DEFAULT_INSTRUMENT } = await import("../src/wasm/rewrite");
    const rr = rewriteModule(parseModule(bin), { instrument: { ...DEFAULT_INSTRUMENT, funcHooks: false } });
    const { instance } = await WebAssembly.instantiate(rr.bytes as BufferSource, { __cetus: { hit() {}, fhit() {} } });
    const e = instance.exports as any;
    expect(e.__c_g0.value).toBe(0x1000);
    expect(e.__c_g1.value).toBe(0x2000);
    expect(e.__c_g2).toBeUndefined(); // i64 is not a pointer root
    const x = parseAddressExpr("[$g12+0x34]+0x18");
    expect(x).toEqual({ kind: "ptr", chain: { base: -1, global: 12, offsets: [0x34, 0x18] } });
    expect(formatChain((x as any).chain)).toBe("[$g12+0x34]+0x18");
    expect(parseAddressExpr("[[g3]+0x8]").kind).toBe("ptr");
    expect(parseAddressExpr("[0x4a2220]+0x34")).toEqual({ kind: "ptr", chain: { base: 0x4a2220, offsets: [0x34] } });
  });
});
