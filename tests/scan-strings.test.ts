import { describe, it, expect } from "vitest";
import { ScanSession, findPattern, parsePattern } from "../src/page/scan";
import { StringStore } from "../src/page/strings";
import { compileMatcher } from "../src/shared/matcher";
import { parseVal, fmtVal } from "../src/shared/codec";

function mem(size = 4096) { return new ArrayBuffer(size); }

describe("scan engine", () => {
  it("first/next scans for ints, floats, 64-bit and snapshots", () => {
    const b = mem();
    const dv = new DataView(b);
    dv.setInt32(100, 100, true); dv.setInt32(200, 100, true); dv.setInt32(300, 5, true);
    dv.setFloat32(400, 12.5, true); dv.setBigInt64(512, -5n, true);
    const s = new ScanSession();
    s.first(b, { type: "i32", cmp: "eq", value: "100", align: true, lower: 0, upper: 0 });
    expect(s.count).toBe(2);
    dv.setInt32(100, 90, true);
    s.next(b, { type: "i32", cmp: "decreased", align: true, lower: 0, upper: 0 });
    expect(Array.from(s.addrs.subarray(0, s.count))).toEqual([100]);
    expect(s.page(b, 0, 10)[0]).toEqual({ addr: 100, value: 90, prev: 90 });
    const f = new ScanSession();
    f.first(b, { type: "f32", cmp: "eq", value: "12.5", align: true, lower: 0, upper: 0 });
    expect(Array.from(f.addrs.subarray(0, f.count))).toEqual([400]);
    const l = new ScanSession();
    l.first(b, { type: "i64", cmp: "eq", value: "-5", align: true, lower: 0, upper: 0 });
    expect(Array.from(l.addrs.subarray(0, l.count))).toEqual([512]);
    // unknown initial value + changed
    const u = new ScanSession();
    u.first(b, { type: "i32", cmp: "unknown", align: true, lower: 0, upper: 0 });
    dv.setInt32(1000, 7, true);
    u.next(b, { type: "i32", cmp: "changed", align: true, lower: 0, upper: 0 });
    expect(Array.from(u.addrs.subarray(0, u.count))).toEqual([1000]);
    u.next(b, { type: "i32", cmp: "unchanged", align: true, lower: 0, upper: 0 });
    expect(u.count).toBe(1);
  });
  it("handles many results (paging) without capping at 1000", () => {
    const b = mem(1 << 20);
    const s = new ScanSession();
    s.first(b, { type: "u32", cmp: "eq", value: "0", align: true, lower: 0, upper: 0 });
    expect(s.count).toBe((1 << 20) / 4);
    expect(s.page(b, 100000, 5).length).toBe(5);
  });
  it("pattern search with wildcards", () => {
    const b = mem();
    new Uint8Array(b).set([1, 2, 3, 4, 5], 50);
    new Uint8Array(b).set([1, 9, 3], 70);
    const r = findPattern(b, parsePattern("bytes", "01 ?? 03"), 0, 0, 100);
    expect(r.addrs).toEqual([50, 70]);
    expect(findPattern(b, parsePattern("bytes", "01 ?? 03 04"), 0, 0, 100).addrs).toEqual([50]);
  });
});

describe("strings", () => {
  it("finds ascii/utf16/utf8 strings and filters with all modes, paging", () => {
    const b = mem(8192);
    const u8 = new Uint8Array(b);
    const put = (a: number, s: string) => [...s].forEach((c, i) => (u8[a + i] = c.charCodeAt(0)));
    put(100, "hello world"); put(200, "world peace"); put(300, "foo.bar");
    [..."wide text"].forEach((c, i) => { u8[400 + i * 2] = c.charCodeAt(0); });
    u8.set(new TextEncoder().encode("Привет мир"), 600);
    const st = new StringStore();
    st.scan(b, { encodings: ["utf8", "utf16"], minLen: 4, lower: 0, upper: 0 });
    const q = (text: string, mode: any, extra: any = {}) => st.query({ filter: { text, mode }, offset: 0, limit: 50, ...extra }).rows.map((r) => r.text);
    expect(q("world", "contains")).toEqual(["hello world", "world peace"]);
    expect(q("world", "prefix")).toEqual(["world peace"]);
    expect(q("world", "suffix")).toEqual(["hello world"]);
    expect(q("foo.bar", "exact")).toEqual(["foo.bar"]);
    expect(q("^h.*d$", "regex")).toEqual(["hello world"]);
    expect(q("*o?ld*", "wildcard")).toEqual(["hello world", "world peace"]);
    expect(q("WORLD", "contains", {})).toHaveLength(2);
    expect(q("wide", "contains")).toEqual(["wide text"]);
    expect(q("мир", "contains")).toEqual(["Привет мир"]);
    const page = st.query({ offset: 1, limit: 2, sort: "alpha" });
    expect(page.rows).toHaveLength(2);
    expect(page.matched).toBe(st.count);
  });
  it("scales to thousands of strings", () => {
    const b = mem(1 << 20);
    const u8 = new Uint8Array(b);
    for (let i = 0; i < 20000; i++) { const s = "str" + i + "\0"; for (let k = 0; k < s.length; k++) u8[i * 16 + k] = s.charCodeAt(k); }
    const st = new StringStore();
    st.scan(b, { encodings: ["ascii"], minLen: 4, lower: 0, upper: 0 });
    expect(st.count).toBe(20000);
    const r = st.query({ filter: { mode: "suffix", text: "99" }, offset: 0, limit: 100 });
    expect(r.matched).toBe(200);
  });
});

describe("codec/matcher", () => {
  it("parses and formats values", () => {
    expect(parseVal("i8", "-1")).toBe(-1);
    expect(parseVal("u8", "255")).toBe(255);
    expect(() => parseVal("u8", "256")).toThrow();
    expect(parseVal("u64", "0xffffffffffffffff")).toBe(18446744073709551615n);
    expect(fmtVal("f32", Math.fround(0.1))).toBe("0.1");
    expect(compileMatcher({ mode: "regex", text: "a+", invert: true })("bbb")).toBe(true);
  });
});
