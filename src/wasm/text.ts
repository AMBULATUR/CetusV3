import { Reader, Writer, hex, utf8Encode } from "./leb";
import { BY_NAME, ALIASES, OpInfo, PREFIXES, OPS } from "./opcodes";
import { Ins, decode, newIns, parseBodyHeader } from "./decode";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const VALTYPE_BYTE: Record<string, number> = {
  i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b, funcref: 0x70, externref: 0x6f,
  anyref: 0x6e, eqref: 0x6d, i31ref: 0x6c, exnref: 0x69, nullfuncref: 0x73, nullexternref: 0x72, nullref: 0x71,
};
const VALTYPE_NAME: Record<number, string> = {};
for (const [k, v] of Object.entries(VALTYPE_BYTE)) VALTYPE_NAME[v] = k;

const HEAP_NAMES: Record<string, number> = {
  func: -16, extern: -17, any: -18, eq: -19, i31: -20, struct: -21, array: -22, exn: -23,
  nofunc: -13, noextern: -14, none: -15,
};
const HEAP_BY_NUM: Record<number, string> = {};
for (const [k, v] of Object.entries(HEAP_NAMES)) HEAP_BY_NUM[v] = k;

function naturalAlign(op: OpInfo): number {
  const s = op.access?.size ?? 1;
  return Math.log2(s) | 0;
}

function f32ToString(bits: number): string {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, bits >>> 0, true);
  const v = dv.getFloat32(0, true);
  if (Number.isNaN(v)) return (bits >>> 0) === 0x7fc00000 ? "nan" : "nan:0x" + (bits >>> 0).toString(16);
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  if (Object.is(v, -0)) return "-0";
  for (let p = 1; p <= 9; p++) {
    const s = v.toPrecision(p);
    if (Math.fround(Number(s)) === v) return String(Number(s));
  }
  return String(v);
}
function f64ToString(lo: number, hi: number): string {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setUint32(0, lo >>> 0, true);
  dv.setUint32(4, hi >>> 0, true);
  const v = dv.getFloat64(0, true);
  if (Number.isNaN(v)) {
    const big = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
    return big === 0x7ff8000000000000n ? "nan" : "nan:0x" + big.toString(16);
  }
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  if (Object.is(v, -0)) return "-0";
  return String(v);
}

function btText(bt: number): string {
  if (bt === -64) return "";
  if (bt >= 0) return ` (type ${bt})`;
  const b = bt & 0x7f;
  return ` (result ${VALTYPE_NAME[b] ?? "0x" + b.toString(16)})`;
}

// ---------------------------------------------------------------------------
// Disassembler
// ---------------------------------------------------------------------------
export interface DisLine {
  /** offset relative to the start of the function body (locals vector included) */
  off: number;
  len: number;
  indent: number;
  /** instruction text without indentation/comments */
  text: string;
  /** trailing comment, if any */
  comment: string;
  /** call/ref.func target (function index) */
  target?: number;
  /** constant operand if i32.const (for pointer / string lookup) */
  i32?: number;
  name: string;
  /** raw bytes of the instruction */
  bytes: Uint8Array;
}

export interface DisResult {
  locals: string[];
  lines: DisLine[];
  /** assembler-compatible text (with .locals header) */
  text: string;
  error?: string;
}

export interface DisOptions {
  funcName?: (idx: number) => string | undefined;
  /** annotate branch targets */
  branchComments?: boolean;
}

