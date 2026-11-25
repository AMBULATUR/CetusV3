/**
 * Cheat-Engine style structure dissector: pure logic (no DOM, no RPC) so it can be unit-tested.
 *
 *  - guessField / layoutBlock : infer field types in a block of memory
 *  - buildPath                : turn "root + nested pointer expansions + field" into a cheat-table address / pointer path
 *  - exportC / exportJs       : turn a dissected layout into source code
 */
import type { Chain } from "./addrexpr";

export type FieldType = "i8" | "u8" | "i16" | "u16" | "i32" | "u32" | "i64" | "u64" | "f32" | "f64" | "ptr" | "string";
export const FIELD_TYPES: FieldType[] = ["i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "f32", "f64", "ptr", "string"];
export const FIELD_SIZE: Record<Exclude<FieldType, "string">, number> = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, i64: 8, u64: 8, f32: 4, f64: 8, ptr: 4 };

export interface Field {
  off: number;
  type: FieldType;
  /** bytes covered (strings: capacity incl. padding) */
  size: number;
  name: string;
  desc: string;
  /** true once the user renamed / retyped / described it: kept when types are re-guessed */
  user: boolean;
  /** `[vtable]` badge: ptr whose target's first word points into static data */
  vtable?: boolean;
}

export interface Env {
  /** linear memory size in bytes */
  memSize: number;
  /** static .rodata/.data span (vtables live here) or null when unknown */
  vt: { lo: number; hi: number } | null;
  /** u32 stored at `addr` (used to look at [ptr]); null when unreadable */
  readU32?: (addr: number) => number | null;
}

/** `0x1000 <= val < memSize && (val & 3) === 0` */
export const isHeapPtr = (val: number, memSize: number): boolean => val >= 0x1000 && val < memSize && (val & 3) === 0;

/** valid float in 1e-5..1e6 (either sign); never NaN/Inf; the raw word must not itself be a small integer */
export function isPlausibleF32(bits: number, dv?: DataView): boolean {
  const u = bits >>> 0;
  if (u !== 0 && u < 0x10000) return false; // clean small integer (also a denormal): not a float
  const f = dv ? dv.getFloat32(0, true) : f32FromBits(u);
  if (!Number.isFinite(f)) return false;
  const a = Math.abs(f);
  return a >= 1e-5 && a <= 1e6;
}
const _f = new DataView(new ArrayBuffer(4));
function f32FromBits(u: number): number { _f.setUint32(0, u >>> 0, true); return _f.getFloat32(0, true); }

const printable = (c: number): boolean => c >= 0x20 && c < 0x7f;

/** length of the run of printable ASCII starting at `off` (stops at NUL, a non-printable byte or the end) */
export function printableRun(bytes: Uint8Array, off: number, max = 256): number {
  let n = 0;
  while (off + n < bytes.length && n < max && printable(bytes[off + n]!)) n++;
  return n;
}

export interface Guess { type: FieldType; size: number; vtable?: boolean }

/**
 * Guess the type of the field at `off` (4-byte aligned callers get ptr/f32/string/i32; others get u8).
 * Order: string (4+ printable bytes) > ptr > f32 > i32, with hex preview left to the UI.
 */
export function guessField(bytes: Uint8Array, off: number, env: Env): Guess {
  if (off + 4 > bytes.length || (off & 3) !== 0) return { type: "u8", size: 1 };
  const dv = new DataView(bytes.buffer, bytes.byteOffset + off, 4);
  const u = dv.getUint32(0, true);
  // a run of 4+ printable characters is far more likely text than a pointer or a number
  const run = printableRun(bytes, off);
  if (run >= 4) {
    // whole word printable (or the run is NUL-terminated inside it): text. Size = run + terminator, rounded up to words.
    const term = off + run < bytes.length && bytes[off + run] === 0 ? 1 : 0;
    return { type: "string", size: Math.max(4, ((run + term + 3) >> 2) << 2) };
  }
  const f32ok = isPlausibleF32(u, dv);
  if (isHeapPtr(u, env.memSize)) {
    const first = env.readU32?.(u) ?? null;
    const vtable = !!env.vt && first !== null && first >= env.vt.lo && first < env.vt.hi;
    // 0x37..–0x49.. words are both valid floats and valid addresses in big heaps: call it a pointer only with a vtable
    if (!f32ok || vtable) return { type: "ptr", size: 4, vtable };
  }
  if (f32ok) return { type: "f32", size: 4 };
  return { type: "i32", size: 4 };
}

