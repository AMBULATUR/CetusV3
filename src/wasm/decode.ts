import { Reader } from "./leb";
import { BY_KEY, OpInfo, PREFIXES, key } from "./opcodes";

/** Reusable decoded instruction (allocation-free hot path). */
export interface Ins {
  pos: number;
  /** offset of the first byte after the opcode (+ sub-opcode) */
  immPos: number;
  end: number;
  op: OpInfo;
  /** first u32 immediate (label/func/local/global/type/table/tag/data ...) */
  a: number;
  /** second u32 immediate */
  b: number;
  /** blocktype for bt/trytable */
  bt: number;
  align: number;
  offset: number;
  memIdx: number;
  /** numeric value for i32.const / f32.const / f64.const */
  num: number;
  big: bigint;
  list: number[] | null;
  bytes: Uint8Array | null;
  lane: number;
}

export function newIns(): Ins {
  return {
    pos: 0, immPos: 0, end: 0, op: undefined as unknown as OpInfo,
    a: 0, b: 0, bt: 0, align: 0, offset: 0, memIdx: 0, num: 0, big: 0n, list: null, bytes: null, lane: 0,
  };
}

function skipValType(r: Reader): void {
  const b = r.u8();
  if (b === 0x63 || b === 0x64) r.s33();
}

function readMemarg(r: Reader, ins: Ins): void {
  const flags = r.u32();
  ins.align = flags & 0x3f;
  ins.memIdx = 0;
  if (flags & 0x40) ins.memIdx = r.u32();
  ins.offset = Number(r.u64());
}

export class DecodeError extends Error {
  constructor(msg: string, readonly offset: number) {
    super(`${msg} (at offset 0x${offset.toString(16)})`);
  }
}

/** Decode one instruction at r.pos into `ins` and advance r past it. */
export function decode(r: Reader, ins: Ins): void {
  ins.pos = r.pos;
  let prefix = 0;
  let code = r.u8();
  if (PREFIXES.has(code)) {
    prefix = code;
    code = r.u32();
  }
  const op = BY_KEY.get(key(prefix, code));
  if (!op) {
    throw new DecodeError(
      `unknown opcode ${prefix ? "0x" + prefix.toString(16) + " " : ""}0x${code.toString(16)}`,
      ins.pos,
    );
  }
  ins.op = op;
  ins.immPos = r.pos;
  ins.list = null;
  ins.bytes = null;
  switch (op.imm) {
    case "":
      break;
    case "bt":
      ins.bt = r.s33();
      break;
    case "label":
    case "func":
    case "local":
    case "global":
    case "table":
    case "tag":
    case "type":
    case "mem":
    case "data":
    case "elem":
      ins.a = r.u32();
      break;
    case "brtable": {
      const n = r.u32();
      const list: number[] = new Array(n + 1);
      for (let i = 0; i <= n; i++) list[i] = r.u32();
      ins.list = list;
      break;
    }
    case "callind":
    case "dataMem":
    case "elemTable":
    case "memmem":
    case "tabletable":
    case "typefield":
    case "typeN":
    case "typeData":
    case "typeElem":
    case "typeType":
      ins.a = r.u32();
      ins.b = r.u32();
      break;
    case "memarg":
      readMemarg(r, ins);
      break;
    case "memarglane":
      readMemarg(r, ins);
      ins.lane = r.u8();
      break;
    case "i32":
      ins.num = r.s32();
      break;
    case "i64":
      ins.big = r.s64();
      break;
    case "f32":
      ins.bytes = r.bytes(4);
      break;
    case "f64":
      ins.bytes = r.bytes(8);
      break;
    case "selt": {
      const n = r.u32();
      for (let i = 0; i < n; i++) skipValType(r);
      break;
    }
    case "heap":
      ins.a = r.s33();
      break;
    case "trytable": {
      ins.bt = r.s33();
      const n = r.u32();
      for (let i = 0; i < n; i++) {
        const kind = r.u8();
        if (kind <= 1) {
          r.u32();
          r.u32();
        } else if (kind <= 3) r.u32();
        else throw new DecodeError("bad catch clause kind " + kind, r.pos);
      }
      break;
    }
    case "v128":
    case "shuffle":
      ins.bytes = r.bytes(16);
      break;
    case "lane":
    case "fence":
      ins.lane = r.u8();
      break;
    case "brcast":
      ins.lane = r.u8(); // flags
      ins.a = r.u32(); // label
      r.s33();
      r.s33();
      break;
    default: {
      const never: never = op.imm;
      throw new Error("unhandled immediate kind " + never);
    }
  }
  ins.end = r.pos;
}

export interface BodyHeader {
  /** raw bytes of each (count, valtype) entry */
  localEntries: Uint8Array[];
  localCounts: number[];
  totalLocals: number;
  /** offset of first instruction */
  codeStart: number;
  /** offset where the locals vector starts */
  start: number;
}

export function parseBodyHeader(buf: Uint8Array, start: number, end: number): BodyHeader {
  const r = new Reader(buf, start, end);
  const n = r.u32();
  const entries: Uint8Array[] = [];
  const counts: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const s = r.pos;
    const cnt = r.u32();
    skipValType(r);
    entries.push(buf.subarray(s, r.pos));
    counts.push(cnt);
    total += cnt;
    if (total > 50000) throw new RangeError("function declares too many locals");
  }
  return { localEntries: entries, localCounts: counts, totalLocals: total, codeStart: r.pos, start };
}

/** Walk every instruction of [start,end). */
export function walk(buf: Uint8Array, start: number, end: number, visit: (ins: Ins) => void): void {
  const r = new Reader(buf, start, end);
  const ins = newIns();
  while (!r.eof) {
    decode(r, ins);
    visit(ins);
  }
}
