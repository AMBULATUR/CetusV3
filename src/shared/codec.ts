/** Value types, conversions and transport encoding shared by page, UI and tests. */

export type ValType = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "u64" | "i64" | "f32" | "f64";

export const VAL_TYPES: ValType[] = ["i32", "u32", "f32", "i64", "u64", "f64", "i16", "u16", "i8", "u8"];

export const TYPE_INFO: Record<ValType, { size: number; float: boolean; big: boolean; signed: boolean }> = {
  u8: { size: 1, float: false, big: false, signed: false },
  i8: { size: 1, float: false, big: false, signed: true },
  u16: { size: 2, float: false, big: false, signed: false },
  i16: { size: 2, float: false, big: false, signed: true },
  u32: { size: 4, float: false, big: false, signed: false },
  i32: { size: 4, float: false, big: false, signed: true },
  u64: { size: 8, float: false, big: true, signed: false },
  i64: { size: 8, float: false, big: true, signed: true },
  f32: { size: 4, float: true, big: false, signed: true },
  f64: { size: 8, float: true, big: false, signed: true },
};

export type Val = number | bigint;

export function isValType(t: unknown): t is ValType {
  return typeof t === "string" && t in TYPE_INFO;
}

export function readVal(dv: DataView, addr: number, t: ValType): Val {
  switch (t) {
    case "u8": return dv.getUint8(addr);
    case "i8": return dv.getInt8(addr);
    case "u16": return dv.getUint16(addr, true);
    case "i16": return dv.getInt16(addr, true);
    case "u32": return dv.getUint32(addr, true);
    case "i32": return dv.getInt32(addr, true);
    case "u64": return dv.getBigUint64(addr, true);
    case "i64": return dv.getBigInt64(addr, true);
    case "f32": return dv.getFloat32(addr, true);
    case "f64": return dv.getFloat64(addr, true);
  }
}

export function writeVal(dv: DataView, addr: number, t: ValType, v: Val): void {
  switch (t) {
    case "u8": dv.setUint8(addr, Number(v)); break;
    case "i8": dv.setInt8(addr, Number(v)); break;
    case "u16": dv.setUint16(addr, Number(v), true); break;
    case "i16": dv.setInt16(addr, Number(v), true); break;
    case "u32": dv.setUint32(addr, Number(v) >>> 0, true); break;
    case "i32": dv.setInt32(addr, Number(v) | 0, true); break;
    case "u64": dv.setBigUint64(addr, BigInt(v), true); break;
    case "i64": dv.setBigInt64(addr, BigInt(v), true); break;
    case "f32": dv.setFloat32(addr, Number(v), true); break;
    case "f64": dv.setFloat64(addr, Number(v), true); break;
  }
}

/** Parse user text into a value of the given type. Throws on invalid input. */
export function parseVal(t: ValType, text: string): Val {
  const s = text.trim();
  if (s === "") throw new Error("empty value");
  const info = TYPE_INFO[t];
  if (info.float) {
    const l = s.toLowerCase();
    if (l === "nan") return NaN;
    if (l === "inf" || l === "+inf" || l === "infinity") return Infinity;
    if (l === "-inf" || l === "-infinity") return -Infinity;
    if (/^-?0x[0-9a-f]+$/i.test(s)) {
      // raw bits
      const dv = new DataView(new ArrayBuffer(8));
      if (t === "f32") { dv.setUint32(0, Number(BigInt(s.replace("-", ""))) >>> 0, true); return dv.getFloat32(0, true); }
      dv.setBigUint64(0, BigInt.asUintN(64, BigInt(s.replace("-", ""))), true);
      return dv.getFloat64(0, true);
    }
    const v = Number(s);
    if (Number.isNaN(v)) throw new Error(`"${text}" is not a number`);
    return t === "f32" ? Math.fround(v) : v;
  }
  let big: bigint;
  try {
    big = s.startsWith("-0x") || s.startsWith("-0X") ? -BigInt(s.slice(1)) : BigInt(s);
  } catch {
    if (/^-?\d+\.\d*$/.test(s)) big = BigInt(s.split(".")[0]!);
    else throw new Error(`"${text}" is not an integer`);
  }
  const bits = info.size * 8;
  const min = info.signed ? -(1n << BigInt(bits - 1)) : 0n;
  // accept both signed and unsigned spellings of the same bit pattern
  const max = (1n << BigInt(bits)) - 1n;
  if (big < min && info.signed === false) throw new Error(`${text} out of range for ${t}`);
  if (big < -(1n << BigInt(bits - 1)) || big > max) throw new Error(`${text} out of range for ${t}`);
  big = info.signed ? BigInt.asIntN(bits, big) : BigInt.asUintN(bits, big);
  return info.big ? big : Number(big);
}

/** Encode for JSON transport (chrome messaging cannot carry BigInt/NaN). */
export function enc(v: Val): number | string {
  if (typeof v === "bigint") return v.toString();
  if (!Number.isFinite(v)) return Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
  if (Object.is(v, -0)) return "-0";
  return v;
}

export function dec(t: ValType, x: number | string): Val {
  if (typeof x === "number") return x;
  if (TYPE_INFO[t].big) return BigInt(x);
  if (x === "NaN") return NaN;
  if (x === "Infinity") return Infinity;
  if (x === "-Infinity") return -Infinity;
  if (x === "-0") return -0;
  return Number(x);
}

export function fmtVal(t: ValType, v: Val): string {
  if (typeof v === "bigint") return v.toString();
  if (TYPE_INFO[t].float) {
    if (t === "f32") {
      if (!Number.isFinite(v)) return String(v);
      for (let p = 1; p <= 9; p++) {
        const s = v.toPrecision(p);
        if (Math.fround(Number(s)) === v) return String(Number(s));
      }
    }
    return String(v);
  }
  return String(v);
}

export const toHex = (n: number, pad = 8): string => "0x" + (n >>> 0).toString(16).padStart(pad, "0");

export function bytesToBits(b: Uint8Array, little = true): string {
  const arr = Array.from(b);
  if (little) arr.reverse();
  return arr.map((x) => x.toString(2).padStart(8, "0")).join(" ");
}
