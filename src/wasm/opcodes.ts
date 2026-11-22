/**
 * Opcode table for the WebAssembly binary format, covering MVP plus the
 * proposals that shipped in browsers: sign-extension, saturating truncation,
 * bulk memory, reference types, multi-value, SIMD, threads/atomics, tail
 * calls, exception handling (legacy + try_table), function references and GC.
 *
 * One table drives the decoder, the instrumenter, the disassembler and the
 * assembler, so they can never disagree about instruction shapes.
 */

export type Imm =
  | "" // no immediates
  | "bt" // block type (s33)
  | "label" // u32 label depth
  | "brtable" // vec(u32) + u32
  | "func" // u32 function index
  | "callind" // type idx, table idx
  | "local"
  | "global"
  | "table"
  | "tag"
  | "type"
  | "mem" // memory index (memory.size/grow/fill)
  | "memarg" // align, [memidx], offset
  | "i32"
  | "i64"
  | "f32"
  | "f64"
  | "selt" // vec(valtype)
  | "heap" // heap type (s33)
  | "trytable" // blocktype + vec(catch)
  | "v128" // 16 raw bytes
  | "shuffle" // 16 lane bytes
  | "lane" // 1 byte lane index
  | "memarglane" // memarg + lane byte
  | "fence" // 1 reserved byte
  | "dataMem" // memory.init: data idx, mem idx
  | "data"
  | "elem"
  | "elemTable"
  | "memmem" // memory.copy: dst mem, src mem
  | "tabletable"
  | "typefield"
  | "typeN"
  | "typeData"
  | "typeElem"
  | "typeType"
  | "brcast";

export interface Access {
  /** bytes touched in linear memory */
  size: number;
  load: boolean;
  store: boolean;
}

export interface OpInfo {
  prefix: number; // 0 for single byte opcodes, else 0xFB/0xFC/0xFD/0xFE
  code: number;
  name: string;
  imm: Imm;
  access?: Access;
  /** true for memory.fill / memory.copy / memory.init (bulk writes) */
  bulkWrite?: boolean;
}

export const key = (prefix: number, code: number): number => prefix * 0x10000 + code;

export const OPS: OpInfo[] = [];
export const BY_KEY = new Map<number, OpInfo>();
export const BY_NAME = new Map<string, OpInfo>();

function accessFromName(name: string): Access | undefined {
  const isLoad = /\.load|\.atomic\.load/.test(name) && !/\.atomic\.rmw/.test(name);
  const isStore = /\.store/.test(name);
  const isRmw = /\.atomic\.rmw/.test(name);
  if (!isLoad && !isStore && !isRmw) return undefined;
  let size = 0;
  const m8 = /(?:load|store|rmw)(8|16|32|64)(?:_|\.|$)/.exec(name);
  const mw = /(8x8|16x4|32x2)/.exec(name);
  if (mw) size = 8;
  else if (name.startsWith("v128.")) {
    if (m8) size = Number(m8[1]) / 8;
    else size = 16;
    if (/_zero|_splat/.test(name) && m8) size = Number(m8[1]) / 8;
  } else if (m8) size = Number(m8[1]) / 8;
  else if (name.startsWith("i32.") || name.startsWith("f32.")) size = 4;
  else size = 8;
  return { size, load: isLoad || isRmw, store: isStore || isRmw };
}

function def(prefix: number, code: number, name: string, imm: Imm = ""): void {
  const info: OpInfo = { prefix, code, name, imm };
  if (imm === "memarg" || imm === "memarglane") {
    const a = accessFromName(name);
    if (a) info.access = a;
  }
  if (prefix === 0xfc && (code === 8 || code === 10 || code === 11)) info.bulkWrite = true;
  OPS.push(info);
  BY_KEY.set(key(prefix, code), info);
  BY_NAME.set(name, info);
}

