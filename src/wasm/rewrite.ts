import { Reader, Writer } from "./leb";
import { ModuleModel, SEC, Section } from "./module";
import { Ins, decode, newIns, parseBodyHeader } from "./decode";
import { assemble } from "./text";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export interface InstrumentConfig {
  /** watch slots (0..16). Each slot can watch reads, writes and/or freeze a value */
  slots: number;
  /** hook every store: detects writes and enforces freezes */
  write: boolean;
  /** hook every load: detects reads (costs some speed) */
  read: boolean;
  /** hook every function entry: enables function breakpoints and call tracing */
  funcHooks: boolean;
  /** function breakpoint slots (0..16) */
  funcSlots: number;
}

export const DEFAULT_INSTRUMENT: InstrumentConfig = { slots: 8, write: true, read: true, funcHooks: true, funcSlots: 8 };

export interface FunctionPatch {
  index: number;
  /** replacement instruction bytes (must end with `end`) */
  code: Uint8Array;
  /** replacement locals vector (count + entries); if omitted the original locals are kept */
  locals?: Uint8Array | null;
}

/** A line breakpoint request: an instruction (by byte offset from the function body start) in the ORIGINAL module. */
export interface BpRequest { func: number; off: number; enabled: boolean }

/** What was actually compiled in for a request (filled while rewriting). */
export interface BpFound {
  id: number;
  func: number;
  off: number;
  /** instruction mnemonic */
  name: string;
  kind: "store" | "load" | "generic";
  /** bytes accessed in memory (store/load) */
  size: number;
  /** value type code: 0x7f i32, 0x7e i64, 0x7d f32, 0x7c f64 (store/load) */
  valType: number;
  /** static memarg offset */
  offset: number;
  /** type codes of the function's params + locals captured in the snapshot */
  localCodes: number[];
}

/**
 * Shared-memory watchpoint state ("control block").
 *
 * Globals are per *instance*, so a watchpoint armed through the main thread's globals is invisible to
 * Emscripten pthread workers (each worker instantiates its own copy of the module). When the module's
 * memory is shared we therefore keep the watch table inside linear memory instead; every thread reads
 * the same bytes. All fields are 32-bit little-endian words unless noted.
 *
 *   +0x00 magic            +0x04 wen (write hooks on)   +0x08 ren (read hooks on)
 *   +0x0c ring head (atomic, claimed by hitting threads)
 *   +0x20 slot[0..7], 32 bytes each: addr, size, flags, -, val(i64 @ +16)
 *   +0x120 hit ring: 16 entries x 32 bytes: kind|slot<<8, ea, func, off, commit(seq+1)
 */
export const CTRL = {
  MAGIC: 0x43455455,
  WEN: 0x04,
  REN: 0x08,
  HEAD: 0x0c,
  SLOTS: 0x20,
  SLOT_STRIDE: 32,
  MAX_SLOTS: 8,
  RING: 0x20 + 8 * 32,
  RING_N: 16,
  RING_STRIDE: 32,
  SIZE: 0x20 + 8 * 32 + 16 * 32,
  DEFAULT_ADDR: 0x20,
} as const;

export interface SharedWatchOptions {
  /** address of the control block in linear memory (8-byte aligned) */
  ctrl: number;
  /**
   * Worker-safe build: adds NO imports. Hits are appended to the ring buffer inside the control block
   * (with function + instruction offset) instead of calling `__cetus.hit`, and function hooks / line
   * breakpoints are left out. This is the build handed to Web Workers.
   */
  ring?: boolean;
}

export interface RewriteOptions {
  instrument?: InstrumentConfig | null;
  patches?: FunctionPatch[];
  bps?: BpRequest[];
  /** keep the watch table in shared linear memory (only honoured when memory 0 is `shared`) */
  shared?: SharedWatchOptions | null;
}

export interface GlobalNames {
  wen?: string;
  ren?: string;
  fen?: string;
  addr: string[];
  size: string[];
  flags: string[];
  val: string[];
  fbp: string[];
}

export interface RewriteResult {
  bytes: Uint8Array;
  /** true if any instrumentation was inserted */
  instrumented: boolean;
  features: { write: boolean; read: boolean; funcHooks: boolean; slots: number; funcSlots: number };
  /** set when the watch table lives in linear memory (see CTRL); null = per-instance globals */
  shared: { ctrl: number; ring: boolean } | null;
  /** number of function imports added (all function indices >= N0 shift by K) */
  K: number;
  N0: number;
  /** new index of the first helper function (functions >= this are Cetus helpers); Infinity if none */
  helperStart: number;
  /** offset of each original defined function body inside `bytes` */
  newBodyStart: Uint32Array;
  /** name under which memory 0 can be found in exports (for defined, non-exported memories) */
  memoryExport: string | null;
  globals: GlobalNames;
  patched: number[];
  warnings: string[];
  /** indices used by the inserted hooks (needed to re-run body rewriting identically) */
  ctxIdx: { wen: number; ren: number; fen: number; wcheck: number; rcheck: number; fcheck: number };
  /** line breakpoints: one entry per request (null = the instruction was not found / unsupported) */
  bp: { found: (BpFound | null)[]; sitesByFunc: Map<number, Map<number, { id: number; flagIdx: number }>>; flagNames: string[]; reqs: BpRequest[] };
}

export const IMPORT_MODULE = "__cetus";

// ---------------------------------------------------------------------------
// Helper function generation (assembled from text so it can be read & tested)
// ---------------------------------------------------------------------------
const T = { hit: 0, void: 1, wslot: 2, rcheck: 3, fcheck: 4, bp: 5, rcheckF: 6, record: 7, wslotF: 8 };

function bodyOf(text: string): Uint8Array {
  const a = assemble(text);
  const w = new Writer(a.code.length + 8);
  w.raw(a.locals ?? Uint8Array.of(0));
  w.raw(a.code);
  return w.result();
}

/**
 * `ring` = worker-safe flavour: two more params (func, off) and the hit goes to `hitIdx`, which then is the
 * local ring-buffer recorder (kind, slot, ea, func, off) instead of the imported `__cetus.hit(kind, slot)`.
 */
