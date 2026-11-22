/** Reading / writing NUL-terminated strings in linear memory (UTF-8 or UTF-16LE). */
export type StrEncoding = "utf8" | "utf16";

export function readCString(buf: ArrayBufferLike, addr: number, enc: StrEncoding, maxChars: number): string {
  const u8 = new Uint8Array(buf);
  if (addr < 0 || addr >= u8.length) throw new RangeError("address out of range");
  if (enc === "utf16") {
    const units: number[] = [];
    for (let i = 0; i < maxChars && addr + i * 2 + 1 < u8.length; i++) {
      const c = u8[addr + i * 2]! | (u8[addr + i * 2 + 1]! << 8);
      if (!c) break;
      units.push(c);
    }
    let s = "";
    for (let k = 0; k < units.length; k += 8192) s += String.fromCharCode.apply(null, units.slice(k, k + 8192));
    return s;
  }
  let e = addr;
  const limit = Math.min(u8.length, addr + Math.max(1, maxChars) * 4);
  let chars = 0;
  while (e < limit && u8[e] !== 0) { if ((u8[e]! & 0xc0) !== 0x80) chars++; if (chars > maxChars) break; e++; }
  return new TextDecoder("utf-8").decode(u8.subarray(addr, e));
}

/** Size in bytes (including the terminator) the text needs. */
export function cstringSize(text: string, enc: StrEncoding): number {
  return enc === "utf16" ? text.length * 2 + 2 : new TextEncoder().encode(text).length + 1;
}

export function writeCString(buf: ArrayBufferLike, addr: number, text: string, enc: StrEncoding, capBytes?: number): number {
  const u8 = new Uint8Array(buf);
  const need = cstringSize(text, enc);
  if (capBytes !== undefined && need > capBytes) throw new RangeError(`text needs ${need} bytes (with terminator) but this row's length is ${capBytes}. Raise the row's length or shorten the text`);
  if (addr < 0 || addr + need > u8.length) throw new RangeError("address out of range");
  if (enc === "utf16") {
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); u8[addr + i * 2] = c & 255; u8[addr + i * 2 + 1] = c >> 8; }
    u8[addr + text.length * 2] = 0; u8[addr + text.length * 2 + 1] = 0;
  } else {
    const b = new TextEncoder().encode(text);
    u8.set(b, addr);
    u8[addr + b.length] = 0;
  }
  return need;
}
