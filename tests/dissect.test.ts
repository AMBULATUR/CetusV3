import { describe, it, expect } from "vitest";
import {
  guessField, layoutBlock, retype, buildPath, followSteps, exportC, exportJs, Root, isHeapPtr, isPlausibleF32, printableRun, Env, Block, Field,
} from "../src/shared/dissect";
import { resolveChain } from "../src/page/pointer";
import { parseAddressExpr } from "../src/shared/addrexpr";

const MEM = 0x20000;
const mk = (words: Record<number, number>, n = 0x40) => {
  const b = new Uint8Array(n); const dv = new DataView(b.buffer);
  for (const [o, v] of Object.entries(words)) dv.setUint32(Number(o), v >>> 0, true);
  return b;
};
const f32 = (x: number) => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, x, true); return d.getUint32(0, true); };
const env = (first: Record<number, number> = {}, vt: Env["vt"] = { lo: 0x100, hi: 0x1000 }): Env => ({ memSize: MEM, vt, readU32: (a) => first[a] ?? null });

describe("auto type guessing", () => {
  it("ptr: aligned value in 0x1000..memSize", () => {
    expect(isHeapPtr(0x14000, MEM)).toBe(true);
    expect(isHeapPtr(0x14002, MEM)).toBe(false);   // unaligned
    expect(isHeapPtr(0xfff, MEM)).toBe(false);     // below 0x1000
    expect(isHeapPtr(MEM, MEM)).toBe(false);       // == memSize
    expect(guessField(mk({ 0: 0x14000 }), 0, env()).type).toBe("ptr");
  });
  it("[vtable] badge only when [val] lands in static data", () => {
    expect(guessField(mk({ 0: 0x14000 }), 0, env({ 0x14000: 0x300 }))).toEqual({ type: "ptr", size: 4, vtable: true });
    expect(guessField(mk({ 0: 0x14000 }), 0, env({ 0x14000: 0x16000 })).vtable).toBe(false);
    expect(guessField(mk({ 0: 0x14000 }), 0, env({ 0x14000: 0x300 }, null)).vtable).toBe(false); // range unknown
  });
  it("f32: finite, 1e-5..1e6, not a small integer", () => {
    for (const x of [1.5, -3.25, 100, 0.001, 123456, 1.1e-5, 1e6]) expect(guessField(mk({ 0: f32(x) }), 0, env()).type, String(x)).toBe("f32");
    for (const x of [2e6, 1e-6, 0]) expect(guessField(mk({ 0: f32(x) }), 0, env()).type, String(x)).toBe("i32");
    expect(isPlausibleF32(0x7fc00000)).toBe(false);   // NaN
    expect(isPlausibleF32(0x7f800000)).toBe(false);   // Inf
    expect(isPlausibleF32(5)).toBe(false);            // the integer 5 is not a float
    expect(guessField(mk({ 0: 1234 }), 0, env()).type).toBe("i32");
    expect(guessField(mk({ 0: 0xfffffff0 }), 0, env()).type).toBe("i32");
  });
  it("f32 vs pointer ambiguity in a big heap: pointer only with a vtable", () => {
    const big: Env = { memSize: 0x60000000, vt: { lo: 0x100, hi: 0x1000 }, readU32: (a) => (a === 0x3f800000 ? 0x300 : null) };
    const one = f32(1.0); // 0x3f800000: aligned, in range, also exactly 1.0f
    expect(guessField(mk({ 0: one }), 0, { ...big, readU32: () => null }).type).toBe("f32");
    expect(guessField(mk({ 0: one }), 0, big).type).toBe("ptr");
  });
  it("string: 4+ consecutive printable bytes, size rounds up with the terminator", () => {
    const b = new Uint8Array(32); b.set(new TextEncoder().encode("Hello"), 0);   // 5 chars + NUL
    expect(guessField(b, 0, env())).toEqual({ type: "string", size: 8 });
    const c = new Uint8Array(16); c.set(new TextEncoder().encode("abcd"), 4);    // exactly 4, no NUL inside the window start
    expect(guessField(c, 4, env()).type).toBe("string");
    const d = new Uint8Array(16); d.set(new TextEncoder().encode("abc"), 0);     // only 3: not text
    expect(guessField(d, 0, env()).type).not.toBe("string");
    expect(printableRun(b, 0)).toBe(5);
  });
  it("unaligned or truncated reads degrade to u8", () => {
    expect(guessField(mk({}), 2, env()).type).toBe("u8");
    expect(guessField(new Uint8Array(3), 0, env()).type).toBe("u8");
  });
});