function genWslot(hitIdx: number, ring = false): Uint8Array {
  const L = ring ? 7 : 5; // index of the scratch i64 local (after the params)
  const hitCall = ring
    ? `i32.const 2\n    local.get 4\n    local.get 0\n    local.get 5\n    local.get 6\n    call ${hitIdx}`
    : `i32.const 2\n    local.get 4\n    call ${hitIdx}`;
  return bodyOf(`
.locals i64
local.get 1
i32.const 1
i32.eq
if (result i64)
  local.get 0
  i64.load8_u
else
  local.get 1
  i32.const 2
  i32.eq
  if (result i64)
    local.get 0
    i64.load16_u
  else
    local.get 1
    i32.const 4
    i32.eq
    if (result i64)
      local.get 0
      i64.load32_u
    else
      local.get 0
      i64.load
    end
  end
end
local.tee ${L}
local.get 3
i64.ne
if
  local.get 2
  i32.const 2
  i32.and
  if
    ${hitCall}
  end
  local.get 2
  i32.const 4
  i32.and
  if
    local.get 1
    i32.const 1
    i32.eq
    if
      local.get 0
      local.get 3
      i64.store8
    else
      local.get 1
      i32.const 2
      i32.eq
      if
        local.get 0
        local.get 3
        i64.store16
      else
        local.get 1
        i32.const 4
        i32.eq
        if
          local.get 0
          local.get 3
          i64.store32
        else
          local.get 0
          local.get 3
          i64.store
        end
      end
    end
    local.get 3
    local.set ${L}
  end
end
local.get ${L}
end`);
}

const slotAt = (ctrl: number, s: number): number => ctrl + CTRL.SLOTS + s * CTRL.SLOT_STRIDE;

/** wcheck for the shared-memory watch table. Ring flavour takes (func, off) so a hit can name its code. */
function genWcheckMem(ctrl: number, wslotIdx: number, slots: number, ring: boolean): Uint8Array {
  const tmp = ring ? 2 : 0;
  let t = `\n.locals i64`;
  for (let s = 0; s < slots; s++) {
    const a = slotAt(ctrl, s);
    t += `
i32.const ${a + 8}
i32.load
i32.const 6
i32.and
if
  i32.const ${a}
  i32.load
  i32.const ${a + 4}
  i32.load
  i32.const ${a + 8}
  i32.load
  i32.const ${a + 16}
  i64.load
  i32.const ${s}${ring ? "\n  local.get 0\n  local.get 1" : ""}
  call ${wslotIdx}
  local.set ${tmp}
  i32.const ${a + 16}
  local.get ${tmp}
  i64.store
end`;
  }
  return bodyOf(t + "\nend");
}

/** rcheck for the shared-memory watch table. Ring flavour: (ea, offset, size, func, off). */
function genRcheckMem(ctrl: number, hitIdx: number, slots: number, ring: boolean): Uint8Array {
  const tmp = ring ? 5 : 3;
  let t = `
.locals i32
local.get 0
local.get 1
i32.add
local.set ${tmp}`;
  for (let s = 0; s < slots; s++) {
    const a = slotAt(ctrl, s);
    t += `
i32.const ${a + 8}
i32.load
i32.const 1
i32.and
if
  local.get ${tmp}
  i32.const ${a}
  i32.load
  i32.const ${a + 4}
  i32.load
  i32.add
  i32.lt_u
  if
    local.get ${tmp}
    local.get 2
    i32.add
    i32.const ${a}
    i32.load
    i32.gt_u
    if
      i32.const 1
      i32.const ${s}${ring ? `\n      local.get ${tmp}\n      local.get 3\n      local.get 4` : ""}
      call ${hitIdx}
    end
  end
end`;
  }
  return bodyOf(t + "\nend");
}

/**
 * record(kind, slot, ea, func, off): lock-free append to the hit ring. Safe to call from any thread:
 * the slot is claimed with an atomic add, the payload is written, and the commit word (seq+1) is stored
 * last with an atomic store so the reader can tell a finished entry from one still being written.
 */
function genRecord(ctrl: number): Uint8Array {
  const ring = ctrl + CTRL.RING;
  return bodyOf(`
.locals i32 i32
i32.const ${ctrl + CTRL.HEAD}
i32.const 1
i32.atomic.rmw.add
local.tee 5
i32.const ${CTRL.RING_N - 1}
i32.and
i32.const 5
i32.shl
i32.const ${ring}
i32.add
local.set 6
local.get 6
local.get 0
local.get 1
i32.const 8
i32.shl
i32.or
i32.store
local.get 6
local.get 2
i32.store offset=4
local.get 6
local.get 3
i32.store offset=8
local.get 6
local.get 4
i32.store offset=12
local.get 6
local.get 5
i32.const 1
i32.add
i32.atomic.store offset=16
end`);
}

function genWcheck(g: GlobalNamesIdx, wslotIdx: number, slots: number): Uint8Array {
  let t = "";
  for (let s = 0; s < slots; s++) {
    t += `
global.get ${g.flags[s]}
i32.const 6
i32.and
if
  global.get ${g.addr[s]}
  global.get ${g.size[s]}
  global.get ${g.flags[s]}
  global.get ${g.val[s]}
  i32.const ${s}
  call ${wslotIdx}
  global.set ${g.val[s]}
end`;
  }
  return bodyOf(t + "\nend");
}

function genRcheck(g: GlobalNamesIdx, hitIdx: number, slots: number): Uint8Array {
  let t = `
.locals i32
local.get 0
local.get 1
i32.add
local.set 3`;
  for (let s = 0; s < slots; s++) {
    t += `
global.get ${g.flags[s]}
i32.const 1
i32.and
if
  local.get 3
  global.get ${g.addr[s]}
  global.get ${g.size[s]}
  i32.add
  i32.lt_u
  if
    local.get 3
    local.get 2
    i32.add
    global.get ${g.addr[s]}
    i32.gt_u
    if
      i32.const 1
      i32.const ${s}
      call ${hitIdx}
    end
  end
end`;
  }
  return bodyOf(t + "\nend");
}

