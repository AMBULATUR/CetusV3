import { describe, expect, it } from "vitest";
import {
  formatInteger,
  formatValue,
  toHex,
  toHexByte,
} from "../src/shared/format";

describe("format utilities (parity with v1.05 shared/utils.js)", () => {
  describe("toHex", () => {
    it("formats integers as 0x + 8-digit zero-padded hex", () => {
      expect(toHex(0)).toBe("0x00000000");
      expect(toHex(0x10)).toBe("0x00000010");
      expect(toHex(0xdeadbeef)).toBe("0xdeadbeef");
    });
  });

  describe("toHexByte", () => {
    it("formats integers as 2-digit zero-padded hex (no prefix)", () => {
      expect(toHexByte(0)).toBe("00");
      expect(toHexByte(0xa)).toBe("0a");
      expect(toHexByte(0xff)).toBe("ff");
    });
  });

  describe("formatInteger", () => {
    it("returns value unchanged when <= 0x1000", () => {
      expect(formatInteger(0)).toBe(0);
      expect(formatInteger(0x1000)).toBe(0x1000);
    });
    it("formats as hex when > 0x1000", () => {
      expect(formatInteger(0x1001)).toBe("0x00001001");
      expect(formatInteger(0xdeadbeef)).toBe("0xdeadbeef");
    });
  });

  describe("formatValue", () => {
    it("integers go through formatInteger", () => {
      expect(formatValue(0x100, "i32")).toBe(0x100);
      expect(formatValue(0x2000, "i32")).toBe("0x00002000");
    });
    it("f32 / f64 passthrough", () => {
      expect(formatValue(3.14, "f32")).toBe(3.14);
      expect(formatValue(1e308, "f64")).toBe(1e308);
    });
    it("ascii passthrough", () => {
      expect(formatValue("hello", "ascii")).toBe("hello");
    });
    it("throws on unknown memType", () => {
      expect(() => formatValue(0, "unknown" as never)).toThrow();
    });
  });
});
