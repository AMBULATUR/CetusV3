import { describe, it, expect } from "vitest";
import { Worker } from "node:worker_threads";
import wabtInit from "wabt";
import { parseModule } from "../src/wasm/module";
import { rewriteModule, CTRL, DEFAULT_INSTRUMENT } from "../src/wasm/rewrite";
import { WatchMem } from "../src/page/watchmem";

const wabt = await wabtInit();
const FEATURES = { simd: true, threads: true, bulk_memory: true, reference_types: true, exceptions: true, tail_call: true, multi_value: true, sat_float_to_int: true, sign_extension: true, extended_const: true };
const compile = (wat: string) => wabt.parseWat("t.wat", wat, FEATURES).toBinary({ write_debug_names: true }).buffer as Uint8Array;

/** every instruction that reads memory, one exported function each, all taking the address as param 0 */
const READERS: [string, string][] = [
  ["load", "local.get 0 i32.load drop"],
  ["i64load", "local.get 0 i64.load drop"],
  ["atomic_load", "local.get 0 i32.atomic.load drop"],
  ["atomic_load64", "local.get 0 i64.atomic.load drop"],
  ["atomic_load8", "local.get 0 i32.atomic.load8_u drop"],
  ["atomic_load16", "local.get 0 i32.atomic.load16_u drop"],
  ["v128_load", "local.get 0 v128.load drop"],
  ["v128_load32_splat", "local.get 0 v128.load32_splat drop"],
  ["v128_load8x8_s", "local.get 0 v128.load8x8_s drop"],
  ["v128_load32_zero", "local.get 0 v128.load32_zero drop"],
  ["v128_load32_lane", "local.get 0 v128.const i32x4 1 2 3 4 v128.load32_lane 1 drop"],
  ["rmw_add", "local.get 0 i32.const 1 i32.atomic.rmw.add drop"],
  ["rmw64_xchg", "local.get 0 i64.const 1 i64.atomic.rmw.xchg drop"],
  ["cmpxchg", "local.get 0 i32.const 0 i32.const 5 i32.atomic.rmw.cmpxchg drop"],
];
const wat = (importMem: boolean) => `(module
  ${importMem ? '(import "env" "memory" (memory 1 1 shared))' : '(memory (export "mem") 1 1 shared)'}
  ${READERS.map(([n, body]) => `(func (export "${n}") (param i32) ${body})`).join("\n  ")}
  (func (export "store") (param i32 i32) local.get 0 local.get 1 i32.store)
)`;

const noCfg = { ...DEFAULT_INSTRUMENT, funcHooks: false };
const ADDR = 0x2000;

describe("read watchpoints hook every kind of load", () => {
  it("(globals mode) atomic, SIMD, lane and read-modify-write loads all fire", async () => {
    const m = parseModule(compile(wat(false)));
    const rr = rewriteModule(m, { instrument: noCfg });
    expect(WebAssembly.validate(rr.bytes as BufferSource)).toBe(true);
    const hits: number[][] = [];
    const { instance } = await WebAssembly.instantiate(rr.bytes as BufferSource, { __cetus: { hit: (k: number, s: number) => hits.push([k, s]), fhit() {} } });
    const e = instance.exports as any;
    e.__c_wa0.value = ADDR; e.__c_ws0.value = 4; e.__c_wf0.value = 1; e.__c_ren.value = 1;
    for (const [name] of READERS) {
      hits.length = 0;
      e[name](ADDR);
      expect(hits, name).toEqual([[1, 0]]);
      hits.length = 0;
      e[name](ADDR + 0x100);
      expect(hits, name + " (miss)").toEqual([]);
    }
  });
});

