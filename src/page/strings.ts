import { MatchSpec, compileMatcher } from "../shared/matcher";

export type StrEnc = "ascii" | "utf16" | "utf8";

export interface StringScanParams {
  encodings: StrEnc[];
  minLen: number;
  maxLen?: number;
  lower: number;
  upper: number;
  /** utf16: accept any printable code unit, not only ASCII range */
  wide?: boolean;
  maxStrings?: number;
}

export interface StringQuery {
  filter?: MatchSpec | null;
  encs?: StrEnc[];
  lenMin?: number;
  lenMax?: number;
  sort?: "addr" | "len" | "alpha";
  desc?: boolean;
  offset: number;
  limit: number;
}

export interface StringRow {
  addr: number;
  len: number;
  bytes: number;
  enc: StrEnc;
  text: string;
  cut: boolean;
}

const MAX_TEXT = 4096;
const ENC_ID: Record<StrEnc, number> = { ascii: 0, utf16: 1, utf8: 2 };
const ENC_NAME: StrEnc[] = ["ascii", "utf16", "utf8"];

export class StringStore {
  addrs = new Uint32Array(0);
  lens = new Uint32Array(0); // characters
  bytes = new Uint32Array(0);
  encs = new Uint8Array(0);
  texts: string[] = [];
  count = 0;
  truncated = false;
  version = 0;
  private cacheKey = "";
  private cache: Uint32Array | null = null;

  private add(addr: number, chars: number, nbytes: number, enc: number, text: string): void {
    if (this.count >= this.addrs.length) {
      const cap = Math.max(1024, this.addrs.length * 2);
      const g = <T extends Uint32Array | Uint8Array>(a: T, C: new (n: number) => T): T => { const n = new C(cap); n.set(a); return n; };
      this.addrs = g(this.addrs, Uint32Array);
      this.lens = g(this.lens, Uint32Array);
      this.bytes = g(this.bytes, Uint32Array);
      this.encs = g(this.encs, Uint8Array);
    }
    this.addrs[this.count] = addr;
    this.lens[this.count] = chars;
    this.bytes[this.count] = nbytes;
    this.encs[this.count] = enc;
    this.texts.push(text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text);
    this.count++;
  }

  clear(): void {
    this.addrs = new Uint32Array(0);
    this.lens = new Uint32Array(0);
    this.bytes = new Uint32Array(0);
    this.encs = new Uint8Array(0);
    this.texts = [];
    this.count = 0;
    this.truncated = false;
    this.cache = null;
    this.version++;
  }

  scan(buf: ArrayBufferLike, p: StringScanParams): void {
    this.clear();
    const mem = new Uint8Array(buf);
    const lo = Math.max(0, p.lower | 0);
    const hi = Math.min(mem.length, p.upper || mem.length);
    const minLen = Math.max(1, p.minLen | 0);
    const maxLen = p.maxLen && p.maxLen > 0 ? p.maxLen : Infinity;
    const cap = p.maxStrings ?? 3_000_000;
    const utf8 = p.encodings.includes("utf8");
    const dec = new TextDecoder("utf-8");

    if (utf8 || p.encodings.includes("ascii")) {
      let i = lo;
      while (i < hi) {
        let s = i;
        let chars = 0;
        let multi = false;
        while (i < hi) {
          const b = mem[i]!;
          if ((b >= 0x20 && b < 0x7f) || b === 9) { i++; chars++; continue; }
          if (utf8 && b >= 0xc2) {
            const n = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
            if (b < 0xf5 && i + n <= hi) {
              let ok = true;
              for (let k = 1; k < n; k++) if ((mem[i + k]! & 0xc0) !== 0x80) { ok = false; break; }
              if (ok) { i += n; chars++; multi = true; continue; }
            }
          }
          break;
        }
        if (chars >= minLen && chars <= maxLen) {
          if (this.count >= cap) { this.truncated = true; break; }
          const slice = mem.subarray(s, Math.min(i, s + MAX_TEXT * 4));
          const text = multi ? dec.decode(slice) : String.fromCharCode.apply(null, slice as unknown as number[]);
          this.add(s, chars, i - s, multi ? 2 : 0, text);
        }
        i++;
        if (i <= s) i = s + 1;
        void s;
      }
    }

    if (p.encodings.includes("utf16") && !this.truncated) {
      let i = lo + (lo & 1);
      while (i + 1 < hi) {
        const s = i;
        let chars = 0;
        const units: number[] = [];
        while (i + 1 < hi) {
          const lo8 = mem[i]!;
          const hi8 = mem[i + 1]!;
          const u = lo8 | (hi8 << 8);
          const ok = p.wide ? u >= 0x20 && u !== 0x7f && (u < 0xd800 || u > 0xdfff) && u < 0xfffe && !(u >= 0x80 && u < 0xa0) : hi8 === 0 && ((lo8 >= 0x20 && lo8 < 0x7f) || lo8 === 9);
          if (!ok) break;
          if (units.length < MAX_TEXT) units.push(u);
          chars++;
          i += 2;
        }
        if (chars >= minLen && chars <= maxLen) {
          if (this.count >= cap) { this.truncated = true; break; }
          // avoid reporting ascii-looking runs that are just a utf16 string's interleaved bytes only once
          let text = "";
          for (let k = 0; k < units.length; k += 8192) text += String.fromCharCode.apply(null, units.slice(k, k + 8192));
          this.add(s, chars, chars * 2, 1, text);
        }
        i += 2;
      }
    }
    this.version++;
    this.cache = null;
  }

  private filtered(q: StringQuery): Uint32Array {
    const key = JSON.stringify([this.version, q.filter, q.encs, q.lenMin, q.lenMax, q.sort, q.desc]);
    if (this.cache && key === this.cacheKey) return this.cache;
    const test = compileMatcher(q.filter ?? null);
    const encOk = q.encs && q.encs.length ? new Set(q.encs.map((e) => ENC_ID[e])) : null;
    const out = new Uint32Array(this.count);
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (encOk && !encOk.has(this.encs[i]!)) continue;
      const l = this.lens[i]!;
      if (q.lenMin && l < q.lenMin) continue;
      if (q.lenMax && l > q.lenMax) continue;
      if (!test(this.texts[i]!)) continue;
      out[n++] = i;
    }
    let idx = out.slice(0, n);
    if (q.sort === "len") idx.sort((a, b) => this.lens[a]! - this.lens[b]! || a - b);
    else if (q.sort === "alpha") {
      const arr = Array.from(idx);
      arr.sort((a, b) => (this.texts[a]! < this.texts[b]! ? -1 : this.texts[a]! > this.texts[b]! ? 1 : a - b));
      idx = Uint32Array.from(arr);
    }
    if (q.desc) idx.reverse();
    this.cache = idx;
    this.cacheKey = key;
    return idx;
  }

  query(q: StringQuery): { total: number; matched: number; rows: StringRow[]; truncated: boolean } {
    const idx = this.filtered(q);
    const rows: StringRow[] = [];
    const end = Math.min(idx.length, q.offset + q.limit);
    for (let k = Math.max(0, q.offset); k < end; k++) {
      const i = idx[k]!;
      const text = this.texts[i]!;
      rows.push({
        addr: this.addrs[i]!, len: this.lens[i]!, bytes: this.bytes[i]!,
        enc: ENC_NAME[this.encs[i]!]!, text: text.length > 600 ? text.slice(0, 600) : text, cut: text.length > 600 || this.lens[i]! > text.length,
      });
    }
    return { total: this.count, matched: idx.length, rows, truncated: this.truncated };
  }
}
