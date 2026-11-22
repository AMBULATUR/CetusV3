import { describe, expect, it } from "vitest";
import {
  bigintIsNaN,
  bigintJsonParse,
  bigintJsonStringify,
} from "../src/shared/bigint-json";

describe("bigint-json helpers (parity with v1.05 shared/utils.js)", () => {
  describe("bigintJsonStringify / bigintJsonParse round-trip", () => {
    it("preserves BigInt values inside an object", () => {
      const original = {
        addr: 0x1000,
        value: 9999999999999999999n,
        nested: { other: -42n },
      };
      const json = bigintJsonStringify(original);
      const restored = bigintJsonParse(json);
      expect(restored).toEqual(original);
      expect(typeof (restored as { value: bigint }).value).toBe("bigint");
    });

    it("encodes BigInt as <value>n suffix string", () => {
      const json = bigintJsonStringify({ x: 42n });
      expect(json).toBe('{"x":"42n"}');
    });

    it("decodes <value>n suffix string back to BigInt", () => {
      const restored = bigintJsonParse('{"x":"42n"}');
      expect((restored as { x: bigint }).x).toBe(42n);
    });

    it("does NOT misinterpret a regular numeric string ending in n as BigInt", () => {
      const restored = bigintJsonParse('{"label":"asdfn"}');
      expect((restored as { label: string }).label).toBe("asdfn");
    });
  });

  describe("bigintIsNaN", () => {
    it("returns false for any BigInt", () => {
      expect(bigintIsNaN(0n)).toBe(false);
      expect(bigintIsNaN(-(2n ** 63n))).toBe(false);
    });
    it("delegates to Number.isNaN for non-BigInt", () => {
      expect(bigintIsNaN(NaN)).toBe(true);
      expect(bigintIsNaN(42)).toBe(false);
      expect(bigintIsNaN("nope")).toBe(true);
    });
  });
});