describe("shared-memory watch table", () => {
  it("main-thread build reads its slots from linear memory (no per-instance globals)", async () => {
    const m = parseModule(compile(wat(false)));
    const rr = rewriteModule(m, { instrument: noCfg, shared: { ctrl: CTRL.DEFAULT_ADDR } });
    expect(rr.shared).toEqual({ ctrl: CTRL.DEFAULT_ADDR, ring: false });
    expect(rr.globals.addr).toEqual([]);
    const hits: number[][] = [];
    const { instance } = await WebAssembly.instantiate(rr.bytes as BufferSource, { __cetus: { hit: (k: number, s: number) => hits.push([k, s]), fhit() {} } });
    const e = instance.exports as any;
    const wm = new WatchMem(e.mem as WebAssembly.Memory, CTRL.DEFAULT_ADDR);
    wm.init();
    wm.arm(3, ADDR, 4, 1, 0n);
    wm.setEnables(false, true);
    e.v128_load32_lane(ADDR);
    expect(hits).toEqual([[1, 3]]);
    wm.setEnables(false, false);
    e.load(ADDR);
    expect(hits.length).toBe(1);
  });

  it("falls back to globals (with a warning) when the memory is not shared or the block is occupied", () => {
    const plain = parseModule(compile(`(module (memory 1) (func (export "f") i32.const 0 i32.load drop))`));
    const a = rewriteModule(plain, { instrument: noCfg, shared: { ctrl: 0x20 } });
    expect(a.shared).toBeNull();
    expect(a.warnings.join()).toMatch(/not shared/);
    const busy = parseModule(compile(`(module (memory 1 1 shared) (data (i32.const 0x40) "hello") (func (export "f") i32.const 0 i32.load drop))`));
    const b = rewriteModule(busy, { instrument: noCfg, shared: { ctrl: 0x20 } });
    expect(b.shared).toBeNull();
    expect(b.warnings.join()).toMatch(/overlaps/);
  });

  it("a Web Worker running the worker-safe (import-free) build trips watchpoints armed from the main thread", async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const m = parseModule(compile(wat(true)));
    const rr = rewriteModule(m, { instrument: noCfg, shared: { ctrl: CTRL.DEFAULT_ADDR, ring: true } });
    expect(rr.K).toBe(0); // no imports: nothing for a worker to be missing
    expect(WebAssembly.Module.imports(new WebAssembly.Module(rr.bytes as BufferSource)).map((i) => i.module)).toEqual(["env"]);

    const wm = new WatchMem(memory, CTRL.DEFAULT_ADDR);
    wm.init();
    const names = READERS.map(([n]) => n);
    const readSlot = 0, writeSlot = 1, freezeSlot = 2;
    wm.arm(readSlot, ADDR, 4, 1, 0n);
    new DataView(memory.buffer).setUint32(ADDR + 0x40, 0xdeadbeef, true);
    wm.arm(writeSlot, ADDR + 0x40, 4, 2, 0xdeadbeefn);
    new DataView(memory.buffer).setUint32(ADDR + 0x80, 1234, true);
    wm.arm(freezeSlot, ADDR + 0x80, 4, 4, 1234n);
    wm.setEnables(true, true);

    const code = `
      const { parentPort, workerData: d } = require("node:worker_threads");
      WebAssembly.instantiate(d.mod, { env: { memory: d.memory } }).then(({ exports: e }) => {
        for (const n of d.names) e[n](d.addr);
        e.store(d.addr + 0x40, 7);        // write watch
        e.store(d.addr + 0x80, 999);      // frozen: must be undone
        parentPort.postMessage("done");
      });`;
    await new Promise<void>((resolve, reject) => {
      const w = new Worker(code, { eval: true, workerData: { mod: new WebAssembly.Module(rr.bytes as BufferSource), memory, names, addr: ADDR } });
      w.on("message", () => resolve());
      w.on("error", reject);
    });

    const dv = new DataView(memory.buffer);
    expect(dv.getUint32(ADDR + 0x80, true)).toBe(1234); // freeze enforced by the worker
    expect(dv.getUint32(ADDR + 0x40, true)).toBe(7); // plain write watch does not block the store

    const got = wm.drain();
    const total = wm.total();
    // ring is small and the worker runs flat out, so tolerate overwritten entries but never wrong ones
    expect(got.length + wm.lost).toBe(total);
    expect(total).toBe(READERS.length + 1 /* the write-watch store; a freeze-only slot reverts silently */);
    for (const h of got) {
      if (h.kind === 1) { expect(h.slot).toBe(readSlot); expect(h.ea).toBe(ADDR); }
      else expect(h.slot).toBe(writeSlot);
      expect(h.func).toBeGreaterThanOrEqual(0);
      expect(h.off).toBeGreaterThan(0);
    }
    // the newest entry is intact: it is the watched store, attributed to the `store` function
    const storeFn = names.length; // defined function #n (no imports)
    const last = got[got.length - 1]!;
    expect(last.kind).toBe(2);
    expect(last.func).toBe(storeFn);
  });
});