const fieldName = (off: number): string => "field_" + off.toString(16).padStart(2, "0");
export const defaultName = fieldName;

/**
 * Lay out [0, size): `fixed` fields (user-edited) are kept as they are, every gap is filled with guessed fields.
 * The result is sorted, non-overlapping and covers the block completely.
 */
export function layoutBlock(bytes: Uint8Array, size: number, env: Env, fixed: Field[] = []): Field[] {
  const keep = fixed.filter((f) => f.off >= 0 && f.off + f.size <= size).sort((a, b) => a.off - b.off);
  const out: Field[] = [];
  let at = 0;
  const fill = (to: number) => {
    while (at < to) {
      let g = guessField(bytes, at, env);
      if (at + g.size > to) g = { type: to - at >= 2 && (at & 1) === 0 ? "u16" : "u8", size: to - at >= 2 && (at & 1) === 0 ? 2 : 1 };
      const f: Field = { off: at, type: g.type, size: g.size, name: fieldName(at), desc: "", user: false };
      if (g.vtable) f.vtable = true;
      out.push(f);
      at += g.size;
    }
  };
  for (const f of keep) {
    if (f.off < at) continue; // overlapped by an earlier fixed field
    fill(f.off);
    out.push({ ...f });
    at = f.off + f.size;
  }
  fill(size);
  return out;
}

/** Re-type one field and re-flow its neighbours; the edited field becomes user-owned. */
export function retype(fields: Field[], off: number, type: FieldType, bytes: Uint8Array, size: number, env: Env, strLen = 16): Field[] {
  const cur = fields.find((f) => f.off === off);
  if (!cur) return fields;
  const sz = type === "string" ? Math.max(4, (strLen + 3) & ~3) : FIELD_SIZE[type];
  const user = fields.filter((f) => f.user && f.off !== off);
  const edited: Field = { ...cur, type, size: sz, user: true };
  delete edited.vtable;
  // fixed fields that the new size would swallow are dropped
  const kept = user.filter((f) => f.off + f.size <= off || f.off >= off + sz);
  return layoutBlock(bytes, size, env, [...kept, edited]);
}

// ---------------------------------------------------------------------------------------------
// nested path generation
// ---------------------------------------------------------------------------------------------
export type Root = { kind: "addr"; addr: number } | { kind: "ptr"; chain: Chain };
export type PathResult = { kind: "addr"; addr: number } | { kind: "ptr"; chain: Chain };

/**
 * `steps` = [o1, o2, … ok]: o1..o(k-1) are the offsets of the pointer fields that were expanded, ok is the
 * offset of the field itself. For a root that is a plain address A:
 *     [o1]            -> A+o1
 *     [o1, o2]        -> [A+o1]+o2                     (chain base A+o1, offsets [o2])
 * For a root that is itself a pointer path (the struct lives at its resolved address S):
 *     the first step folds into the last offset of the root chain, so  [$g12+0x34]+0x18  +  [o1, o2]
 *     -> [$g12+0x34]+(0x18+o1) then +o2 after one more read.
 */
export function buildPath(root: Root, steps: number[]): PathResult {
  if (!steps.length) throw new Error("no field selected");
  if (root.kind === "addr") {
    if (steps.length === 1) return { kind: "addr", addr: (root.addr + steps[0]!) >>> 0 };
    return { kind: "ptr", chain: { base: (root.addr + steps[0]!) >>> 0, offsets: steps.slice(1) } };
  }
  const c = root.chain;
  const offs = [...c.offsets.slice(0, -1), c.offsets[c.offsets.length - 1]! + steps[0]!, ...steps.slice(1)];
  return { kind: "ptr", chain: { base: c.base, offsets: offs, ...(c.global !== undefined ? { global: c.global } : {}) } };
}

/** Follow `steps` through memory (pointer fields are 4-byte little-endian); the address of the last field. */
export function followSteps(readU32: (addr: number) => number | null, start: number, steps: number[]): number | null {
  let cur = start;
  for (let i = 0; i < steps.length - 1; i++) {
    const p = readU32((cur + steps[i]!) >>> 0);
    if (p === null) return null;
    cur = p;
  }
  return (cur + steps[steps.length - 1]!) >>> 0;
}

