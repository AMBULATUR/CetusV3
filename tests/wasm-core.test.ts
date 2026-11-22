import { describe, it, expect } from "vitest";
import wabtInit from "wabt";
import { parseModule } from "../src/wasm/module";
import { rewriteModule, DEFAULT_INSTRUMENT } from "../src/wasm/rewrite";
import { disassembleBody, assemble } from "../src/wasm/text";
import { OPS } from "../src/wasm/opcodes";

const wabt = await wabtInit();
const FEATURES = { simd: true, threads: true, bulk_memory: true, reference_types: true, exceptions: true, tail_call: true, multi_value: true, sat_float_to_int: true, sign_extension: true, extended_const: true };
const compile = (wat: string) => {
  const m = wabt.parseWat("t.wat", wat, FEATURES);
  const { buffer } = m.toBinary({ write_debug_names: true });
  return buffer as Uint8Array;
};

describe("opcode table", () => {
  it("has unique names and sane access sizes", () => {
    const names = new Set(OPS.map((o) => o.name));
    expect(names.size).toBe(OPS.length);
    const sz = (n: string) => OPS.find((o) => o.name === n)!.access!.size;
    expect(sz("i32.load")).toBe(4);
    expect(sz("i64.load32_u")).toBe(4);
    expect(sz("i32.store16")).toBe(2);
    expect(sz("i64.atomic.rmw.add")).toBe(8);
    expect(sz("i32.atomic.rmw8.add_u")).toBe(1);
    expect(sz("v128.load8x8_s")).toBe(8);
    expect(sz("v128.load")).toBe(16);
    expect(sz("v128.store8_lane")).toBe(1);
  });
});

const BASIC = `(module
  (import "env" "log" (func $log (param i32)))
  (memory (export "memory") 1)
  (global $g (mut i32) (i32.const 5))
  (table 2 funcref)
  (elem (i32.const 0) $inc $get)
  (func $inc (export "inc") (param i32) (result i32) local.get 0 i32.const 1 i32.add)
  (func $get (export "get") (param $a i32) (result i32) local.get $a i32.load offset=4)
  (func $set (export "set") (param i32 i32) local.get 0 local.get 1 i32.store)
  (func $set8 (export "set8") (param i32 i32) local.get 0 local.get 1 i32.store8)
  (func $set64 (export "set64") (param i32 i64) local.get 0 local.get 1 i64.store)
  (func $viaTable (export "viaTable") (param i32) (result i32) local.get 0 i32.const 0 call_indirect (param i32) (result i32))
  (func $callInc (export "callInc") (param i32) (result i32) local.get 0 call $inc call $log i32.const 0)
  (start $init)
  (func $init i32.const 0 call $log)
)`;

async function run(wat: string, cfg = DEFAULT_INSTRUMENT) {
  const bin = compile(wat);
  const m = parseModule(bin);
  const rr = rewriteModule(m, { instrument: cfg });
  expect(WebAssembly.validate(rr.bytes as BufferSource), "instrumented module must validate").toBe(true);
  return { m, rr, bin };
}

