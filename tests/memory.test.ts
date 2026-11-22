import { describe, expect, it } from "vitest";
import {
  convertToI64,
  getElementSize,
  getMemoryType,
  indexToRealAddress,
  isValidMemType,
  realAddressToIndex,
} from "../src/shared/memory";

describe("memory utilities (parity with v1.05 shared/utils.js)", () => {
  describe("isValidMemType", () => {
    it("accepts the 9 documented types", () => {
      for (const t of [
        "i8",
        "i16",
        "i32",
        "f32",
        "i64",
        "f64",
        "ascii",
        "utf-8",
        "bytes",
      ]) {
        expect(isValidMemType(t)).toBe(true);
      }
    });
    it("rejects unknown strings", () => {
      expect(isValidMemType("i128")).toBe(false);
      expect(isValidMemType("")).toBe(false);
    });
  });

  describe("getElementSize", () => {
    it("returns byte size for each type", () => {
      expect(getElementSize("i8")).toBe(1);
      expect(getElementSize("i16")).toBe(2);
      expect(getElementSize("i32")).toBe(4);
      expect(getElementSize("i64")).toBe(8);
      expect(getElementSize("f32")).toBe(4);
      expect(getElementSize("f64")).toBe(8);
      expect(getElementSize("ascii")).toBe(1);
      expect(getElementSize("bytes")).toBe(1);
      expect(getElementSize("utf-8")).toBe(2);
    });
    it("throws on unknown type", () => {
      expect(() => getElementSize("invalid" as never)).toThrow();
    });
  });

  describe("getMemoryType", () => {
    it("returns the matching TypedArray constructor", () => {
      expect(getMemoryType("i8")).toBe(Uint8Array);
      expect(getMemoryType("i16")).toBe(Uint16Array);
      expect(getMemoryType("i32")).toBe(Uint32Array);
      expect(getMemoryType("i64")).toBe(BigInt64Array);
      expect(getMemoryType("f32")).toBe(Float32Array);
      expect(getMemoryType("f64")).toBe(Float64Array);
    });
  });

  describe("indexToRealAddress / realAddressToIndex round-trip", () => {
    it("i32 index 0x1000 → address 0x4000", () => {
      expect(indexToRealAddress(0x1000, "i32")).toBe(0x4000);
      expect(realAddressToIndex(0x4000, "i32")).toBe(0x1000);
    });
    it("i64 index 0x100 → address 0x800", () => {
      expect(indexToRealAddress(0x100, "i64")).toBe(0x800);
      expect(realAddressToIndex(0x800, "i64")).toBe(0x100);
    });
  });

  describe("convertToI64 edge cases (task 24 verification)", () => {
    it("i32 MAX (0x7FFFFFFF) lower=value upper=0", () => {
      expect(convertToI64(0x7fffffff, "i32")).toEqual({
        lower: 0x7fffffff,
        upper: 0,
      });
    });

    it("i64 MAX-ish (Number.MAX_SAFE_INTEGER) round-trips through f64 ABI", () => {
      const result = convertToI64(Number.MAX_SAFE_INTEGER, "i64");
      const f64 = new Float64Array(1);
      new Uint32Array(f64.buffer)[0] = result.lower;
      new Uint32Array(f64.buffer)[1] = result.upper;
      expect(f64[0]).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("f64 NaN is preserved through lower/upper word split", () => {
      const result = convertToI64(NaN, "f64");
      const f64 = new Float64Array(1);
      new Uint32Array(f64.buffer)[0] = result.lower;
      new Uint32Array(f64.buffer)[1] = result.upper;
      expect(Number.isNaN(f64[0])).toBe(true);
    });

    it("throws on unsupported type", () => {
      expect(() => convertToI64(0, "ascii" as never)).toThrow();
    });
  });
});
