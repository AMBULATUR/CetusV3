/**
 * Display-formatting helpers. Parity with v1.05 `shared/utils.js` ::
 * `toHex`, `toHexByte`, `formatValue`, `formatInteger`.
 */

export type MemType = "i8" | "i16" | "i32" | "i64" | "f32" | "f64" | "ascii" | "utf-8" | "bytes";

export function toHex(i: number | string): string {
  const n = typeof i === "string" ? parseInt(i, 10) : i;
  return "0x" + n.toString(16).padStart(8, "0");
}

export function toHexByte(i: number | string): string {
  const n = typeof i === "string" ? parseInt(i, 10) : i;
  return n.toString(16).padStart(2, "0");
}

export function formatInteger(value: number): number | string {
  return value > 0x1000 ? toHex(value) : value;
}

export type FormatValueResult = number | string;

export function formatValue(
  value: number | string,
  memType: MemType | "ascii" | "utf-8" | "bytes",
): FormatValueResult {
  switch (memType) {
    case "i8":
    case "i16":
    case "i32":
    case "i64":
      return formatInteger(value as number);
    case "f32":
    case "f64":
      return value as number;
    case "ascii":
      return value as string;
    default:
      throw new Error(`Invalid memory type ${memType} in formatValue()`);
  }
}