function genFcheck(fenIdx: number, fbp: number[], fhitIdx: number): Uint8Array {
  let t = `
global.get ${fenIdx}
i32.const 2
i32.eq
if
  i32.const -1
  local.get 0
  call ${fhitIdx}
end`;
  for (let f = 0; f < fbp.length; f++) {
    t += `
global.get ${fbp[f]}
local.get 0
i32.eq
if
  i32.const ${f}
  local.get 0
  call ${fhitIdx}
end`;
  }
  return bodyOf(t + "\nend");
}

interface GlobalNamesIdx {
  addr: number[];
  size: number[];
  flags: number[];
  val: number[];
}

// ---------------------------------------------------------------------------
// Section plumbing
// ---------------------------------------------------------------------------
const RANK: Record<number, number> = {
  [SEC.type]: 1, [SEC.import]: 2, [SEC.function]: 3, [SEC.table]: 4, [SEC.memory]: 5, [SEC.tag]: 6,
  [SEC.global]: 7, [SEC.export]: 8, [SEC.start]: 9, [SEC.element]: 10, [SEC.dataCount]: 11, [SEC.code]: 12, [SEC.data]: 13,
};

interface Out {
  id: number;
  payload: Uint8Array | null;
  sec?: Section;
  isCode?: boolean;
}

function remapExpr(r: Reader, w: Writer, shift: (i: number) => number): void {
  const ins = newIns();
  const src = r.buf;
  for (;;) {
    decode(r, ins);
    if (ins.op.name === "ref.func") {
      w.u8(0xd2);
      w.u32(shift(ins.a));
    } else w.raw(src.subarray(ins.pos, ins.end));
    if (ins.op.name === "end") break;
  }
}

function remapElementSection(bytes: Uint8Array, sec: Section, shift: (i: number) => number): Uint8Array {
  const r = new Reader(bytes, sec.payloadStart, sec.end);
  const w = new Writer(sec.end - sec.payloadStart + 16);
  const n = r.u32();
  w.u32(n);
  for (let i = 0; i < n; i++) {
    const flag = r.u32();
    w.u32(flag);
    const active = (flag & 1) === 0;
    const usesExprs = (flag & 4) !== 0;
    if (flag === 2 || flag === 6) w.u32(r.u32());
    if (active) remapExpr(r, w, shift);
    if (flag & 3) {
      const a = r.pos;
      const b = r.u8();
      if (usesExprs && (b === 0x63 || b === 0x64)) r.s33();
      w.raw(bytes.subarray(a, r.pos));
    }
    const cnt = r.u32();
    w.u32(cnt);
    for (let j = 0; j < cnt; j++) {
      if (usesExprs) remapExpr(r, w, shift);
      else w.u32(shift(r.u32()));
    }
  }
  return w.result();
}

function remapNameSection(bytes: Uint8Array, sec: Section, shift: (i: number) => number): Uint8Array {
  const r = new Reader(bytes, sec.payloadStart, sec.end);
  const w = new Writer(sec.end - sec.payloadStart + 16);
  w.name(r.name());
  while (!r.eof) {
    const id = r.u8();
    const size = r.u32();
    const end = r.pos + size;
    const sr = new Reader(bytes, r.pos, end);
    const sw = new Writer(size + 8);
    try {
      if (id === 1) {
        const n = sr.u32();
        sw.u32(n);
        for (let i = 0; i < n; i++) {
          sw.u32(shift(sr.u32()));
          sw.name(sr.name());
        }
      } else if (id === 2 || id === 3) {
        const n = sr.u32();
        sw.u32(n);
        for (let i = 0; i < n; i++) {
          sw.u32(shift(sr.u32()));
          const m = sr.u32();
          sw.u32(m);
          for (let j = 0; j < m; j++) {
            sw.u32(sr.u32());
            sw.name(sr.name());
          }
        }
      } else sw.raw(bytes.subarray(r.pos, end));
    } catch {
      // malformed name subsection: drop it
      r.pos = end;
      continue;
    }
    w.u8(id);
    w.u32(sw.length);
    w.raw(sw.view());
    r.pos = end;
  }
  return w.result();
}

// ---------------------------------------------------------------------------
// Function body rewriting
// ---------------------------------------------------------------------------
interface BodyCtx {
  m: ModuleModel;
  N0: number;
  K: number;
  write: boolean;
  read: boolean;
  funcHooks: boolean;
  wenIdx: number;
  renIdx: number;
  fenIdx: number;
  wcheckIdx: number;
  rcheckIdx: number;
  fcheckIdx: number;
  /** function -> (byte offset -> site) */
  sites: Map<number, Map<number, { id: number; flagIdx: number }>>;
  found: (BpFound | null)[];
  bpImport: number;
  bplImport: number;
  /** watch table in shared linear memory (null = per-instance globals) */
  shared: { ctrl: number; ring: boolean } | null;
}

/**
 * Which operands sit above the address on the stack for an instruction that READS linear memory through
 * memarg 0, as value-type codes bottom -> top. null = not a (hookable) read.
 *   plain / atomic / SIMD loads        -> []            (address is on top)
 *   v128.loadN_lane                    -> [v128]
 *   atomic rmw (read-modify-write)     -> [t]
 *   atomic rmw cmpxchg                 -> [t, t]
 */
function readOperands(name: string, imm: string, acc: { load: boolean; store: boolean } | undefined): number[] | null {
  if (!acc || !acc.load) return null;
  if (imm === "memarglane") return acc.store ? null : [0x7b];
  if (imm !== "memarg") return null;
  if (!acc.store) return [];
  if (!/\.atomic\.rmw/.test(name)) return null;
  const t = name.startsWith("i64.") ? 0x7e : 0x7f;
  return /cmpxchg/.test(name) ? [t, t] : [t];
}

const shiftFn = (ctx: { N0: number; K: number }) => (i: number) => (i >= ctx.N0 ? i + ctx.K : i);

/**
 * Rewrites one function body: shifts function indices, inserts hooks.
 * `rec`, when given, receives pairs [newRelativeOffsetFromCodeStart..]. See mapping notes in rewriteModule().
 */
const NUMERIC = new Set([0x7f, 0x7e, 0x7d, 0x7c]);
const VT_BYTE: Record<string, number> = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