describe("rewriter", () => {
  it("instruments a basic module and keeps semantics", async () => {
    const { rr } = await run(BASIC);
    expect(rr.instrumented).toBe(true);
    expect(rr.K).toBe(2);
    const hits: number[][] = [];
    const logs: number[] = [];
    const imports = { env: { log: (x: number) => logs.push(x) }, __cetus: { hit: (k: number, s: number) => hits.push([k, s]), fhit: (s: number, i: number) => hits.push([100 + s, i]) } };
    const { instance } = await (WebAssembly as any).instantiate(rr.bytes, imports);
    const e = instance.exports as any;
    expect(logs).toEqual([0]); // start function ran, index shifted correctly
    expect(e.callInc(41)).toBe(0);
    expect(logs).toEqual([0, 42]);
    expect(e.viaTable(7)).toBe(8); // element segment remapped
    expect(rr.memoryExport).toBeNull();
  });

  it("write watch detects change, freeze reverts", async () => {
    const { rr } = await run(BASIC);
    const hits: number[][] = [];
    const imports = { env: { log() {} }, __cetus: { hit: (k: number, s: number) => hits.push([k, s]), fhit() {} } };
    const { instance } = await (WebAssembly as any).instantiate(rr.bytes, imports);
    const e = instance.exports as any;
    const mem = new DataView(e.memory.buffer);
    mem.setUint32(100, 11, true);
    // slot 0: watch writes at 100 size 4
    e.__c_wa0.value = 100; e.__c_ws0.value = 4; e.__c_wf0.value = 2; e.__c_wv0.value = 11n; e.__c_wen.value = 1;
    e.set(100, 11); // same value -> no hit
    expect(hits).toEqual([]);
    e.set(100, 12);
    expect(hits).toEqual([[2, 0]]);
    // freeze at 12
    e.__c_wf0.value = 4; e.__c_wv0.value = 12n;
    e.set(100, 99);
    expect(mem.getUint32(100, true)).toBe(12);
    // 1-byte slot and 8-byte slot
    e.__c_wa1.value = 200; e.__c_ws1.value = 1; e.__c_wf1.value = 6; e.__c_wv1.value = 0n;
    e.set8(200, 7);
    expect(mem.getUint8(200)).toBe(0);
    expect(hits.some((h) => h[1] === 1)).toBe(true);
    e.__c_wa2.value = 300; e.__c_ws2.value = 8; e.__c_wf2.value = 4; e.__c_wv2.value = 0x1122334455667788n;
    mem.setBigUint64(300, 0x1122334455667788n, true);
    e.set64(300, 5n);
    expect(mem.getBigUint64(300, true)).toBe(0x1122334455667788n);
  });

  it("read watch fires with offsets and function breakpoints work", async () => {
    const { rr } = await run(BASIC);
    const hits: number[][] = [];
    const imports = { env: { log() {} }, __cetus: { hit: (k: number, s: number) => hits.push([k, s]), fhit: (s: number, i: number) => hits.push([100 + s, i]) } };
    const { instance } = await (WebAssembly as any).instantiate(rr.bytes, imports);
    const e = instance.exports as any;
    e.__c_wa0.value = 104; e.__c_ws0.value = 4; e.__c_wf0.value = 1; e.__c_ren.value = 1;
    e.get(100); // reads 104 via offset=4
    expect(hits).toEqual([[1, 0]]);
    e.get(200);
    expect(hits.length).toBe(1);
    // function bp on original index of $inc (imports: 1 -> $inc = 1)
    e.__c_fb0.value = 1; e.__c_fen.value = 1;
    e.callInc(1);
    expect(hits).toContainEqual([100, 1]);
    // trace mode
    hits.length = 0; e.__c_fen.value = 2;
    e.callInc(1);
    expect(hits.filter((h) => h[0] === 99).map((h) => h[1])).toContain(7); // callInc itself
  });

  it("exports defined memory when not exported; patches replace bodies", async () => {
    const wat = `(module (memory 1) (func (export "f") (result i32) i32.const 1))`;
    const bin = compile(wat);
    const m = parseModule(bin);
    const rr = rewriteModule(m, { instrument: null, patches: [{ index: 0, code: assemble("i32.const 77\nend").code }] });
    expect(rr.memoryExport).toBe("__c_mem");
    const { instance } = await (WebAssembly as any).instantiate(rr.bytes, {});
    expect((instance.exports as any).f()).toBe(77);
    expect((instance.exports as any).__c_mem).toBeInstanceOf(WebAssembly.Memory);
  });
});