// ---------------------------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------------------------
export interface Block {
  name: string;
  size: number;
  fields: Field[];
  /** expanded pointer fields: offset -> pointed-to block */
  children: Map<number, Block>;
}

export function ident(s: string, fallback: string): string {
  let t = s.trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!t) t = fallback;
  if (/^[0-9]/.test(t)) t = "_" + t;
  return t;
}
const h = (n: number, w = 2) => "0x" + n.toString(16).padStart(w, "0");

const C_TYPES: Record<Exclude<FieldType, "string" | "ptr">, string> = {
  i8: "int8_t", u8: "uint8_t", i16: "int16_t", u16: "uint16_t", i32: "int32_t", u32: "uint32_t", i64: "int64_t", u64: "uint64_t", f32: "float", f64: "double",
};

/** unique identifier per field within one struct */
function fieldIdents(b: Block): string[] {
  const used = new Set<string>();
  return b.fields.map((f) => {
    let n = ident(f.name, "field_" + f.off.toString(16));
    while (used.has(n)) n += "_" + f.off.toString(16);
    used.add(n);
    return n;
  });
}

/** C structs: children first (so `struct Child *` pointers are complete), padding made explicit, size asserted. */
export function exportC(root: Block): string {
  const defs: string[] = [];
  const names = new Set<string>();
  const structName = (b: Block): string => {
    let n = ident(b.name, "Struct");
    while (names.has(n)) n += "_";
    names.add(n);
    return n;
  };
  const emit = (b: Block): string => {
    const sn = structName(b);
    const ids = fieldIdents(b);
    const childName = new Map<number, string>();
    for (const [off, cb] of b.children) childName.set(off, emit(cb));
    const lines: string[] = [];
    let at = 0;
    b.fields.forEach((f, i) => {
      if (f.off > at) lines.push(`  uint8_t _pad_${at.toString(16)}[${f.off - at}];`);
      const cmt = `/* +${h(f.off)}${f.vtable ? " vtable" : ""}${f.desc ? " " + f.desc.replace(/\*\//g, "* /") : ""} */`;
      if (f.type === "ptr") lines.push(`  ${childName.has(f.off) ? `struct ${childName.get(f.off)} *` : "void *"}${ids[i]}; ${cmt}`);
      else if (f.type === "string") lines.push(`  char ${ids[i]}[${f.size}]; ${cmt}`);
      else lines.push(`  ${C_TYPES[f.type]} ${ids[i]}; ${cmt}`);
      at = f.off + f.size;
    });
    if (at < b.size) lines.push(`  uint8_t _pad_${at.toString(16)}[${b.size - at}];`);
    defs.push(`struct ${sn} {\n${lines.join("\n")}\n};\n_Static_assert(sizeof(struct ${sn}) == ${b.size}, "layout of ${sn} drifted");\n`);
    return sn;
  };
  emit(root);
  return `#include <stdint.h>\n/* wasm32: pointers are 4 bytes */\n\n${defs.join("\n")}`;
}

/** JS/TS object of byte offsets. Expanded pointers become nested objects with a `$off` entry for the pointer field. */
export function exportJs(root: Block): string {
  const emit = (b: Block, ind: string): string => {
    const ids = fieldIdents(b);
    const lines: string[] = [];
    b.fields.forEach((f, i) => {
      const child = b.children.get(f.off);
      const note = f.desc ? ` // ${f.type}${f.desc ? ": " + f.desc.replace(/[\r\n]+/g, " ") : ""}` : ` // ${f.type}${f.vtable ? " [vtable]" : ""}`;
      if (child) {
        lines.push(`${ind}  ${ids[i]}: {${note}\n${ind}    $off: ${h(f.off)},\n${emit(child, ind + "    ").split("\n").slice(1, -1).join("\n")}\n${ind}  },`);
      } else lines.push(`${ind}  ${ids[i]}: ${h(f.off)},${note}`);
    });
    return `{\n${lines.join("\n")}\n${ind}}`;
  };
  return `export const ${ident(root.name, "Struct")} = ${emit(root, "")} as const;\n`;
}
