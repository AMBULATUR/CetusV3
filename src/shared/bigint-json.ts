/**
 * BigInt-aware JSON helpers. Parity with v1.05 `shared/utils.js` ::
 * `bigintJsonParse`, `bigintJsonStringify`, `bigintIsNaN`.
 *
 * Encoding: a `bigint` value `v` is stored as the string `v.toString() + "n"`.
 * Decoding: any JSON string matching `/^-?\d+n$/` is read back as `BigInt`.
 * Source: https://golb.hplar.ch/2018/09/javascript-bigint.html
 */

const BIGINT_RE = /^-?\d+n$/;
const BIGINT_SUFFIX = "n";

export function bigintJsonStringify(jsonObject: unknown): string {
  return JSON.stringify(jsonObject, (_key, value) => {
    if (typeof value === "bigint") {
      return value.toString() + BIGINT_SUFFIX;
    }
    return value;
  });
}

export function bigintJsonParse(jsonString: string): unknown {
  return JSON.parse(jsonString, (_key, value) => {
    if (typeof value === "string" && BIGINT_RE.test(value)) {
      return BigInt(value.slice(0, -1));
    }
    return value;
  });
}

export function bigintIsNaN(value: unknown): boolean {
  if (typeof value === "bigint") {
    return false;
  }
  return Number.isNaN(Number(value));
}