describe("layoutBlock / retype", () => {
  const b = mk({ 0: 0x14000, 4: f32(2.5), 8: 77, 12: 0x41424344 /* ABCD */ }, 0x20);
  it("covers the block exactly, in order, without overlaps", () => {
    const l = layoutBlock(b, 0x20, env({ 0x14000: 0x300 }));
    expect(l.map((f) => [f.off, f.type])).toEqual([[0, "ptr"], [4, "f32"], [8, "i32"], [12, "string"], [20, "i32"], [24, "i32"], [28, "i32"]]);
    expect(l[0]!.vtable).toBe(true);
    let at = 0; for (const f of l) { expect(f.off).toBe(at); at += f.size; } expect(at).toBe(0x20);
  });
  it("user fields are kept and gaps re-filled when a field is retyped", () => {
    let l = layoutBlock(b, 0x20, env());
    l = retype(l, 8, "u8", b, 0x20, env());
    const f8 = l.find((f) => f.off === 8)!;
    expect(f8).toMatchObject({ type: "u8", size: 1, user: true });
    expect(l.find((f) => f.off === 9)!.type).toBe("u8");           // 3 byte gap: u8 + u16 (aligned)… never overlapping
    let at = 0; for (const f of l) { expect(f.off).toBe(at); at += f.size; } expect(at).toBe(0x20);
    // widening swallows the following fields instead of overlapping them
    l = retype(l, 0, "u64", b, 0x20, env());
    expect(l[0]).toMatchObject({ off: 0, type: "u64", size: 8 });
    expect(l[1]!.off).toBe(8);
  });
  it("re-laying out keeps user names/types", () => {
    const fixed: Field[] = [{ off: 4, type: "i32", size: 4, name: "health", desc: "hp", user: true }];
    const l = layoutBlock(b, 0x20, env(), fixed);
    expect(l.find((f) => f.off === 4)).toMatchObject({ name: "health", type: "i32", user: true });
  });
});