// ---------------------------------------------------------------------------
// Single-byte opcodes
// ---------------------------------------------------------------------------
def(0, 0x00, "unreachable");
def(0, 0x01, "nop");
def(0, 0x02, "block", "bt");
def(0, 0x03, "loop", "bt");
def(0, 0x04, "if", "bt");
def(0, 0x05, "else");
def(0, 0x06, "try", "bt");
def(0, 0x07, "catch", "tag");
def(0, 0x08, "throw", "tag");
def(0, 0x09, "rethrow", "label");
def(0, 0x0a, "throw_ref");
def(0, 0x0b, "end");
def(0, 0x0c, "br", "label");
def(0, 0x0d, "br_if", "label");
def(0, 0x0e, "br_table", "brtable");
def(0, 0x0f, "return");
def(0, 0x10, "call", "func");
def(0, 0x11, "call_indirect", "callind");
def(0, 0x12, "return_call", "func");
def(0, 0x13, "return_call_indirect", "callind");
def(0, 0x14, "call_ref", "type");
def(0, 0x15, "return_call_ref", "type");
def(0, 0x18, "delegate", "label");
def(0, 0x19, "catch_all");
def(0, 0x1a, "drop");
def(0, 0x1b, "select");
def(0, 0x1c, "select_t", "selt");
def(0, 0x1f, "try_table", "trytable");
def(0, 0x20, "local.get", "local");
def(0, 0x21, "local.set", "local");
def(0, 0x22, "local.tee", "local");
def(0, 0x23, "global.get", "global");
def(0, 0x24, "global.set", "global");
def(0, 0x25, "table.get", "table");
def(0, 0x26, "table.set", "table");

const memOps: [number, string][] = [
  [0x28, "i32.load"], [0x29, "i64.load"], [0x2a, "f32.load"], [0x2b, "f64.load"],
  [0x2c, "i32.load8_s"], [0x2d, "i32.load8_u"], [0x2e, "i32.load16_s"], [0x2f, "i32.load16_u"],
  [0x30, "i64.load8_s"], [0x31, "i64.load8_u"], [0x32, "i64.load16_s"], [0x33, "i64.load16_u"],
  [0x34, "i64.load32_s"], [0x35, "i64.load32_u"],
  [0x36, "i32.store"], [0x37, "i64.store"], [0x38, "f32.store"], [0x39, "f64.store"],
  [0x3a, "i32.store8"], [0x3b, "i32.store16"], [0x3c, "i64.store8"], [0x3d, "i64.store16"], [0x3e, "i64.store32"],
];
for (const [c, n] of memOps) def(0, c, n, "memarg");
def(0, 0x3f, "memory.size", "mem");
def(0, 0x40, "memory.grow", "mem");
def(0, 0x41, "i32.const", "i32");
def(0, 0x42, "i64.const", "i64");
def(0, 0x43, "f32.const", "f32");
def(0, 0x44, "f64.const", "f64");

const numeric =
  "i32.eqz i32.eq i32.ne i32.lt_s i32.lt_u i32.gt_s i32.gt_u i32.le_s i32.le_u i32.ge_s i32.ge_u " +
  "i64.eqz i64.eq i64.ne i64.lt_s i64.lt_u i64.gt_s i64.gt_u i64.le_s i64.le_u i64.ge_s i64.ge_u " +
  "f32.eq f32.ne f32.lt f32.gt f32.le f32.ge f64.eq f64.ne f64.lt f64.gt f64.le f64.ge " +
  "i32.clz i32.ctz i32.popcnt i32.add i32.sub i32.mul i32.div_s i32.div_u i32.rem_s i32.rem_u i32.and i32.or i32.xor i32.shl i32.shr_s i32.shr_u i32.rotl i32.rotr " +
  "i64.clz i64.ctz i64.popcnt i64.add i64.sub i64.mul i64.div_s i64.div_u i64.rem_s i64.rem_u i64.and i64.or i64.xor i64.shl i64.shr_s i64.shr_u i64.rotl i64.rotr " +
  "f32.abs f32.neg f32.ceil f32.floor f32.trunc f32.nearest f32.sqrt f32.add f32.sub f32.mul f32.div f32.min f32.max f32.copysign " +
  "f64.abs f64.neg f64.ceil f64.floor f64.trunc f64.nearest f64.sqrt f64.add f64.sub f64.mul f64.div f64.min f64.max f64.copysign " +
  "i32.wrap_i64 i32.trunc_f32_s i32.trunc_f32_u i32.trunc_f64_s i32.trunc_f64_u i64.extend_i32_s i64.extend_i32_u " +
  "i64.trunc_f32_s i64.trunc_f32_u i64.trunc_f64_s i64.trunc_f64_u f32.convert_i32_s f32.convert_i32_u f32.convert_i64_s f32.convert_i64_u " +
  "f32.demote_f64 f64.convert_i32_s f64.convert_i32_u f64.convert_i64_s f64.convert_i64_u f64.promote_f32 " +
  "i32.reinterpret_f32 i64.reinterpret_f64 f32.reinterpret_i32 f64.reinterpret_i64 " +
  "i32.extend8_s i32.extend16_s i64.extend8_s i64.extend16_s i64.extend32_s";
