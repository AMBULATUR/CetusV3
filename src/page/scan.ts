import { TYPE_INFO, ValType, Val, readVal, parseVal } from "../shared/codec";

export type Cmp =
  | "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "between" | "unknown"
  | "changed" | "unchanged" | "increased" | "decreased" | "increasedBy" | "decreasedBy";

export interface ScanParams {
  type: ValType;
  cmp: Cmp;
  value?: string;
  value2?: string;
  align: boolean;
  lower: number;
  upper: number;
  /** float equality: match values that round to the typed precision (default true) */
  rounded?: boolean;
}

export const MAX_RESULTS = 8_000_000;

function decimals(s: string): number {
  const m = /\.(\d+)/.exec(s.trim());
  return m ? m[1]!.length : 0;
}

function makeTest(p: ScanParams, first: boolean): (cur: Val, prev: Val | undefined) => boolean {
  const info = TYPE_INFO[p.type];
  const need = p.cmp !== "unknown" && !["changed", "unchanged", "increased", "decreased"].includes(p.cmp);
  const v1 = need ? parseVal(p.type, p.value ?? "") : (0 as Val);
  const v2 = p.cmp === "between" ? parseVal(p.type, p.value2 ?? "") : v1;
  const tol = info.float && p.rounded !== false ? 0.5 * Math.pow(10, -decimals(p.value ?? "")) : 0;
  const near = (a: number, b: number) => (tol ? Math.abs(a - b) < tol || a === b : a === b);
  const isNaNv = (x: Val) => typeof x === "number" && Number.isNaN(x);
  switch (p.cmp) {
    case "unknown": return () => true;
    case "eq": return info.float ? (c) => near(c as number, v1 as number) : (c) => c === v1;
    case "ne": return info.float ? (c) => !near(c as number, v1 as number) : (c) => c !== v1;
    case "lt": return (c) => c < v1;
    case "lte": return (c) => c <= v1;
    case "gt": return (c) => c > v1;
    case "gte": return (c) => c >= v1;
    case "between": {
      const lo = v1 <= v2 ? v1 : v2;
      const hi = v1 <= v2 ? v2 : v1;
      return (c) => c >= lo && c <= hi;
    }
  }
  if (first) throw new Error(`"${p.cmp}" needs a previous scan`);
  switch (p.cmp) {
    case "changed": return (c, pr) => !(c === pr || (isNaNv(c) && isNaNv(pr!)));
    case "unchanged": return (c, pr) => c === pr || (isNaNv(c) && isNaNv(pr!));
    case "increased": return (c, pr) => c > pr!;
    case "decreased": return (c, pr) => c < pr!;
    case "increasedBy": return info.float ? (c, pr) => near((c as number) - (pr as number), v1 as number) : (c, pr) => (c as bigint) - (pr as bigint) === v1 || (typeof c === "number" && c - (pr as number) === v1);
    case "decreasedBy": return info.float ? (c, pr) => near((pr as number) - (c as number), v1 as number) : (c, pr) => (pr as bigint) - (c as bigint) === v1 || (typeof c === "number" && (pr as number) - c === v1);
  }
  throw new Error("unknown comparison " + p.cmp);
}

export class ScanSession {
  type: ValType = "i32";
  size = 4;
  align = true;
  addrs = new Uint32Array(0);
  prevNum = new Float64Array(0);
  prevBig = new BigInt64Array(0);
  count = 0;
  truncated = false;
  /** true after a "unknown initial value" first scan */
  snapshot: { lo: number; hi: number; data: Uint8Array } | null = null;
  started = false;

  private big() { return TYPE_INFO[this.type].big; }

  reset(): void {
    this.addrs = new Uint32Array(0);
    this.prevNum = new Float64Array(0);
    this.prevBig = new BigInt64Array(0);
    this.count = 0;
    this.snapshot = null;
    this.truncated = false;
    this.started = false;
  }

  private bounds(p: ScanParams, memLen: number): [number, number] {
    const size = TYPE_INFO[p.type].size;
    let lo = Math.max(0, Math.floor(p.lower || 0));
    let hi = Math.min(memLen, Math.floor(p.upper ?? memLen) || memLen);
    if (p.align) lo = Math.ceil(lo / size) * size;
    return [lo, hi];
  }

  private grow(n: number): void {
    if (n <= this.addrs.length) return;
    let cap = Math.max(1024, this.addrs.length * 2);
    while (cap < n) cap *= 2;
    const a = new Uint32Array(cap);
    a.set(this.addrs.subarray(0, this.count));
    this.addrs = a;
    if (this.big()) {
      const b = new BigInt64Array(cap);
      b.set(this.prevBig.subarray(0, this.count));
      this.prevBig = b;
    } else {
      const b = new Float64Array(cap);
      b.set(this.prevNum.subarray(0, this.count));
      this.prevNum = b;
    }
  }

  private push(addr: number, v: Val): void {
    if (this.count >= this.addrs.length) this.grow(this.count + 1);
    this.addrs[this.count] = addr;
    if (this.big()) this.prevBig[this.count] = BigInt.asIntN(64, v as bigint);
    else this.prevNum[this.count] = v as number;
    this.count++;
  }

  prevAt(i: number): Val {
    if (this.big()) {
      const b = this.prevBig[i]!;
      return this.type === "u64" ? BigInt.asUintN(64, b) : b;
    }
    return this.prevNum[i]!;
  }

