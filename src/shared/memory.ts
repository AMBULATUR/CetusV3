/**
 * WASM memory layout helpers. Parity with v1.05 `shared/utils.js` ::
 * `getElementSize`, `getMemoryType`, `indexToRealAddress`,
 * `realAddressToIndex`, `isValidMemType`, `convertToI64`.
 */

export type CetusMemType =
  | "i8"
  | "i16"
  | "i32"
  | "i64"
  | "f32"
  | "f64"
  | "ascii"
  | "utf-8"
  | "bytes";

const VALID_TYPES: ReadonlySet<string> = new Set([
  "i8",
  "i16",
  "i32",
  "f32",
  "i64",
  "f64",
  "ascii",
  "utf-8",
  "bytes",
]);

export function isValidMemType(memType: string): memType is CetusMemType {
  return VALID_TYPES.has(memType);
}

export function getElementSize(type: CetusMemType): number {
  switch (type) {
    case "i8":
    case "ascii":
    case "bytes":
      return 1;
    case "utf-8":
    case "i16":
      return 2;
    case "i32":
    case "f32":
      return 4;
    case "i64":
    case "f64":
      return 8;
    default: {
      const _exhaust: never = type;
      throw new Error(
        `Invalid memory type ${_exhaust as string} in getElementSize()`,
      );
    }
  }
}

export type TypedArrayCtor =
  | Uint8ArrayConstructor
  | Uint16ArrayConstructor
  | Uint32ArrayConstructor
  | BigInt64ArrayConstructor
  | Float32ArrayConstructor
  | Float64ArrayConstructor;

export function getMemoryType(memType: CetusMemType): TypedArrayCtor {
  switch (memType) {
    case "i8":
    case "ascii":
    case "bytes":
      return Uint8Array;
    case "i16":
    case "utf-8":
      return Uint16Array;
    case "i32":
      return Uint32Array;
    case "i64":
      return BigInt64Array;
    case "f32":
      return Float32Array;
    case "f64":
      return Float64Array;
    default: {
      const _exhaust: never = memType;
      throw new Error(
        `Invalid memory type ${_exhaust as string} in getMemoryType()`,
      );
    }
  }
}

export function indexToRealAddress(
  memIndex: number,
  memType: CetusMemType,
): number {
  return memIndex * getElementSize(memType);
}

export function realAddressToIndex(
  memAddr: number,
  memType: CetusMemType,
): number {
  return Math.floor(memAddr / getElementSize(memType));
}

export interface I64Pair {
  lower: number;
  upper: number;
}

/**
 * Splits a value into two 32-bit words suitable for crossing the WASM ABI.
 * Behaviour mirrors v1.05 `convertToI64`:
 * - i8/i16/i32 → `lower = value`, `upper = 0`
 * - f32 → reinterpret IEEE-754 bits, low word only
 * - i64/f64 → reinterpret as f64 bytes, split into two u32 words
 *
 * Note: passing a JS `number` for `"i64"` truncates at f64 precision. Callers
 * that need full 64-bit integer fidelity must use `BigInt` and the
 * `bigint-json` helpers instead.
 */
export function convertToI64(value: number, type: CetusMemType): I64Pair {
  const result: I64Pair = { lower: 0, upper: 0 };

  switch (type) {
    case "i8":
    case "i16":
    case "i32":
      result.lower = value;
      break;
    case "f32": {
      const floatArray = new Float32Array([value]);
      const i32Array = new Uint32Array(floatArray.buffer);
      result.lower = i32Array[0] ?? 0;
      break;
    }
    case "i64":
    case "f64": {
      const float64Array = new Float64Array([value]);
      const i32Array = new Uint32Array(float64Array.buffer);
      result.lower = i32Array[0] ?? 0;
      result.upper = i32Array[1] ?? 0;
      break;
    }
    default:
      throw new Error(`Conversion ${type} not implemented in convertToI64()`);
  }

  return result;
}