numeric.split(" ").forEach((n, i) => def(0, 0x45 + i, n));

def(0, 0xd0, "ref.null", "heap");
def(0, 0xd1, "ref.is_null");
def(0, 0xd2, "ref.func", "func");
def(0, 0xd3, "ref.eq");
def(0, 0xd4, "ref.as_non_null");
def(0, 0xd5, "br_on_null", "label");
def(0, 0xd6, "br_on_non_null", "label");

// ---------------------------------------------------------------------------
// 0xFC prefix: saturating truncation, bulk memory, table ops
// ---------------------------------------------------------------------------
[
  "i32.trunc_sat_f32_s", "i32.trunc_sat_f32_u", "i32.trunc_sat_f64_s", "i32.trunc_sat_f64_u",
  "i64.trunc_sat_f32_s", "i64.trunc_sat_f32_u", "i64.trunc_sat_f64_s", "i64.trunc_sat_f64_u",
].forEach((n, i) => def(0xfc, i, n));
def(0xfc, 8, "memory.init", "dataMem");
def(0xfc, 9, "data.drop", "data");
def(0xfc, 10, "memory.copy", "memmem");
def(0xfc, 11, "memory.fill", "mem");
def(0xfc, 12, "table.init", "elemTable");
def(0xfc, 13, "elem.drop", "elem");
def(0xfc, 14, "table.copy", "tabletable");
def(0xfc, 15, "table.grow", "table");
def(0xfc, 16, "table.size", "table");
def(0xfc, 17, "table.fill", "table");