export function disassembleBody(buf: Uint8Array, start: number, end: number, opts: DisOptions = {}): DisResult {
  const lines: DisLine[] = [];
  let locals: string[] = [];
  let error: string | undefined;
  let codeStart = start;
  try {
    const h = parseBodyHeader(buf, start, end);
    codeStart = h.codeStart;
    locals = [];
    for (let i = 0; i < h.localEntries.length; i++) {
      const lr = new Reader(h.localEntries[i]!);
      lr.u32();
      const b = lr.u8();
      const nm = VALTYPE_NAME[b] ?? "0x" + b.toString(16);
      for (let k = 0; k < h.localCounts[i]!; k++) locals.push(nm);
    }
  } catch (e) {
    error = "bad locals header: " + (e as Error).message;
  }

  type Blk = { kind: string; idx: number };
  const stack: Blk[] = [];
  const ends: number[] = []; // line index of matching end for each block line
  const pairs = new Map<number, number>(); // block line idx -> end line idx
  const blockLine: number[] = [];

  if (!error) {
    const r = new Reader(buf, codeStart, end);
    const ins = newIns();
    let depth = 0;
    try {
      while (!r.eof) {
        decode(r, ins);
        const name = ins.op.name;
        if (name === "end" || name === "delegate") depth = Math.max(0, depth - 1);
        const indentNow = name === "else" || name === "catch" || name === "catch_all" ? Math.max(0, depth - 1) : depth;
        const line = formatIns(buf, ins, opts);
        line.off = ins.pos - start;
        line.indent = indentNow;
        lines.push(line);
        const li = lines.length - 1;
        switch (name) {
          case "block": case "loop": case "if": case "try": case "try_table":
            stack.push({ kind: name, idx: li });
            depth++;
            break;
          case "end": case "delegate": {
            const b = stack.pop();
            if (b) pairs.set(b.idx, li);
            break;
          }
        }
        blockLine.push(stack.length);
      }
    } catch (e) {
      error = (e as Error).message;
    }
    void ends;
    if (opts.branchComments !== false) annotateBranches(lines, pairs);
  }

  const out: string[] = [];
  if (locals.length) out.push(".locals " + locals.join(" "));
  for (const l of lines) {
    out.push("  ".repeat(l.indent) + l.text + (l.comment ? "  ;; " + l.comment : ""));
  }
  const res: DisResult = { locals, lines, text: out.join("\n") };
  if (error) res.error = error;
  return res;
}

function annotateBranches(lines: DisLine[], pairs: Map<number, number>): void {
  // rebuild block stack to resolve relative depths
  const stack: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const n = l.name;
    if (n === "block" || n === "loop" || n === "if" || n === "try" || n === "try_table") stack.push(i);
    else if (n === "end" || n === "delegate") stack.pop();
    else if (n === "br" || n === "br_if" || n === "br_on_null" || n === "br_on_non_null") {
      const depth = Number(/\s(\d+)/.exec(l.text)?.[1] ?? NaN);
      if (!Number.isNaN(depth) && depth < stack.length) {
        const bi = stack[stack.length - 1 - depth]!;
        const target = lines[bi]!;
        if (target.name === "loop") l.comment = (l.comment ? l.comment + " " : "") + `-> loop@0x${target.off.toString(16)}`;
        else {
          const e = pairs.get(bi);
          if (e !== undefined) l.comment = (l.comment ? l.comment + " " : "") + `-> end@0x${lines[e]!.off.toString(16)}`;
        }
      } else if (!Number.isNaN(depth) && depth === stack.length) {
        l.comment = (l.comment ? l.comment + " " : "") + "-> return";
      }
    }
  }
}