/** i64 "bits" of a numeric value already on the stack, so every type can go through one typed import. */
function emitToBits(cw: Writer, code: number): void {
  if (code === 0x7f) cw.u8(0xad); // i64.extend_i32_u
  else if (code === 0x7d) cw.u8(0xbc).u8(0xad); // i32.reinterpret_f32; i64.extend_i32_u
  else if (code === 0x7c) cw.u8(0xbd); // i64.reinterpret_f64
}

/**
 * Rewrites one function body: shifts function indices, inserts hooks.
 * `rec`, when given, receives pairs [newOffset, originalOffset] (offsets relative to the body start) so
 * stack-trace offsets can be mapped back to the original instruction.
 */
export function rewriteBody(
  src: Uint8Array,
  start: number,
  end: number,
  funcIdx: number,
  ctx: BodyCtx,
  rec?: number[],
): Uint8Array {
  const h = parseBodyHeader(src, start, end);
  const shift = shiftFn(ctx);
  const cw = new Writer((end - h.codeStart) * 2 + 32);
  const ins: Ins = newIns();

  const siteMap = ctx.sites.get(funcIdx);
  let nparams = -1;
  let paramCodes: number[] = [];
  if (ctx.read || siteMap) {
    const t = ctx.m.types[ctx.m.funcTypeIdx[funcIdx] ?? -1];
    if (t) { nparams = t.params.length; paramCodes = t.params.map((p) => VT_BYTE[p] ?? 0); }
  }
  const baseLocal = nparams >= 0 ? nparams + h.totalLocals : -1;
  // scratch locals are allocated on first use; the header declares them in allocation order
  const extra: number[] = [];
  const roles: Record<string, number> = {};
  const scratch = (role: string, type: number): number => {
    if (roles[role] === undefined) { roles[role] = baseLocal + extra.length; extra.push(type); }
    return roles[role]!;
  };
  // numeric params + declared locals, for the breakpoint snapshot
  let localCodes: number[] | null = null;
  const getLocalCodes = (): number[] => {
    if (localCodes) return localCodes;
    const out = paramCodes.slice();
    for (let i = 0; i < h.localEntries.length; i++) {
      const lr = new Reader(h.localEntries[i]!);
      lr.u32();
      const code = lr.u8();
      for (let k = 0; k < h.localCounts[i]!; k++) out.push(NUMERIC.has(code) ? code : 0);
    }
    return (localCodes = out);
  };
  const snapshot = (id: number) => {
    const codes = getLocalCodes();
    for (let i = 0; i < codes.length && i < 24; i++) {
      if (!codes[i]) continue;
      cw.u8(0x41).s32(id).u8(0x41).s32(i).u8(0x20).u32(i);
      emitToBits(cw, codes[i]!);
      cw.u8(0x10).u32(ctx.bplImport);
    }
  };

  if (ctx.funcHooks) {
    // if (fen) fcheck(origIdx)
    cw.u8(0x23).u32(ctx.fenIdx).u8(0x04).u8(0x40);
    cw.u8(0x41).s32(funcIdx).u8(0x10).u32(ctx.fcheckIdx);
    cw.u8(0x0b);
  }

  const r = new Reader(src, h.codeStart, end);
  while (!r.eof) {
    decode(r, ins);
    if (rec) rec.push(cw.length, ins.pos - start);
    const op = ins.op;
    const acc = op.access;

    // ---- line breakpoint site -----------------------------------------------------------
    let sitePost: (() => void) | null = null;
    const site = siteMap?.get(ins.pos - start);
    if (site && baseLocal >= 0) {
      const valCode = VT_BYTE[op.name.slice(0, 3)] ?? 0;
      const simple = !!acc && ins.memIdx === 0 && op.imm === "memarg" && valCode !== 0;
      const isStore = simple && acc!.store && /\.store|\.rmw\./.test(op.name) && !/cmpxchg/.test(op.name);
      const isLoad = simple && acc!.load && !acc!.store;
      const f: BpFound = { id: site.id, func: funcIdx, off: ins.pos - start, name: op.name, kind: isStore ? "store" : isLoad ? "load" : "generic", size: acc?.size ?? 0, valType: isStore || isLoad ? valCode : 0, offset: acc ? ins.offset : 0, localCodes: getLocalCodes().slice(0, 24) };
      ctx.found[site.id] = f;
      const hook = (addrLocal: number, valLocal: number) => {
        cw.u8(0x23).u32(site.flagIdx).u8(0x04).u8(0x40); // global.get flag; if
        cw.u8(0x41).s32(site.id); // id
        cw.u8(0x20).u32(addrLocal).u8(0x41).s32(ins.offset | 0).u8(0x6a); // ea = addr + offset
        cw.u8(0x20).u32(valLocal); emitToBits(cw, valCode); // value bits
        cw.u8(0x10).u32(ctx.bpImport);
        snapshot(site.id);
        cw.u8(0x0b);
      };
      if (f.kind === "store") {
        const a = scratch("a", 0x7f), v = scratch("v" + valCode, valCode);
        cw.u8(0x21).u32(v).u8(0x21).u32(a); // local.set value; local.set addr
        hook(a, v);
        cw.u8(0x20).u32(a).u8(0x20).u32(v); // restore the operands
      } else if (f.kind === "load") {
        const a = scratch("a", 0x7f), v = scratch("v" + valCode, valCode);
        cw.u8(0x22).u32(a); // local.tee addr (kept on the stack for the load)
        sitePost = () => { cw.u8(0x22).u32(v); hook(a, v); }; // after the load: tee value, report
      } else {
        cw.u8(0x23).u32(site.flagIdx).u8(0x04).u8(0x40);
        cw.u8(0x41).s32(site.id).u8(0x41).s32(0).u8(0x42).s64(0n).u8(0x10).u32(ctx.bpImport);
        snapshot(site.id);
        cw.u8(0x0b);
      }
    }

    if (op.name === "call" || op.name === "return_call" || op.name === "ref.func") {
      cw.u8(op.code).u32(shift(ins.a));
      sitePost?.();
      continue;
    }
    const spill = ctx.read && baseLocal >= 0 && ins.memIdx === 0 ? readOperands(op.name, op.imm, acc) : null;
    if (spill && acc) {
      const sc = scratch("rd", 0x7f);
      const sp = spill.map((t, i) => scratch(`sp${i}_${t}`, t));
      for (let i = sp.length - 1; i >= 0; i--) cw.u8(0x21).u32(sp[i]!); // park the operands above the address
      cw.u8(0x22).u32(sc); // local.tee scratch (address stays on the stack for the load)
      if (ctx.shared) cw.u8(0x41).s32(ctx.shared.ctrl + CTRL.REN).u8(0x28).u32(2).u32(0).u8(0x04).u8(0x40); // ren from memory; if
      else cw.u8(0x23).u32(ctx.renIdx).u8(0x04).u8(0x40); // global.get ren; if
      cw.u8(0x20).u32(sc); // local.get scratch
      cw.u8(0x41).s32(ins.offset | 0); // i32.const offset
      cw.u8(0x41).s32(acc.size); // i32.const size
      if (ctx.shared?.ring) cw.u8(0x41).s32(funcIdx).u8(0x41).s32(ins.pos - start); // where we are
      cw.u8(0x10).u32(ctx.rcheckIdx); // call rcheck
      cw.u8(0x0b);
      for (let i = 0; i < sp.length; i++) cw.u8(0x20).u32(sp[i]!); // put the operands back
    }
    cw.raw(src.subarray(ins.pos, ins.end));
    if (ctx.write) {
      let isWrite = false;
      if (acc && acc.store && ins.memIdx === 0) isWrite = true;
      else if (op.bulkWrite) {
        const memIdx = op.name === "memory.init" ? ins.b : ins.a;
        isWrite = memIdx === 0;
      }
      if (isWrite) {
        if (ctx.shared) cw.u8(0x41).s32(ctx.shared.ctrl + CTRL.WEN).u8(0x28).u32(2).u32(0).u8(0x04).u8(0x40); // wen from memory; if
        else cw.u8(0x23).u32(ctx.wenIdx).u8(0x04).u8(0x40); // global.get wen; if
        if (ctx.shared?.ring) cw.u8(0x41).s32(funcIdx).u8(0x41).s32(ins.pos - start);
        cw.u8(0x10).u32(ctx.wcheckIdx); // call wcheck
        cw.u8(0x0b);
      }
    }
    sitePost?.();
  }

  const bw = new Writer(cw.length + 32);
  const headerStart = bw.length;
  bw.u32(h.localEntries.length + extra.length);
  for (const e of h.localEntries) bw.raw(e);
  for (const t of extra) bw.u32(1).u8(t);
  const headerLen = bw.length - headerStart;
  if (rec) {
    // convert recorded new offsets (relative to code start) to be relative to body start
    for (let i = 0; i < rec.length; i += 2) rec[i] = rec[i]! + headerLen;
  }
  bw.raw(cw.view());
  return bw.result();
}