// ---------------------------------------------------------------------------
// 0xFD prefix: SIMD
// ---------------------------------------------------------------------------
const simdNames: Record<number, string> = {};
const simdImm: Record<number, Imm> = {};
function simd(code: number, name: string, imm: Imm = ""): void {
  simdNames[code] = name;
  if (imm) simdImm[code] = imm;
}
simd(0x00, "v128.load", "memarg");
simd(0x01, "v128.load8x8_s", "memarg");
simd(0x02, "v128.load8x8_u", "memarg");
simd(0x03, "v128.load16x4_s", "memarg");
simd(0x04, "v128.load16x4_u", "memarg");
simd(0x05, "v128.load32x2_s", "memarg");
simd(0x06, "v128.load32x2_u", "memarg");
simd(0x07, "v128.load8_splat", "memarg");
simd(0x08, "v128.load16_splat", "memarg");
simd(0x09, "v128.load32_splat", "memarg");
simd(0x0a, "v128.load64_splat", "memarg");
simd(0x0b, "v128.store", "memarg");
simd(0x0c, "v128.const", "v128");
simd(0x0d, "i8x16.shuffle", "shuffle");
simd(0x0e, "i8x16.swizzle");
simd(0x0f, "i8x16.splat");
simd(0x10, "i16x8.splat");
simd(0x11, "i32x4.splat");
simd(0x12, "i64x2.splat");
simd(0x13, "f32x4.splat");
simd(0x14, "f64x2.splat");
const lanes: [number, string][] = [
  [0x15, "i8x16.extract_lane_s"], [0x16, "i8x16.extract_lane_u"], [0x17, "i8x16.replace_lane"],
  [0x18, "i16x8.extract_lane_s"], [0x19, "i16x8.extract_lane_u"], [0x1a, "i16x8.replace_lane"],
  [0x1b, "i32x4.extract_lane"], [0x1c, "i32x4.replace_lane"], [0x1d, "i64x2.extract_lane"], [0x1e, "i64x2.replace_lane"],
  [0x1f, "f32x4.extract_lane"], [0x20, "f32x4.replace_lane"], [0x21, "f64x2.extract_lane"], [0x22, "f64x2.replace_lane"],
];
for (const [c, n] of lanes) simd(c, n, "lane");
const cmpInt = ["eq", "ne", "lt_s", "lt_u", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u"];
cmpInt.forEach((s, i) => simd(0x23 + i, "i8x16." + s));
cmpInt.forEach((s, i) => simd(0x2d + i, "i16x8." + s));
cmpInt.forEach((s, i) => simd(0x37 + i, "i32x4." + s));
["eq", "ne", "lt", "gt", "le", "ge"].forEach((s, i) => simd(0x41 + i, "f32x4." + s));
["eq", "ne", "lt", "gt", "le", "ge"].forEach((s, i) => simd(0x47 + i, "f64x2." + s));
simd(0x4d, "v128.not");
simd(0x4e, "v128.and");
simd(0x4f, "v128.andnot");
simd(0x50, "v128.or");
simd(0x51, "v128.xor");
simd(0x52, "v128.bitselect");
simd(0x53, "v128.any_true");
simd(0x54, "v128.load8_lane", "memarglane");
simd(0x55, "v128.load16_lane", "memarglane");
simd(0x56, "v128.load32_lane", "memarglane");
simd(0x57, "v128.load64_lane", "memarglane");
simd(0x58, "v128.store8_lane", "memarglane");
simd(0x59, "v128.store16_lane", "memarglane");
simd(0x5a, "v128.store32_lane", "memarglane");
simd(0x5b, "v128.store64_lane", "memarglane");
simd(0x5c, "v128.load32_zero", "memarg");
simd(0x5d, "v128.load64_zero", "memarg");
simd(0x5e, "f32x4.demote_f64x2_zero");
simd(0x5f, "f64x2.promote_low_f32x4");
const rest =
  "60 i8x16.abs|61 i8x16.neg|62 i8x16.popcnt|63 i8x16.all_true|64 i8x16.bitmask|65 i8x16.narrow_i16x8_s|66 i8x16.narrow_i16x8_u|" +
  "67 f32x4.ceil|68 f32x4.floor|69 f32x4.trunc|6a f32x4.nearest|6b i8x16.shl|6c i8x16.shr_s|6d i8x16.shr_u|6e i8x16.add|" +
  "6f i8x16.add_sat_s|70 i8x16.add_sat_u|71 i8x16.sub|72 i8x16.sub_sat_s|73 i8x16.sub_sat_u|74 f64x2.ceil|75 f64x2.floor|" +
  "76 i8x16.min_s|77 i8x16.min_u|78 i8x16.max_s|79 i8x16.max_u|7a f64x2.trunc|7b i8x16.avgr_u|" +
  "7c i16x8.extadd_pairwise_i8x16_s|7d i16x8.extadd_pairwise_i8x16_u|7e i32x4.extadd_pairwise_i16x8_s|7f i32x4.extadd_pairwise_i16x8_u|" +
  "80 i16x8.abs|81 i16x8.neg|82 i16x8.q15mulr_sat_s|83 i16x8.all_true|84 i16x8.bitmask|85 i16x8.narrow_i32x4_s|86 i16x8.narrow_i32x4_u|" +
  "87 i16x8.extend_low_i8x16_s|88 i16x8.extend_high_i8x16_s|89 i16x8.extend_low_i8x16_u|8a i16x8.extend_high_i8x16_u|" +
  "8b i16x8.shl|8c i16x8.shr_s|8d i16x8.shr_u|8e i16x8.add|8f i16x8.add_sat_s|90 i16x8.add_sat_u|91 i16x8.sub|92 i16x8.sub_sat_s|93 i16x8.sub_sat_u|" +
  "94 f64x2.nearest|95 i16x8.mul|96 i16x8.min_s|97 i16x8.min_u|98 i16x8.max_s|99 i16x8.max_u|9b i16x8.avgr_u|" +
  "9c i16x8.extmul_low_i8x16_s|9d i16x8.extmul_high_i8x16_s|9e i16x8.extmul_low_i8x16_u|9f i16x8.extmul_high_i8x16_u|" +
  "a0 i32x4.abs|a1 i32x4.neg|a3 i32x4.all_true|a4 i32x4.bitmask|" +
  "a7 i32x4.extend_low_i16x8_s|a8 i32x4.extend_high_i16x8_s|a9 i32x4.extend_low_i16x8_u|aa i32x4.extend_high_i16x8_u|" +
  "ab i32x4.shl|ac i32x4.shr_s|ad i32x4.shr_u|ae i32x4.add|b1 i32x4.sub|b5 i32x4.mul|b6 i32x4.min_s|b7 i32x4.min_u|b8 i32x4.max_s|b9 i32x4.max_u|" +
  "ba i32x4.dot_i16x8_s|bc i32x4.extmul_low_i16x8_s|bd i32x4.extmul_high_i16x8_s|be i32x4.extmul_low_i16x8_u|bf i32x4.extmul_high_i16x8_u|" +
  "c0 i64x2.abs|c1 i64x2.neg|c3 i64x2.all_true|c4 i64x2.bitmask|" +
  "c7 i64x2.extend_low_i32x4_s|c8 i64x2.extend_high_i32x4_s|c9 i64x2.extend_low_i32x4_u|ca i64x2.extend_high_i32x4_u|" +
  "cb i64x2.shl|cc i64x2.shr_s|cd i64x2.shr_u|ce i64x2.add|d1 i64x2.sub|d5 i64x2.mul|" +
  "d6 i64x2.eq|d7 i64x2.ne|d8 i64x2.lt_s|d9 i64x2.gt_s|da i64x2.le_s|db i64x2.ge_s|" +
  "dc i64x2.extmul_low_i32x4_s|dd i64x2.extmul_high_i32x4_s|de i64x2.extmul_low_i32x4_u|df i64x2.extmul_high_i32x4_u|" +
  "e0 f32x4.abs|e1 f32x4.neg|e3 f32x4.sqrt|e4 f32x4.add|e5 f32x4.sub|e6 f32x4.mul|e7 f32x4.div|e8 f32x4.min|e9 f32x4.max|ea f32x4.pmin|eb f32x4.pmax|" +
  "ec f64x2.abs|ed f64x2.neg|ef f64x2.sqrt|f0 f64x2.add|f1 f64x2.sub|f2 f64x2.mul|f3 f64x2.div|f4 f64x2.min|f5 f64x2.max|f6 f64x2.pmin|f7 f64x2.pmax|" +
  "f8 i32x4.trunc_sat_f32x4_s|f9 i32x4.trunc_sat_f32x4_u|fa f32x4.convert_i32x4_s|fb f32x4.convert_i32x4_u|" +
  "fc i32x4.trunc_sat_f64x2_s_zero|fd i32x4.trunc_sat_f64x2_u_zero|fe f64x2.convert_low_i32x4_s|ff f64x2.convert_low_i32x4_u";
for (const item of rest.split("|")) {
  const [h, n] = item.split(" ") as [string, string];
  simd(parseInt(h, 16), n);
}
// relaxed-simd (0x100..0x113) share the prefix; only names, no immediates
[
  "i8x16.relaxed_swizzle", "i32x4.relaxed_trunc_f32x4_s", "i32x4.relaxed_trunc_f32x4_u",
  "i32x4.relaxed_trunc_f64x2_s_zero", "i32x4.relaxed_trunc_f64x2_u_zero", "f32x4.relaxed_madd", "f32x4.relaxed_nmadd",
  "f64x2.relaxed_madd", "f64x2.relaxed_nmadd", "i8x16.relaxed_laneselect", "i16x8.relaxed_laneselect",
  "i32x4.relaxed_laneselect", "i64x2.relaxed_laneselect", "f32x4.relaxed_min", "f32x4.relaxed_max",
  "f64x2.relaxed_min", "f64x2.relaxed_max", "i16x8.relaxed_q15mulr_s", "i16x8.relaxed_dot_i8x16_i7x16_s",
  "i32x4.relaxed_dot_i8x16_i7x16_add_s",
].forEach((n, i) => simd(0x100 + i, n));
for (const [c, n] of Object.entries(simdNames)) def(0xfd, Number(c), n, simdImm[Number(c)] ?? "");

// ---------------------------------------------------------------------------
// 0xFE prefix: threads / atomics
// ---------------------------------------------------------------------------
def(0xfe, 0x00, "memory.atomic.notify", "memarg");
def(0xfe, 0x01, "memory.atomic.wait32", "memarg");
def(0xfe, 0x02, "memory.atomic.wait64", "memarg");
def(0xfe, 0x03, "atomic.fence", "fence");
[
  "i32.atomic.load", "i64.atomic.load", "i32.atomic.load8_u", "i32.atomic.load16_u", "i64.atomic.load8_u",
  "i64.atomic.load16_u", "i64.atomic.load32_u", "i32.atomic.store", "i64.atomic.store", "i32.atomic.store8",
  "i32.atomic.store16", "i64.atomic.store8", "i64.atomic.store16", "i64.atomic.store32",
].forEach((n, i) => def(0xfe, 0x10 + i, n, "memarg"));
["add", "sub", "and", "or", "xor", "xchg", "cmpxchg"].forEach((op, g) => {
  const base = 0x1e + g * 7;
  const suffix = op === "cmpxchg" ? "cmpxchg" : op;
  [
    `i32.atomic.rmw.${suffix}`, `i64.atomic.rmw.${suffix}`, `i32.atomic.rmw8.${suffix}_u`,
    `i32.atomic.rmw16.${suffix}_u`, `i64.atomic.rmw8.${suffix}_u`, `i64.atomic.rmw16.${suffix}_u`,
    `i64.atomic.rmw32.${suffix}_u`,
  ].forEach((n, i) => def(0xfe, base + i, n, "memarg"));
});

// ---------------------------------------------------------------------------
// 0xFB prefix: GC
// ---------------------------------------------------------------------------
const gc: [number, string, Imm][] = [
  [0, "struct.new", "type"], [1, "struct.new_default", "type"], [2, "struct.get", "typefield"],
  [3, "struct.get_s", "typefield"], [4, "struct.get_u", "typefield"], [5, "struct.set", "typefield"],
  [6, "array.new", "type"], [7, "array.new_default", "type"], [8, "array.new_fixed", "typeN"],
  [9, "array.new_data", "typeData"], [10, "array.new_elem", "typeElem"], [11, "array.get", "type"],
  [12, "array.get_s", "type"], [13, "array.get_u", "type"], [14, "array.set", "type"], [15, "array.len", ""],
  [16, "array.fill", "type"], [17, "array.copy", "typeType"], [18, "array.init_data", "typeData"],
  [19, "array.init_elem", "typeElem"], [20, "ref.test", "heap"], [21, "ref.test_null", "heap"],
  [22, "ref.cast", "heap"], [23, "ref.cast_null", "heap"], [24, "br_on_cast", "brcast"],
  [25, "br_on_cast_fail", "brcast"], [26, "any.convert_extern", ""], [27, "extern.convert_any", ""],
  [28, "ref.i31", ""], [29, "i31.get_s", ""], [30, "i31.get_u", ""],
];
for (const [c, n, i] of gc) def(0xfb, c, n, i);

// Legacy / alias names accepted by the assembler
export const ALIASES: Record<string, string> = {
  get_local: "local.get",
  set_local: "local.set",
  tee_local: "local.tee",
  get_global: "global.get",
  set_global: "global.set",
  current_memory: "memory.size",
  grow_memory: "memory.grow",
  "i32.wrap/i64": "i32.wrap_i64",
  select: "select",
};

export const PREFIXES = new Set([0xfb, 0xfc, 0xfd, 0xfe]);

export function opName(prefix: number, code: number): string {
  const info = BY_KEY.get(key(prefix, code));
  if (info) return info.name;
  return prefix ? `0x${prefix.toString(16)}.0x${code.toString(16)}` : `0x${code.toString(16)}`;
}

export const OP = {
  block: 0x02, loop: 0x03, if: 0x04, else: 0x05, try: 0x06, catch: 0x07, throw: 0x08, end: 0x0b,
  br: 0x0c, brIf: 0x0d, call: 0x10, callIndirect: 0x11, returnCall: 0x12,
  localGet: 0x20, localSet: 0x21, localTee: 0x22, globalGet: 0x23, globalSet: 0x24,
  i32Const: 0x41, i64Const: 0x42, f32Const: 0x43, f64Const: 0x44, refFunc: 0xd2, delegate: 0x18, tryTable: 0x1f,
} as const;