function formatIns(buf: Uint8Array, ins: Ins, opts: DisOptions): DisLine {
  const op = ins.op;
  let text = op.name;
  let comment = "";
  let target: number | undefined;
  let i32: number | undefined;
  const line = { off: 0, len: ins.end - ins.pos, indent: 0, text: "", comment: "", name: op.name, bytes: buf.subarray(ins.pos, ins.end) } as DisLine;
  switch (op.imm) {
    case "":
      break;
    case "bt":
      text += btText(ins.bt);
      break;
    case "label": case "local": case "global": case "table": case "tag": case "elem": case "data":
      text += " " + ins.a;
      break;
    case "type":
      text += " " + ins.a;
      break;
    case "mem":
      if (ins.a !== 0) text += " " + ins.a;
      break;
    case "func":
      text += " " + ins.a;
      target = ins.a;
      comment = opts.funcName?.(ins.a) ?? "";
      break;
    case "brtable":
      text += " " + ins.list!.join(" ");
      break;
    case "callind":
      text += ` type=${ins.a} table=${ins.b}`;
      break;
    case "dataMem": case "elemTable": case "tabletable": case "typefield": case "typeN": case "typeData": case "typeElem": case "typeType":
      text += ` ${ins.a} ${ins.b}`;
      break;
    case "memmem":
      text += ` ${ins.a} ${ins.b}`;
      break;
    case "memarg": case "memarglane":
      if (ins.offset) text += ` offset=${ins.offset}`;
      if (ins.align !== naturalAlign(op)) text += ` align=${1 << ins.align}`;
      if (ins.memIdx) text += ` mem=${ins.memIdx}`;
      if (op.imm === "memarglane") text += ` lane=${ins.lane}`;
      break;
    case "i32":
      text += " " + ins.num;
      i32 = ins.num >>> 0;
      break;
    case "i64":
      text += " " + ins.big;
      break;
    case "f32": {
      const b = ins.bytes!;
      text += " " + f32ToString((b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0);
      break;
    }
    case "f64": {
      const b = ins.bytes!;
      text += " " + f64ToString((b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0, (b[4]! | (b[5]! << 8) | (b[6]! << 16) | (b[7]! << 24)) >>> 0);
      break;
    }
    case "selt": {
      const r = new Reader(buf, ins.immPos, ins.end);
      const n = r.u32();
      const ts: string[] = [];
      for (let k = 0; k < n; k++) {
        const b = r.u8();
        ts.push(VALTYPE_NAME[b] ?? "0x" + b.toString(16));
        if (b === 0x63 || b === 0x64) r.s33();
      }
      text = "select" + (ts.length ? ` (result ${ts.join(" ")})` : "");
      break;
    }
    case "heap": {
      const nm = HEAP_BY_NUM[ins.a];
      text += " " + (nm ?? ins.a);
      break;
    }
    case "trytable": {
      // keep raw so it round-trips: print immediates as hex
      text += btText(ins.bt) + " " + "raw:" + hex(buf.subarray(ins.immPos, ins.end));
      break;
    }
    case "v128":
      text += " 0x" + hex(Array.from(ins.bytes!).reverse());
      break;
    case "shuffle":
      text += " " + Array.from(ins.bytes!).join(" ");
      break;
    case "lane":
      text += " " + ins.lane;
      break;
    case "fence":
      break;
    case "brcast":
      text += " raw:" + hex(buf.subarray(ins.immPos, ins.end));
      break;
  }
  line.text = text;
  line.comment = comment;
  if (target !== undefined) line.target = target;
  if (i32 !== undefined) line.i32 = i32;
  return line;
}

/** Disassemble a raw instruction vector that has no locals header (helpers, tests). */
export function disassembleCode(code: Uint8Array, opts: DisOptions = {}): DisResult {
  const w = new Writer(code.length + 2);
  w.u32(0);
  w.raw(code);
  return disassembleBody(w.view(), 0, w.length, opts);
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------
export class AsmError extends Error {
  constructor(msg: string, readonly line: number) {
    super(`line ${line}: ${msg}`);
  }
}

export interface AsmResult {
  /** raw locals vector (count + entries) or null if no `.locals` directive was given */
  locals: Uint8Array | null;
  /** instruction bytes, terminated with `end` */
  code: Uint8Array;
  /** map from source line (1-based) to byte offset within `code` */
  lineOffsets: Map<number, number>;
}

function tokenize(line: string): string[] {
  // strip comments (;; to end of line) – but not inside strings (none used)
  const c = line.indexOf(";;");
  if (c >= 0) line = line.slice(0, c);
  const toks: string[] = [];
  const re = /\(|\)|[^\s()]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) toks.push(m[0]);
  return toks;
}

function parseIntTok(t: string | undefined, ln: number, what: string): number {
  if (t === undefined) throw new AsmError(`missing ${what}`, ln);
  if (!/^-?(0x[0-9a-f]+|\d+)$/i.test(t)) throw new AsmError(`bad ${what} "${t}"`, ln);
  const v = t.startsWith("-0x") ? -parseInt(t.slice(3), 16) : Number(t);
  return v;
}
function parseBigTok(t: string | undefined, ln: number): bigint {
  if (t === undefined) throw new AsmError("missing i64 value", ln);
  try {
    if (t.startsWith("-0x")) return -BigInt(t.slice(1));
    return BigInt(t);
  } catch {
    throw new AsmError(`bad i64 value "${t}"`, ln);
  }
}

function parseFloatTok(t: string | undefined, ln: number, bits64: boolean): number | bigint {
  if (t === undefined) throw new AsmError("missing float value", ln);
  const neg = t.startsWith("-");
  const body = t.replace(/^[+-]/, "").toLowerCase();
  if (body === "inf") return bits64 ? (neg ? 0xfff0000000000000n : 0x7ff0000000000000n) : neg ? 0xff800000 : 0x7f800000;
  if (body === "nan") return bits64 ? (neg ? 0xfff8000000000000n : 0x7ff8000000000000n) : neg ? 0xffc00000 : 0x7fc00000;
  const nm = /^nan:(0x[0-9a-f]+)$/.exec(body);
  if (nm) {
    const b = BigInt(nm[1]!);
    if (bits64) return (neg ? 1n << 63n : 0n) | b;
    return ((neg ? 0x80000000 : 0) | Number(b)) >>> 0;
  }
  const v = Number(t);
  if (Number.isNaN(v) || t.trim() === "") throw new AsmError(`bad float "${t}"`, ln);
  const dv = new DataView(new ArrayBuffer(8));
  if (bits64) {
    dv.setFloat64(0, v, true);
    return dv.getBigUint64(0, true);
  }
  dv.setFloat32(0, v, true);
  return dv.getUint32(0, true);
}

function parseValType(t: string | undefined, ln: number): number {
  if (t === undefined || !(t in VALTYPE_BYTE)) throw new AsmError(`bad value type "${t}"`, ln);
  return VALTYPE_BYTE[t]!;
}

/** Parse `key=value` tokens into a map and return positional tokens. */
function kv(toks: string[]): { pos: string[]; kv: Record<string, string> } {
  const pos: string[] = [];
  const m: Record<string, string> = {};
  for (const t of toks) {
    const i = t.indexOf("=");
    if (i > 0) m[t.slice(0, i)] = t.slice(i + 1);
    else pos.push(t);
  }
  return { pos, kv: m };
}

function readBlockType(toks: string[], ln: number): number {
  if (toks.length === 0) return -64;
  // (result i32) | (type N) | i32 | void
  if (toks[0] === "(") {
    const head = toks[1];
    if (head === "result") {
      const t = toks[2];
      return -(0x80 - parseValType(t, ln)); // s33 of single-byte valtype
    }
    if (head === "type") return parseIntTok(toks[2], ln, "type index");
    throw new AsmError(`bad block type "${head}"`, ln);
  }
  if (toks[0] === "void" || toks[0] === "empty") return -64;
  if (toks[0]! in VALTYPE_BYTE) return -(0x80 - parseValType(toks[0], ln));
  throw new AsmError(`bad block type "${toks[0]}"`, ln);
}

function emitMemarg(w: Writer, op: OpInfo, k: Record<string, string>, ln: number): void {
  let align = naturalAlign(op);
  if (k.align !== undefined) {
    const a = parseIntTok(k.align, ln, "align");
    if (a <= 0 || (a & (a - 1)) !== 0) throw new AsmError("align must be a power of two", ln);
    align = Math.log2(a) | 0;
  }
  const offset = k.offset !== undefined ? BigInt(parseIntTok(k.offset, ln, "offset")) : 0n;
  const mem = k.mem !== undefined ? parseIntTok(k.mem, ln, "mem") : 0;
  if (mem) {
    w.u32(align | 0x40);
    w.u32(mem);
  } else w.u32(align);
  w.u64(offset);
}

function emitOpcode(w: Writer, op: OpInfo): void {
  if (op.prefix) {
    w.u8(op.prefix);
    w.u32(op.code);
  } else w.u8(op.code);
}

export function assemble(text: string): AsmResult {
  const w = new Writer(256);
  let locals: Uint8Array | null = null;
  const lineOffsets = new Map<number, number>();
  const lines = text.split(/\r?\n/);
  let depth = 0;
  let closed = false; // function-level end already emitted

  for (let li = 0; li < lines.length; li++) {
    const ln = li + 1;
    const toks = tokenize(lines[li]!);
    if (toks.length === 0) continue;
    let head = toks[0]!.toLowerCase();
    const rest = toks.slice(1);

    if (head === ".locals") {
      const lw = new Writer(16);
      // group runs of identical types
      const types = rest.map((t) => parseValType(t, ln));
      const groups: [number, number][] = [];
      for (const t of types) {
        const g = groups[groups.length - 1];
        if (g && g[1] === t) g[0]++;
        else groups.push([1, t]);
      }
      lw.u32(groups.length);
      for (const [n, t] of groups) {
        lw.u32(n);
        lw.u8(t);
      }
      locals = lw.result();
      continue;
    }
    if (closed) throw new AsmError("instructions after the function's final end", ln);

    lineOffsets.set(ln, w.length);
    head = ALIASES[head] ?? head;
    if (head === "select" && rest.length) head = "select_t";
    const op = BY_NAME.get(head);
    if (!op) {
      const raw = /^(?:(0x[0-9a-f]+)\.)?(0x[0-9a-f]+)$/.exec(head);
      if (raw) {
        // raw opcode form printed by the disassembler for unknown ops
        if (raw[1]) {
          w.u8(Number(raw[1]));
          w.u32(Number(raw[2]));
        } else w.u8(Number(raw[2]));
        continue;
      }
      throw new AsmError(`unknown instruction "${toks[0]}"`, ln);
    }

    emitOpcode(w, op);
    const { pos, kv: k } = kv(rest);
    const n = (i: number, what: string) => parseIntTok(pos[i], ln, what);
    switch (op.imm) {
      case "":
        break;
      case "bt":
        w.s32(readBlockType(rest, ln));
        break;
      case "label": case "local": case "global": case "table": case "tag": case "elem": case "data": case "type":
        w.u32(n(0, "index"));
        break;
      case "func": {
        const t = pos[0];
        if (t === undefined) throw new AsmError("missing function index", ln);
        w.u32(parseIntTok(t, ln, "function index"));
        break;
      }
      case "mem":
        w.u32(pos[0] === undefined ? 0 : n(0, "memory index"));
        break;
      case "brtable": {
        if (pos.length < 1) throw new AsmError("br_table needs at least a default label", ln);
        w.u32(pos.length - 1);
        for (let i = 0; i < pos.length; i++) w.u32(n(i, "label"));
        break;
      }
      case "callind": {
        const tIdx = k.type !== undefined ? parseIntTok(k.type, ln, "type") : n(0, "type index");
        const tbl = k.table !== undefined ? parseIntTok(k.table, ln, "table") : pos[k.type !== undefined ? 0 : 1] !== undefined ? n(k.type !== undefined ? 0 : 1, "table") : 0;
        w.u32(tIdx);
        w.u32(tbl);
        break;
      }
      case "dataMem": case "elemTable": case "tabletable": case "typefield": case "typeN": case "typeData": case "typeElem": case "typeType":
        w.u32(n(0, "index"));
        w.u32(pos[1] === undefined ? 0 : n(1, "index"));
        break;
      case "memmem":
        w.u32(pos[0] === undefined ? 0 : n(0, "memory index"));
        w.u32(pos[1] === undefined ? 0 : n(1, "memory index"));
        break;
      case "memarg":
        emitMemarg(w, op, k, ln);
        break;
      case "memarglane":
        emitMemarg(w, op, k, ln);
        w.u8(parseIntTok(k.lane, ln, "lane"));
        break;
      case "i32": {
        const v = pos[0];
        if (v === undefined) throw new AsmError("missing i32 value", ln);
        const big = parseBigTok(v, ln);
        if (big < -(2n ** 31n) || big > 2n ** 32n - 1n) throw new AsmError("i32 value out of range", ln);
        w.s32(Number(BigInt.asIntN(32, big)));
        break;
      }
      case "i64":
        w.s64(parseBigTok(pos[0], ln));
        break;
      case "f32": {
        const bits = parseFloatTok(pos[0], ln, false) as number;
        w.bytes([bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]);
        break;
      }
      case "f64": {
        const bits = parseFloatTok(pos[0], ln, true) as bigint;
        for (let i = 0; i < 8; i++) w.u8(Number((bits >> BigInt(8 * i)) & 0xffn));
        break;
      }
      case "selt": {
        // select (result i32 ...)
        const types: number[] = [];
        for (let i = 2; i < rest.length && rest[i] !== ")"; i++) types.push(parseValType(rest[i], ln));
        if (rest[0] !== "(" || rest[1] !== "result") throw new AsmError("select expects (result <type>)", ln);
        w.u32(types.length);
        for (const t of types) w.u8(t);
        break;
      }
      case "heap": {
        const t = pos[0];
        if (t === undefined) throw new AsmError("missing heap type", ln);
        if (t in HEAP_NAMES) w.s32(HEAP_NAMES[t]!);
        else w.s32(parseIntTok(t, ln, "heap type"));
        break;
      }
      case "trytable":
      case "brcast": {
        const raw = rest.find((t) => t.startsWith("raw:"));
        if (!raw) throw new AsmError(`${op.name} must use the raw:<hex> form printed by the disassembler`, ln);
        const hx = raw.slice(4);
        for (let i = 0; i + 1 < hx.length; i += 2) w.u8(parseInt(hx.substr(i, 2), 16));
        break;
      }
      case "v128": {
        const t = (pos[0] ?? "").replace(/^0x/i, "");
        if (!/^[0-9a-f]{32}$/i.test(t)) throw new AsmError("v128.const expects 0x followed by 32 hex digits", ln);
        for (let i = 15; i >= 0; i--) w.u8(parseInt(t.substr(i * 2, 2), 16));
        break;
      }
      case "shuffle":
        if (pos.length !== 16) throw new AsmError("i8x16.shuffle expects 16 lane indices", ln);
        for (let i = 0; i < 16; i++) w.u8(n(i, "lane"));
        break;
      case "lane":
        w.u8(n(0, "lane"));
        break;
      case "fence":
        w.u8(0);
        break;
      default: {
        const never: never = op.imm;
        throw new AsmError("unsupported immediate " + never, ln);
      }
    }

    switch (op.name) {
      case "block": case "loop": case "if": case "try": case "try_table":
        depth++;
        break;
      case "end": case "delegate":
        if (depth === 0) closed = true;
        else depth--;
        break;
    }
  }

  if (!closed) {
    if (depth > 0) throw new AsmError(`${depth} unclosed block(s): missing "end"`, lines.length);
    w.u8(0x0b);
  }
  return { locals, code: w.result(), lineOffsets };
}

/** Build a full function body (locals vector + code) from an assembled result and the original body. */
export function buildBody(asm: AsmResult, original?: { locals: Uint8Array }): Uint8Array {
  const w = new Writer(asm.code.length + 8);
  if (asm.locals) w.raw(asm.locals);
  else if (original) w.raw(original.locals);
  else w.u32(0);
  w.raw(asm.code);
  return w.result();
}

export { utf8Encode, PREFIXES, OPS };