import { disassembleBody } from "../src/wasm/text";

describe("line breakpoints inside Web Workers (worker-safe build)", () => {
  const WAT = `(module
    (import "env" "memory" (memory 1 1 shared))
    (func (export "readHp") (param i32) (result f64)
      local.get 0
      i32.load offset=216
      f32.load offset=140
      f64.promote_f32)
    (func (export "poke") (param i32 i32) local.get 0 local.get 1 i32.store offset=4))`;

  it("a breakpoint on `f32.load offset=140` fires in the worker, with ea (offset included), value, exact count, cond-ready data", async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const m = parseModule(compile(WAT));
    const offOf = (fi: number, name: string) => { const b = m.bodies[fi]!; return disassembleBody(m.bytes, b.start, b.end).lines.find((l) => l.name === name)!.off; };
    const bps = [{ func: 0, off: offOf(0, "f32.load"), enabled: true }, { func: 1, off: offOf(1, "i32.store"), enabled: false }];
    const rr = rewriteModule(m, { instrument: noCfg, bps, shared: { ctrl: CTRL.DEFAULT_ADDR, ring: true } });
    expect(rr.K).toBe(0);
    expect(rr.bp.reqs.length).toBe(2);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(rr.bytes as BufferSource)).map((i) => i.module)).toEqual(["env"]);

    // object at 0x3000 holds a pointer (at +216) to a struct at 0x5000 whose float at +140 is 321.5
    const dv = new DataView(memory.buffer);
    dv.setUint32(0x3000 + 216, 0x5000, true);
    dv.setFloat32(0x5000 + 140, 321.5, true);
    const wm = new WatchMem(memory, CTRL.DEFAULT_ADDR);
    wm.init();
    wm.setBpEnabled(0, true);
    wm.setBpEnabled(1, false);

    const code = `
      const { parentPort, workerData: d } = require("node:worker_threads");
      WebAssembly.instantiate(d.mod, { env: { memory: d.memory } }).then(({ exports: e }) => {
        const r = [];
        for (let i = 0; i < 5; i++) r.push(e.readHp(0x3000));
        e.poke(0x6000, 1);               // site 1 is disabled: must not report
        parentPort.postMessage(r);
      });`;
    const res = await new Promise<number[]>((resolve, reject) => {
      const w = new Worker(code, { eval: true, workerData: { mod: new WebAssembly.Module(rr.bytes as BufferSource), memory } });
      w.on("message", resolve); w.on("error", reject);
    });
    expect(res).toEqual([321.5, 321.5, 321.5, 321.5, 321.5]); // semantics unchanged

    expect(wm.bpCount(0)).toBe(5);   // exact, even though the ring only keeps 16 entries
    expect(wm.bpCount(1)).toBe(0);   // disabled in shared memory
    const hits = wm.drain().filter((h) => h.kind === 3);
    expect(hits.length).toBe(5);
    for (const h of hits) {
      expect(h.slot).toBe(0);
      expect(h.ea).toBe(0x5000 + 140);                       // effective address = base + offset=140
      expect(h.func).toBe(0);
      expect(h.off).toBe(bps[0]!.off);
      const f = new DataView(new ArrayBuffer(4)); f.setUint32(0, Number(h.bits! & 0xffffffffn), true);
      expect(f.getFloat32(0, true)).toBe(321.5);             // the loaded value
    }
    wm.clearBpCounts();
    expect(wm.bpCount(0)).toBe(0);
  });
});