// ---------------------------------------------------------------------------
// Module rewriting
// ---------------------------------------------------------------------------
function typeBytes(): Uint8Array[] {
  return [
    Uint8Array.of(0x60, 2, 0x7f, 0x7f, 0), // hit/fhit: (i32,i32)->()
    Uint8Array.of(0x60, 0, 0), // ()->()
    Uint8Array.of(0x60, 5, 0x7f, 0x7f, 0x7f, 0x7e, 0x7f, 1, 0x7e), // wslot
    Uint8Array.of(0x60, 3, 0x7f, 0x7f, 0x7f, 0), // rcheck
    Uint8Array.of(0x60, 1, 0x7f, 0), // fcheck
    Uint8Array.of(0x60, 3, 0x7f, 0x7f, 0x7e, 0), // bp / bpl: (id, ea|index, value bits) -> ()
    Uint8Array.of(0x60, 5, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0), // rcheckF: (ea, offset, size, func, off) -> ()
    Uint8Array.of(0x60, 5, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0), // record: (kind, slot, ea, func, off) -> ()
    Uint8Array.of(0x60, 7, 0x7f, 0x7f, 0x7f, 0x7e, 0x7f, 0x7f, 0x7f, 1, 0x7e), // wslotF
  ];
}

function nameSet(slots: number, funcSlots: number): GlobalNames {
  const g: GlobalNames = { addr: [], size: [], flags: [], val: [], fbp: [] };
  for (let i = 0; i < slots; i++) {
    g.addr.push(`__c_wa${i}`);
    g.size.push(`__c_ws${i}`);
    g.flags.push(`__c_wf${i}`);
    g.val.push(`__c_wv${i}`);
  }
  for (let i = 0; i < funcSlots; i++) g.fbp.push(`__c_fb${i}`);
  return g;
}

/** Why a control block cannot live at `ctrl` in this module (null = it can). */
export function sharedUnsupported(m: ModuleModel, ctrl: number): string | null {
  const mem = m.memories[0];
  if (!mem) return "module has no memory";
  if (!mem.limits.shared) return "memory is not shared";
  if (mem.limits.memory64) return "memory64";
  if (!Number.isInteger(ctrl) || ctrl < 8 || (ctrl & 7) !== 0) return "control block address must be 8-byte aligned";
  if (ctrl + CTRL.SIZE > mem.limits.min * 65536) return "memory is too small for the control block";
  for (const d of m.data) {
    if (d.mode !== "active" || d.memIdx !== 0) continue;
    if (d.offset === null) return "a data segment has a non-constant offset, cannot prove the control block is free";
    if (d.offset < ctrl + CTRL.SIZE && d.offset + d.size > ctrl) return `a data segment overlaps ${hex(ctrl)}..${hex(ctrl + CTRL.SIZE)}`;
  }
  return null;
}
const hex = (n: number): string => "0x" + n.toString(16);