  first(buf: ArrayBufferLike, p: ScanParams): void {
    this.reset();
    this.type = p.type;
    this.size = TYPE_INFO[p.type].size;
    this.align = p.align;
    this.started = true;
    const [lo, hi] = this.bounds(p, buf.byteLength);
    if (p.cmp === "unknown") {
      if (hi - lo > 1024 * 1024 * 1024) throw new Error("range too large for an unknown-value snapshot (max 1 GiB)");
      this.snapshot = { lo, hi, data: new Uint8Array(buf, lo, hi - lo).slice() };
      this.count = Math.floor((hi - lo) / (p.align ? this.size : 1));
      return;
    }
    const test = makeTest(p, true);
    const dv = new DataView(buf);
    const size = this.size;
    const step = p.align ? size : 1;
    for (let a = lo; a + size <= hi; a += step) {
      const v = readVal(dv, a, p.type);
      if (test(v, undefined)) {
        if (this.count >= MAX_RESULTS) { this.truncated = true; break; }
        this.push(a, v);
      }
    }
  }

  next(buf: ArrayBufferLike, p: ScanParams): void {
    if (!this.started) throw new Error("run a first scan before refining");
    const type = this.type;
    const dv = new DataView(buf);
    const test = makeTest({ ...p, type }, false);
    if (this.snapshot) {
      const snap = this.snapshot;
      const sdv = new DataView(snap.data.buffer, snap.data.byteOffset, snap.data.byteLength);
      const size = this.size;
      const step = this.align ? size : 1;
      this.snapshot = null;
      this.count = 0;
      this.truncated = false;
      for (let a = snap.lo; a + size <= snap.hi; a += step) {
        const prev = readVal(sdv, a - snap.lo, type);
        const cur = readVal(dv, a, type);
        if (test(cur, prev)) {
          if (this.count >= MAX_RESULTS) { this.truncated = true; break; }
          this.push(a, cur);
        }
      }
      return;
    }
    let w = 0;
    const big = this.big();
    const lo = Math.max(0, p.lower || 0);
    const hi = p.upper ? p.upper : buf.byteLength;
    for (let i = 0; i < this.count; i++) {
      const a = this.addrs[i]!;
      if (a + this.size > buf.byteLength || a < lo || a >= hi) continue;
      const cur = readVal(dv, a, type);
      const prev = this.prevAt(i);
      if (test(cur, prev)) {
        this.addrs[w] = a;
        if (big) this.prevBig[w] = BigInt.asIntN(64, cur as bigint);
        else this.prevNum[w] = cur as number;
        w++;
      }
    }
    this.count = w;
  }

  /** Hide/keep results only in [lo,hi) etc. are handled by next(); this returns a page of live rows. */
  page(buf: ArrayBufferLike, offset: number, limit: number): { addr: number; value: Val; prev: Val | null }[] {
    if (this.snapshot) return [];
    const dv = new DataView(buf);
    const out: { addr: number; value: Val; prev: Val | null }[] = [];
    for (let i = offset; i < Math.min(this.count, offset + limit); i++) {
      const a = this.addrs[i]!;
      out.push({ addr: a, value: a + this.size <= buf.byteLength ? readVal(dv, a, this.type) : 0, prev: this.prevAt(i) });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Byte pattern search (ascii / utf-16 / hex with ?? wildcards)
// ---------------------------------------------------------------------------
export function parsePattern(kind: "ascii" | "utf16" | "bytes", text: string): { bytes: number[]; mask: boolean[] } {
  if (kind === "bytes") {
    const toks = text.trim().split(/[\s,]+/).filter(Boolean).map((t) => t.replace(/^0x/i, "").replace(/^\\x/i, ""));
    const flat: string[] = [];
    for (const t of toks) {
      if (/^(\?\?|\*)$/.test(t)) flat.push("??");
      else if (/^[0-9a-f]+$/i.test(t) && t.length % 2 === 0) for (let i = 0; i < t.length; i += 2) flat.push(t.substr(i, 2));
      else throw new Error(`bad byte pattern token "${t}"`);
    }
    if (!flat.length) throw new Error("empty byte pattern");
    return { bytes: flat.map((t) => (t === "??" ? 0 : parseInt(t, 16))), mask: flat.map((t) => t !== "??") };
  }
  if (!text.length) throw new Error("empty pattern");
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (kind === "ascii") bytes.push(c & 0xff);
    else bytes.push(c & 0xff, c >> 8);
  }
  return { bytes, mask: bytes.map(() => true) };
}

export function findPattern(buf: ArrayBufferLike, pat: { bytes: number[]; mask: boolean[] }, lo: number, hi: number, max: number): { addrs: number[]; truncated: boolean } {
  const mem = new Uint8Array(buf);
  hi = Math.min(hi || mem.length, mem.length);
  const addrs: number[] = [];
  const n = pat.bytes.length;
  const anchor = pat.mask.indexOf(true);
  let truncated = false;
  if (anchor < 0) throw new Error("pattern is all wildcards");
  let i = lo + anchor;
  const last = hi - n + anchor;
  while (i <= last) {
    const j = mem.indexOf(pat.bytes[anchor]!, i);
    if (j < 0 || j > last) break;
    const s = j - anchor;
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (pat.mask[k] && mem[s + k] !== pat.bytes[k]) { ok = false; break; }
    }
    if (ok) {
      if (addrs.length >= max) { truncated = true; break; }
      addrs.push(s);
    }
    i = j + 1;
  }
  return { addrs, truncated };
}