const MODERN = `(module
  (memory (export "mem") 1 1 shared)
  (data "hello")
  (tag $e (param i32))
  (func $f (export "f") (param i32) (result i32)
    (local v128 i64)
    local.get 0 i32.extend8_s drop
    f32.const 1.5 i32.trunc_sat_f32_s drop
    i32.const 0 i32.const 0 i32.const 4 memory.copy
    i32.const 0 i32.const 1 i32.const 4 memory.fill
    i32.const 0 v128.load drop
    i32.const 0 i32.const 0 i32.atomic.rmw.add drop
    i32.const 0 i32.atomic.load drop
    v128.const i32x4 1 2 3 4
    i8x16.extract_lane_u 3 drop
    v128.const i32x4 1 2 3 4 v128.const i32x4 1 2 3 4 i8x16.shuffle 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 drop
    try (result i32)
      i32.const 1 throw $e
    catch $e
    end
    drop
    block (result i32) i32.const 3 br 0 end
    return_call $g)
  (func $g (param i32) (result i32) local.get 0)
)`;

describe("modern features", () => {
  it("rewrites SIMD/atomics/bulk/EH/tail-call modules to valid wasm", async () => {
    const bin = compile(MODERN);
    const m = parseModule(bin);
    expect(m.warnings).toEqual([]);
    const rr = rewriteModule(m, { instrument: DEFAULT_INSTRUMENT });
    expect(WebAssembly.validate(rr.bytes as BufferSource)).toBe(true);
  });

  it("disassembly reassembles to identical bytes", () => {
    const bin = compile(MODERN);
    const m = parseModule(bin);
    for (const b of m.bodies) {
      const d = disassembleBody(m.bytes, b.start, b.end);
      expect(d.error).toBeUndefined();
      const a = assemble(d.text);
      const orig = m.bytes.subarray(b.start, b.end);
      const h = Array.from(orig);
      const rebuilt = [...(a.locals ?? [0]), ...a.code];
      expect(rebuilt).toEqual(h);
    }
  });
});

import { analyze, findStaticLayout } from "../src/wasm/analysis";

describe("static layout detection", () => {
  it("threaded-style module: passive data + memory.init/fill from the start function", () => {
    const wat = `(module
      (memory 1 1 shared)
      (data $d "abcdefgh")
      (func $initmem
        (memory.init $d (i32.const 1024) (i32.const 0) (i32.const 8))
        (memory.fill (i32.const 9216) (i32.const 0) (i32.const 3072)))
      (func $outer (call $initmem))
      (start $outer))`;
    const m = parseModule(compile(wat));
    // the old logic (active segments only) sees nothing here
    expect(m.data.every((d) => d.mode === "passive")).toBe(true);
    const L = findStaticLayout(m, analyze(m));
    expect(L.end).toBe(9216 + 3072);
    expect(L.source).toMatch(/start-up/);
  });
  it("classic module: active data segments", () => {
    const m = parseModule(compile(`(module (memory 1) (data (i32.const 2048) "0123456789"))`));
    const L = findStaticLayout(m, analyze(m));
    expect(L.end).toBe(2058);
    expect(L.source).toBe("active data segments");
  });
});