export function rewriteModule(m: ModuleModel, opts: RewriteOptions = {}): RewriteResult {
  const warnings: string[] = [];
  const bytes = m.bytes;
  const cfg = opts.instrument ?? null;
  const patches = new Map<number, FunctionPatch>();
  for (const p of opts.patches ?? []) patches.set(p.index, p);

  let doWrite = !!cfg && cfg.write && cfg.slots > 0;
  let doRead = !!cfg && cfg.read && cfg.slots > 0;
  let doFunc = !!cfg && cfg.funcHooks;
  if (m.memories.length && m.memories[0]!.limits.memory64) {
    if (doWrite || doRead) warnings.push("memory64 modules are not supported by watchpoints; memory hooks disabled");
    doWrite = false;
    doRead = false;
  }
  if (m.memories.length === 0 && (doWrite || doRead)) {
    doWrite = false;
    doRead = false;
  }
  // ---- watch table in shared linear memory? (threaded builds) ----------------------------------------
  let shared: { ctrl: number; ring: boolean } | null = null;
  if (opts.shared && (doWrite || doRead)) {
    const why = sharedUnsupported(m, opts.shared.ctrl);
    if (why) warnings.push(`shared-memory watchpoints disabled: ${why}`);
    else shared = { ctrl: opts.shared.ctrl, ring: !!opts.shared.ring };
  }
  if (shared?.ring) {
    // worker-safe build: must not import anything, so no function hooks / line breakpoints
    doFunc = false;
  }
  const ring = !!shared?.ring;
  const slots = doWrite || doRead ? Math.min(shared ? CTRL.MAX_SLOTS : 16, cfg!.slots) : 0;
  const funcSlots = doFunc ? Math.min(16, cfg!.funcSlots) : 0;
  // line breakpoints on patched functions would refer to patched code: only original bodies are supported
  const bpReq = ring ? [] : (opts.bps ?? []).filter((b) => b.func >= m.numImportedFuncs && b.func - m.numImportedFuncs < m.bodies.length && !patches.has(b.func));
  const hasBps = bpReq.length > 0;
  const active = doWrite || doRead || doFunc || hasBps;
  const K = active && !ring ? (hasBps ? 4 : 2) : 0;
  const N0 = m.numImportedFuncs;
  const shift = shiftFn({ N0, K });

  // Does memory 0 need to be exported so Cetus can reach it?
  const memExported = m.exports.some((e) => e.kind === 2 && e.index === 0);
  const needMemExport = m.memories.length > 0 && !m.memories[0]!.imported && !memExported;
  if (m.warnings.length) warnings.push(...m.warnings);

  const nothingToDo = !active && patches.size === 0 && !needMemExport;
  const emptyNames: GlobalNames = nameSet(0, 0);
  if (nothingToDo) {
    return {
      bytes, instrumented: false, features: { write: false, read: false, funcHooks: false, slots: 0, funcSlots: 0 }, shared: null,
      K: 0, N0, helperStart: Infinity, newBodyStart: new Uint32Array(0), memoryExport: null, globals: emptyNames,
      patched: [], warnings, ctxIdx: { wen: 0, ren: 0, fen: 0, wcheck: 0, rcheck: 0, fcheck: 0 },
      bp: { found: [], sitesByFunc: new Map(), flagNames: [], reqs: [] },
    };
  }

  // --- layout of everything we add -----------------------------------------
  const types = typeBytes();
  const T0 = m.types.length;
  const G0 = m.globals.length; // new global indexes start here
  const gnames = nameSet(slots, funcSlots);
  const gidx: GlobalNamesIdx & { fbp: number[]; wen: number; ren: number; fen: number } = {
    addr: [], size: [], flags: [], val: [], fbp: [], wen: -1, ren: -1, fen: -1,
  };
  const newGlobals: { type: number; init: number }[] = []; // type 0x7f / 0x7e ; init const
  const addGlobal = (type: number, init: number): number => {
    newGlobals.push({ type, init });
    return G0 + newGlobals.length - 1;
  };
  const globalExports: { name: string; idx: number }[] = [];
  const exportGlobal = (name: string, idx: number) => globalExports.push({ name, idx });

  if (doWrite && !shared) {
    gidx.wen = addGlobal(0x7f, 0);
    exportGlobal("__c_wen", gidx.wen);
  }
  if (doRead && !shared) {
    gidx.ren = addGlobal(0x7f, 0);
    exportGlobal("__c_ren", gidx.ren);
  }
  if (doFunc) {
    gidx.fen = addGlobal(0x7f, 0);
    exportGlobal("__c_fen", gidx.fen);
  }
  for (let s = 0; s < (shared ? 0 : slots); s++) {
    gidx.addr.push(addGlobal(0x7f, 0));
    gidx.size.push(addGlobal(0x7f, 0));
    gidx.flags.push(addGlobal(0x7f, 0));
    gidx.val.push(addGlobal(0x7e, 0));
    exportGlobal(gnames.addr[s]!, gidx.addr[s]!);
    exportGlobal(gnames.size[s]!, gidx.size[s]!);
    exportGlobal(gnames.flags[s]!, gidx.flags[s]!);
    exportGlobal(gnames.val[s]!, gidx.val[s]!);
  }
  for (let f = 0; f < funcSlots; f++) {
    gidx.fbp.push(addGlobal(0x7f, -1));
    exportGlobal(gnames.fbp[f]!, gidx.fbp[f]!);
  }
  // expose every i32 global (mutable or not) so the pointer scanner can use global singletons as chain roots
  const exportedGlobalIdx = new Set(m.exports.filter((e) => e.kind === 3).map((e) => e.index));
  let nGlobalRoots = 0;
  for (let gi = 0; gi < m.globals.length && nGlobalRoots < 4096; gi++) {
    const g = m.globals[gi]!;
    if (g.valType !== "i32" || exportedGlobalIdx.has(gi)) continue;
    exportGlobal(`__c_g${gi}`, gi);
    nGlobalRoots++;
  }
  // one exported on/off flag per line breakpoint
  const sitesByFunc = new Map<number, Map<number, { id: number; flagIdx: number }>>();
  const flagNames: string[] = [];
  bpReq.forEach((b, id) => {
    const flagIdx = addGlobal(0x7f, b.enabled ? 1 : 0);
    const name = `__c_bpf${id}`;
    exportGlobal(name, flagIdx);
    flagNames.push(name);
    let mm = sitesByFunc.get(b.func);
    if (!mm) sitesByFunc.set(b.func, (mm = new Map()));
    mm.set(b.off, { id, flagIdx });
  });
  const found: (BpFound | null)[] = bpReq.map(() => null);
  const gn: GlobalNames = { ...gnames };
  if (doWrite && !shared) gn.wen = "__c_wen";
  else delete gn.wen;
  if (doRead && !shared) gn.ren = "__c_ren";
  else delete gn.ren;
  if (shared) { gn.addr = []; gn.size = []; gn.flags = []; gn.val = []; }
  if (doFunc) gn.fen = "__c_fen";
  else delete gn.fen;

  // helper functions are appended after all original defined functions
  const origDefined = m.bodies.length;
  const helperBase = N0 + K + origDefined;
  const helpers: { type: number; body: Uint8Array; name: string }[] = [];
  let wslotIdx = -1, wcheckIdx = -1, rcheckIdx = -1, fcheckIdx = -1;
  let HIT = N0; // __cetus.hit (import mode) or the local ring recorder (worker-safe mode)
  const FHIT = N0 + 1; // __cetus.fhit
  if (ring && (doWrite || doRead)) {
    HIT = helperBase + helpers.length;
    helpers.push({ type: T0 + T.record, body: genRecord(shared!.ctrl), name: "__cetus_record" });
  }
  if (doWrite) {
    wslotIdx = helperBase + helpers.length;
    helpers.push({ type: T0 + (ring ? T.wslotF : T.wslot), body: genWslot(HIT, ring), name: "__cetus_wslot" });
    wcheckIdx = helperBase + helpers.length;
    helpers.push(shared
      ? { type: T0 + (ring ? T.hit : T.void), body: genWcheckMem(shared.ctrl, wslotIdx, slots, ring), name: "__cetus_wcheck" }
      : { type: T0 + T.void, body: genWcheck(gidx, wslotIdx, slots), name: "__cetus_wcheck" });
  }
  if (doRead) {
    rcheckIdx = helperBase + helpers.length;
    helpers.push(shared
      ? { type: T0 + (ring ? T.rcheckF : T.rcheck), body: genRcheckMem(shared.ctrl, HIT, slots, ring), name: "__cetus_rcheck" }
      : { type: T0 + T.rcheck, body: genRcheck(gidx, HIT, slots), name: "__cetus_rcheck" });
  }
  if (doFunc) {
    fcheckIdx = helperBase + helpers.length;
    helpers.push({ type: T0 + T.fcheck, body: genFcheck(gidx.fen, gidx.fbp, FHIT), name: "__cetus_fcheck" });
  }

  const ctx: BodyCtx = {
    m, N0, K, write: doWrite, read: doRead, funcHooks: doFunc,
    wenIdx: gidx.wen, renIdx: gidx.ren, fenIdx: gidx.fen, wcheckIdx, rcheckIdx, fcheckIdx,
    sites: sitesByFunc, found, bpImport: N0 + 2, bplImport: N0 + 3, shared,
  };

  // --- rewrite sections ----------------------------------------------------
  const outs: Out[] = m.sections.map((sec) => ({ id: sec.id, payload: null, sec }));
  const find = (id: number) => outs.find((o) => o.id === id);
  const insertNew = (id: number, payload: Uint8Array) => {
    const rank = RANK[id]!;
    let pos = outs.findIndex((o) => o.id !== 0 && (RANK[o.id] ?? 99) > rank);
    if (pos < 0) pos = outs.length;
    outs.splice(pos, 0, { id, payload });
  };
  const rest = (sec: Section) => {
    const r = new Reader(bytes, sec.payloadStart, sec.end);
    const count = r.u32();
    return { count, restStart: r.pos };
  };

  if (active) {
    // types
    const typeSec = find(SEC.type);
    const tw = new Writer(256);
    if (typeSec) {
      const { count, restStart } = rest(typeSec.sec!);
      tw.u32(count + types.length);
      tw.raw(bytes.subarray(restStart, typeSec.sec!.end));
    } else tw.u32(types.length);
    for (const t of types) tw.raw(t);
    if (typeSec) typeSec.payload = tw.result();
    else insertNew(SEC.type, tw.result());

    // imports
    const impSec = find(SEC.import);
    const iw = new Writer(256);
    const newImports = K === 0 ? [] : [
      { field: "hit", type: T0 + T.hit },
      { field: "fhit", type: T0 + T.hit },
      ...(hasBps ? [{ field: "bp", type: T0 + T.bp }, { field: "bpl", type: T0 + T.bp }] : []),
    ];
    if (newImports.length) {
      if (impSec) {
        const { count, restStart } = rest(impSec.sec!);
        iw.u32(count + newImports.length);
        iw.raw(bytes.subarray(restStart, impSec.sec!.end));
      } else iw.u32(newImports.length);
      for (const ni of newImports) {
        iw.name(IMPORT_MODULE).name(ni.field).u8(0).u32(ni.type);
      }
      if (impSec) impSec.payload = iw.result();
      else insertNew(SEC.import, iw.result());
    }

    // function section (helpers)
    if (helpers.length) {
      const fSec = find(SEC.function);
      const fw = new Writer(256);
      if (fSec) {
        const { count, restStart } = rest(fSec.sec!);
        fw.u32(count + helpers.length);
        fw.raw(bytes.subarray(restStart, fSec.sec!.end));
      } else fw.u32(helpers.length);
      for (const h of helpers) fw.u32(h.type);
      if (fSec) fSec.payload = fw.result();
      else insertNew(SEC.function, fw.result());
    }

    // globals (remap existing ref.func inits + append ours)
    const gSec = find(SEC.global);
    const gw = new Writer(256);
    if (gSec) {
      const r = new Reader(bytes, gSec.sec!.payloadStart, gSec.sec!.end);
      const count = r.u32();
      gw.u32(count + newGlobals.length);
      for (let i = 0; i < count; i++) {
        const a = r.pos;
        const vt = r.u8();
        if (vt === 0x63 || vt === 0x64) r.s33();
        r.u8();
        gw.raw(bytes.subarray(a, r.pos));
        remapExpr(r, gw, shift);
      }
    } else gw.u32(newGlobals.length);
    for (const g of newGlobals) {
      gw.u8(g.type).u8(1);
      if (g.type === 0x7f) gw.u8(0x41).s32(g.init);
      else gw.u8(0x42).s64(BigInt(g.init));
      gw.u8(0x0b);
    }
    if (gSec) gSec.payload = gw.result();
    else if (newGlobals.length) insertNew(SEC.global, gw.result());

    // start
    const stSec = find(SEC.start);
    if (stSec) {
      const r = new Reader(bytes, stSec.sec!.payloadStart, stSec.sec!.end);
      stSec.payload = new Writer(8).u32(shift(r.u32())).result();
    }

    // elements
    const elSec = find(SEC.element);
    if (elSec) elSec.payload = remapElementSection(bytes, elSec.sec!, shift);

    // tables with initializer expressions
    if (find(SEC.table)) {
      const tSec = find(SEC.table)!.sec!;
      const r = new Reader(bytes, tSec.payloadStart, tSec.end);
      const n = r.u32();
      for (let i = 0; i < n; i++) {
        if (r.peek() === 0x40) throw new Error("tables with initializer expressions are not supported");
        const vt = r.u8();
        if (vt === 0x63 || vt === 0x64) r.s33();
        const flags = r.u8();
        r.u32();
        if (flags & 1) r.u32();
      }
    }

    // name section
    for (const o of outs) {
      if (o.id === SEC.custom && o.sec?.name === "name") o.payload = remapNameSection(bytes, o.sec, shift);
    }
  }

  // exports (shift function exports, append ours)
  const exSec = find(SEC.export);
  const memoryExport = needMemExport ? "__c_mem" : null;
  if (K > 0 || memoryExport || globalExports.length) { // (exports only need rewriting when indices shift or we add some)
    const ew = new Writer(256);
    const added = globalExports.length + (memoryExport ? 1 : 0);
    if (exSec) {
      const r = new Reader(bytes, exSec.sec!.payloadStart, exSec.sec!.end);
      const count = r.u32();
      ew.u32(count + added);
      for (let i = 0; i < count; i++) {
        const name = r.name();
        const kind = r.u8();
        const idx = r.u32();
        ew.name(name).u8(kind).u32(kind === 0 ? shift(idx) : idx);
      }
    } else ew.u32(added);
    for (const ge of globalExports) ew.name(ge.name).u8(3).u32(ge.idx);
    if (memoryExport) ew.name(memoryExport).u8(2).u32(0);
    if (exSec) exSec.payload = ew.result();
    else insertNew(SEC.export, ew.result());
  }

  // code
  const codeSec = find(SEC.code);
  const relStarts = new Uint32Array(origDefined);
  const patched: number[] = [];
  if (codeSec) {
    const cw = new Writer(bytes.length + 1024);
    cw.u32(origDefined + helpers.length);
    for (let i = 0; i < origDefined; i++) {
      const funcIdx = N0 + i;
      const body = m.bodies[i]!;
      let src = bytes;
      let s = body.start;
      let e = body.end;
      const p = patches.get(funcIdx);
      if (p) {
        const h = parseBodyHeader(bytes, body.start, body.end);
        const locals = p.locals ?? bytes.subarray(body.start, h.codeStart);
        const pw = new Writer(p.code.length + locals.length + 4);
        pw.raw(locals);
        pw.raw(p.code);
        src = pw.result();
        s = 0;
        e = src.length;
        patched.push(funcIdx);
      }
      let out: Uint8Array;
      if (active) out = rewriteBody(src, s, e, funcIdx, ctx);
      else out = src.subarray(s, e);
      cw.u32(out.length);
      relStarts[i] = cw.length;
      cw.raw(out);
    }
    for (const h of helpers) {
      cw.u32(h.body.length);
      cw.raw(h.body);
    }
    codeSec.payload = cw.result();
    codeSec.isCode = true;
  } else if (patches.size) {
    throw new Error("module has no code section to patch");
  }

  // --- assemble final module ----------------------------------------------
  const total = bytes.length + 4096;
  const fw = new Writer(total + (codeSec?.payload?.length ?? 0));
  fw.raw(bytes.subarray(0, 8));
  let codePayloadStart = 0;
  for (const o of outs) {
    if (o.payload === null && o.sec) {
      fw.raw(bytes.subarray(o.sec.start, o.sec.end));
      continue;
    }
    fw.u8(o.id);
    fw.u32(o.payload!.length);
    if (o.isCode) codePayloadStart = fw.length;
    fw.raw(o.payload!);
  }
  const newBodyStart = new Uint32Array(origDefined);
  for (let i = 0; i < origDefined; i++) newBodyStart[i] = codePayloadStart + relStarts[i]!;

  return {
    bytes: fw.result(),
    instrumented: active,
    features: { write: doWrite, read: doRead, funcHooks: doFunc, slots, funcSlots },
    shared,
    K, N0,
    helperStart: helpers.length ? helperBase : Infinity,
    newBodyStart,
    memoryExport,
    globals: gn,
    patched,
    warnings,
    ctxIdx: { wen: gidx.wen, ren: gidx.ren, fen: gidx.fen, wcheck: wcheckIdx, rcheck: rcheckIdx, fcheck: fcheckIdx },
    bp: { found, sitesByFunc, flagNames, reqs: bpReq },
  };
}

/**
 * Re-instrument a single function and return the map [newOff, origOff, ...]
 * (offsets relative to body start) so stack-trace offsets can be mapped back.
 */
export function mapFunctionOffsets(m: ModuleModel, funcIdx: number, rr: RewriteResult, cfg: InstrumentConfig): number[] {
  const i = funcIdx - m.numImportedFuncs;
  const body = m.bodies[i];
  if (!body) return [];
  const f = rr.features;
  const ctx: BodyCtx = {
    m, N0: rr.N0, K: rr.K, write: f.write, read: f.read, funcHooks: f.funcHooks,
    wenIdx: rr.ctxIdx.wen, renIdx: rr.ctxIdx.ren, fenIdx: rr.ctxIdx.fen,
    wcheckIdx: rr.ctxIdx.wcheck, rcheckIdx: rr.ctxIdx.rcheck, fcheckIdx: rr.ctxIdx.fcheck,
    sites: rr.bp.sitesByFunc, found: [], bpImport: rr.N0 + 2, bplImport: rr.N0 + 3, shared: rr.shared,
  };
  void cfg;
  const rec: number[] = [];
  rewriteBody(m.bytes, body.start, body.end, funcIdx, ctx, rec);
  return rec;
}
