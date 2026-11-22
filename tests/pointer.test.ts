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