describe("line breakpoints (instruction-level capture)", () => {
  const WAT = `(module
    (memory (export "m") 1)
    (func (export "work") (param $p i32) (param $v i32) (result i32) (local $t i64)
      i64.const 77 local.set $t
      local.get $p local.get $v i32.store offset=12
      local.get $p i32.load offset=4 drop
      local.get $p f64.convert_i32_u f64.const 1.5 f64.add drop
      local.get $p local.get $v i32.add)
    (func (export "f32store") (param $p i32) local.get $p f32.const 2.5 f32.store offset=8)
  )`;
  const offsetOf = (m: ReturnType<typeof parseModule>, fi: number, name: string) => {
    const b = m.bodies[fi]!;
    const d = disassembleBody(m.bytes, b.start, b.end);
    return d.lines.find((l) => l.name === name)!.off;
  };
  it("captures address, value, old value inputs and locals for store / load / generic sites; semantics unchanged", async () => {
    const m = parseModule(compile(WAT));
    const bps = [
      { func: 0, off: offsetOf(m, 0, "i32.store"), enabled: true },
      { func: 0, off: offsetOf(m, 0, "i32.load"), enabled: true },
      { func: 0, off: offsetOf(m, 0, "f64.add"), enabled: true },
      { func: 1, off: offsetOf(m, 1, "f32.store"), enabled: true },
    ];
    const rr = rewriteModule(m, { instrument: DEFAULT_INSTRUMENT, bps });
    expect(WebAssembly.validate(rr.bytes as BufferSource)).toBe(true);
    expect(rr.bp.found.map((f) => f?.kind)).toEqual(["store", "load", "generic", "store"]);
    expect(rr.bp.found[0]).toMatchObject({ name: "i32.store", size: 4, valType: 0x7f, offset: 12 });
    expect(rr.bp.found[0]!.localCodes).toEqual([0x7f, 0x7f, 0x7e]);
    const ev: any[] = [];
    const imports = { __cetus: {
      hit() {}, fhit() {},
      bp: (id: number, ea: number, bits: bigint) => ev.push({ id, ea, bits }),
      bpl: (id: number, idx: number, bits: bigint) => ev.push({ id, idx, bits }),
    } };
    const { instance } = await (WebAssembly as any).instantiate(rr.bytes, imports);
    const e = instance.exports as any;
    expect(e.work(100, 7)).toBe(107); // same result as the original
    expect(new DataView(e.m.buffer).getInt32(112, true)).toBe(7); // the store still happened
    const bp = (id: number) => ev.filter((x) => x.id === id && x.ea !== undefined);
    expect(bp(0)).toEqual([{ id: 0, ea: 112, bits: 7n }]); // effective address = 100 + offset 12, value 7
    expect(bp(1)).toEqual([{ id: 1, ea: 104, bits: 0n }]); // load at 100+4, value read (memory was zero)
    expect(bp(2).length).toBe(1);
    const locals0 = ev.filter((x) => x.id === 0 && x.idx !== undefined);
    expect(locals0).toEqual([{ id: 0, idx: 0, bits: 100n }, { id: 0, idx: 1, bits: 7n }, { id: 0, idx: 2, bits: 77n }]);
    e.f32store(40);
    expect(bp(3)[0]).toEqual({ id: 3, ea: 48, bits: BigInt(new DataView(new Float32Array([2.5]).buffer).getUint32(0, true)) });
    expect(new DataView(e.m.buffer).getFloat32(48, true)).toBe(2.5);
  });
  it("flags switch sites on and off at runtime; works together with watch/read/function hooks", async () => {
    const m = parseModule(compile(WAT));
    const rr = rewriteModule(m, { instrument: DEFAULT_INSTRUMENT, bps: [{ func: 0, off: offsetOf(m, 0, "i32.store"), enabled: false }] });
    const hits: number[] = [];
    const { instance } = await (WebAssembly as any).instantiate(rr.bytes, { __cetus: { hit() {}, fhit() {}, bp: (id: number) => hits.push(id), bpl() {} } });
    const e = instance.exports as any;
    e.work(0, 1);
    expect(hits).toEqual([]);
    e[rr.bp.flagNames[0]!].value = 1;
    e.work(0, 2);
    expect(hits).toEqual([0]);
    e.__c_wa0.value = 12; e.__c_ws0.value = 4; e.__c_wf0.value = 2; e.__c_wen.value = 1; // a write watch on the same address still fires
    e.work(0, 3);
    expect(hits).toEqual([0, 0]);
  });
  it("ignores unknown / patched / out-of-range requests safely", () => {
    const m = parseModule(compile(WAT));
    const rr = rewriteModule(m, { instrument: null, bps: [{ func: 99, off: 0, enabled: true }, { func: 0, off: 4, enabled: true }] });
    expect(WebAssembly.validate(rr.bytes as BufferSource)).toBe(true);
    expect(rr.bp.found.length).toBe(1);
    expect(rr.bp.found[0]).toBeNull(); // offset 4 is inside an instruction
  });
});
