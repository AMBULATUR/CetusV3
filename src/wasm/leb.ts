/**
 * Low-level binary helpers for the WebAssembly binary format.
 * No dependencies; usable from the page (main world), the UI and tests.
 */

export class Reader {
  pos: number;
  readonly end: number;
  constructor(readonly buf: Uint8Array, pos = 0, end = buf.length) {
    this.pos = pos;
    this.end = end;
  }
  get eof(): boolean {
    return this.pos >= this.end;
  }
  u8(): number {
    if (this.pos >= this.end) throw new RangeError("unexpected end of wasm data");
    return this.buf[this.pos++]!;
  }
  peek(): number {
    if (this.pos >= this.end) throw new RangeError("unexpected end of wasm data");
    return this.buf[this.pos]!;
  }
  /** Unsigned LEB128, up to 32 bits (returns a non-negative JS number). */
  u32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new RangeError("LEB128 u32 too long");
    }
    return result;
  }
  /** Signed LEB128 up to 33 bits (block types / s33). Returns a JS number. */
  s33(): number {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.u8();
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80 && shift < 42);
    if (b & 0x40) result -= 2 ** shift;
    return result;
  }
  /** Signed LEB128 up to 32 bits. */
  s32(): number {
    return this.s33() | 0;
  }
  /** Signed LEB128 up to 64 bits, as BigInt. */
  s64(): bigint {
    let result = 0n;
    let shift = 0n;
    let b: number;
    do {
      b = this.u8();
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while (b & 0x80 && shift < 70n);
    if (b & 0x40) result -= 1n << shift;
    return BigInt.asIntN(64, result);
  }
  u64(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.u8();
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
      if (shift > 70n) throw new RangeError("LEB128 u64 too long");
    }
    return result;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.end) throw new RangeError("unexpected end of wasm data");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  skip(n: number): void {
    if (this.pos + n > this.end) throw new RangeError("unexpected end of wasm data");
    this.pos += n;
  }
  name(): string {
    const len = this.u32();
    return utf8Decode(this.bytes(len));
  }
}

const dec = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
const enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

export function utf8Decode(b: Uint8Array): string {
  return dec ? dec.decode(b) : String.fromCharCode(...b);
}
export function utf8Encode(s: string): Uint8Array {
  return enc ? enc.encode(s) : Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Growable byte sink. */
export class Writer {
  private buf: Uint8Array;
  length = 0;
  constructor(cap = 256) {
    this.buf = new Uint8Array(cap);
  }
  private ensure(extra: number): void {
    const need = this.length + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.length));
    this.buf = nb;
  }
  u8(b: number): this {
    this.ensure(1);
    this.buf[this.length++] = b & 0xff;
    return this;
  }
  u32(v: number): this {
    v = v >>> 0;
    do {
      let b = v & 0x7f;
      v = Math.floor(v / 128);
      if (v !== 0) b |= 0x80;
      this.u8(b);
    } while (v !== 0);
    return this;
  }
  s32(v: number): this {
    v = v | 0;
    for (;;) {
      const b = v & 0x7f;
      v >>= 7;
      if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
        this.u8(b);
        return this;
      }
      this.u8(b | 0x80);
    }
  }
  s64(v: bigint): this {
    v = BigInt.asIntN(64, v);
    for (;;) {
      const b = Number(v & 0x7fn);
      v >>= 7n;
      if ((v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0)) {
        this.u8(b);
        return this;
      }
      this.u8(b | 0x80);
    }
  }
  u64(v: bigint): this {
    v = BigInt.asUintN(64, v);
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v !== 0n) b |= 0x80;
      this.u8(b);
    } while (v !== 0n);
    return this;
  }
  bytes(b: ArrayLike<number>): this {
    this.ensure(b.length);
    for (let i = 0; i < b.length; i++) this.buf[this.length + i] = b[i]! & 0xff;
    this.length += b.length;
    return this;
  }
  raw(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }
  name(s: string): this {
    const b = utf8Encode(s);
    this.u32(b.length);
    return this.raw(b);
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
  view(): Uint8Array {
    return this.buf.subarray(0, this.length);
  }
}

export function u32leb(v: number): number[] {
  const w = new Writer(8);
  w.u32(v);
  return Array.from(w.view());
}
export function s32leb(v: number): number[] {
  const w = new Writer(8);
  w.s32(v);
  return Array.from(w.view());
}
export function s64leb(v: bigint): number[] {
  const w = new Writer(12);
  w.s64(v);
  return Array.from(w.view());
}

export const hex = (b: ArrayLike<number>, sep = ""): string => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += (i && sep ? sep : "") + b[i]!.toString(16).padStart(2, "0");
  return s;
};
export function fromHex(s: string): Uint8Array {
  s = s.replace(/[^0-9a-fA-F]/g, "");
  if (s.length % 2) throw new Error("odd-length hex string");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode(...b.subarray(i, i + CH));
  return btoa(s);
}
export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