describe("nested pointer path generation", () => {
  // memory: static cell 0x4000 -> A(0x14000); A+0x10 -> B(0x18000); B+0x24 = value ; global g12 = A
  const buf = new ArrayBuffer(0x20000); const dv = new DataView(buf);
  dv.setUint32(0x4000, 0x14000, true); dv.setUint32(0x14010, 0x18000, true); dv.setUint32(0x18024, 1234, true);
  const rd = (a: number) => (a + 4 <= buf.byteLength ? dv.getUint32(a, true) : null);

  it("plain address root", () => {
    const root: Root = { kind: "addr", addr: 0x14000 };
    expect(buildPath(root, [0x8])).toEqual({ kind: "addr", addr: 0x14008 });
    const p = buildPath(root, [0x10, 0x24]);
    expect(p).toEqual({ kind: "ptr", chain: { base: 0x14010, offsets: [0x24] } });
    expect(resolveChain(buf, (p as any).chain)).toBe(0x18024);
  });
  it("static-cell root: [[0x4000]+0x10]+0x24", () => {
    const r = parseAddressExpr("[0x4000]");           // struct A lives where the cell points
    const root: Root = { kind: "ptr", chain: (r as any).chain };
    const p = buildPath(root, [0x10, 0x24]) as any;
    expect(p.chain).toEqual({ base: 0x4000, offsets: [0x10, 0x24] });
    expect(resolveChain(buf, p.chain)).toBe(0x18024);
    const direct = buildPath(root, [0x10]) as any;     // pointer field itself
    expect(resolveChain(buf, direct.chain)).toBe(0x14010);
  });
  it("offset in the root chain folds into the first step", () => {
    const root: Root = { kind: "ptr", chain: { base: 0x4000, offsets: [0x0] } };   // [0x4000]+0 = A
    expect((buildPath({ kind: "ptr", chain: { base: 0x4000, offsets: [-0x10] } }, [0x20]) as any).chain.offsets).toEqual([0x10]);
    expect((buildPath(root, [0x10, 0x24]) as any).chain.offsets).toEqual([0x10, 0x24]);
    // a three-deep expansion
    dv.setUint32(0x18030, 0x1a000, true); dv.setUint32(0x1a008, 99, true);
    const p = buildPath(root, [0x10, 0x30, 0x8]) as any;
    expect(p.chain.offsets).toEqual([0x10, 0x30, 0x8]);
    expect(resolveChain(buf, p.chain)).toBe(0x1a008);
  });
  it("Wasm-global root: [$g12+0x10]+0x24", () => {
    const parsed = parseAddressExpr("$g12");
    expect(parsed).toMatchObject({ kind: "ptr", chain: { base: -1, global: 12 } });
    const p = buildPath({ kind: "ptr", chain: (parsed as any).chain }, [0x10, 0x24]) as any;
    expect(p.chain).toEqual({ base: -1, global: 12, offsets: [0x10, 0x24] });
    expect(resolveChain(buf, p.chain, (i) => (i === 12 ? 0x14000 : null))).toBe(0x18024);
    expect(resolveChain(buf, p.chain, (i) => (i === 12 ? 0x14000 : null))).toBe(followSteps(rd, 0x14000, [0x10, 0x24]));
  });
  it("followSteps stops at unreadable pointers", () => {
    expect(followSteps(rd, 0x14000, [0x10, 0x24])).toBe(0x18024);
    expect(followSteps(rd, 0x14000, [0x10, 0x4, 0x8])).not.toBe(null); // 0x18004 holds 0 -> 0+8
    expect(followSteps(() => null, 0x14000, [0x10, 0x24])).toBeNull();
    expect(() => buildPath({ kind: "addr", addr: 0 }, [])).toThrow();
  });
});

describe("export", () => {
  const leaf: Block = { name: "Child_pos", size: 8, children: new Map(), fields: [
    { off: 0, type: "f32", size: 4, name: "x", desc: "", user: true }, { off: 4, type: "f32", size: 4, name: "y", desc: "", user: true }] };
  const root: Block = { name: "Player", size: 0x14, children: new Map([[4, leaf]]), fields: [
    { off: 0, type: "ptr", size: 4, name: "vtable", desc: "", user: true, vtable: true },
    { off: 4, type: "ptr", size: 4, name: "pos", desc: "", user: true },
    { off: 8, type: "i32", size: 4, name: "health", desc: "hit points", user: true },
    { off: 12, type: "string", size: 8, name: "my name!", desc: "", user: true }] };
  it("C struct: children first, typed child pointer, padding and size assert", () => {
    const c = exportC(root);
    expect(c.indexOf("struct Child_pos {")).toBeLessThan(c.indexOf("struct Player {"));
    expect(c).toContain("struct Child_pos *pos;");
    expect(c).toContain("void *vtable;");
    expect(c).toContain("int32_t health; /* +0x08 hit points */");
    expect(c).toContain("char my_name[8];");
    expect(c).toContain("_Static_assert(sizeof(struct Player) == 20");
  });
  it("JS offsets with nested objects for expanded pointers", () => {
    const js = exportJs(root);
    expect(js).toContain("export const Player = {");
    expect(js).toContain("health: 0x08");
    const obj = new Function(js.replace("export const", "return").replace(/ as const;\s*$/, ";"))();
    expect(obj.health).toBe(8);
    expect(obj.pos).toMatchObject({ $off: 4, x: 0, y: 4 });
  });
  it("sanitises and de-duplicates identifiers", () => {
    const b: Block = { name: "9bad name", size: 8, children: new Map(), fields: [
      { off: 0, type: "i32", size: 4, name: "a-b", desc: "", user: true }, { off: 4, type: "i32", size: 4, name: "a b", desc: "", user: true }] };
    const c = exportC(b);
    expect(c).toContain("struct _9bad_name");
    expect(c).toContain("int32_t a_b;");
    expect(c).toMatch(/int32_t a_b_4;/);
  });
});
