/**
 * WASM function body -> IR.
 *
 * The builder simulates the operand stack. Expressions stay lazy (kept as trees on the simulated stack) until an
 * effectful instruction would reorder them, at which point they are *spilled* to temporaries in their original order:
 * the resulting program evaluates everything in the same order as the stack machine. Wasm control flow is already
 * structured, so the structured tree is built directly and the basic blocks / edges are recorded alongside.
 */
import { Reader } from "../wasm/leb";
import { decode, newIns, parseBodyHeader, Ins } from "../wasm/decode";
import { ModuleModel, funcDisplayName } from "../wasm/module";
import {
  Expr, Node, Stmt, Var, WType, FuncIR, BasicBlock, Edge, LabelRef, LabelInfo, CalleeInfo, mapExpr, walkNodes, stmtExprs,
} from "./ir";

const VT: Record<number, WType> = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64", 0x7b: "v128", 0x70: "funcref", 0x6f: "externref" };
/** blocktype s33 values for the single-result forms */
const BT: Record<number, WType> = { [-1]: "i32", [-2]: "i64", [-3]: "f32", [-4]: "f64", [-5]: "v128", [-16]: "funcref", [-17]: "externref" };

const CMP = new Set(["eq", "ne", "lt_s", "lt_u", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u", "lt", "gt", "le", "ge"]);
const BIN = new Set(["add", "sub", "mul", "div_s", "div_u", "div", "rem_s", "rem_u", "and", "or", "xor", "shl", "shr_s", "shr_u", "rotl", "rotr", "min", "max", "copysign"]);
const UN = new Set(["clz", "ctz", "popcnt", "abs", "neg", "sqrt", "ceil", "floor", "trunc", "nearest", "extend8_s", "extend16_s", "extend32_s"]);

export type OpKind = "cmp" | "eqz" | "bin" | "un" | "cvt";
/** number of operands, result type and class of a plain numeric instruction (null: not one) */
export function numSig(name: string): { pops: 1 | 2; ty: WType; kind: OpKind } | null {
  const m = /^(i32|i64|f32|f64)\.(.+)$/.exec(name);
  if (!m) return null;
  const t = m[1]!, op = m[2]!;
  if (CMP.has(op)) return { pops: 2, ty: "i32", kind: "cmp" };
  if (op === "eqz") return { pops: 1, ty: "i32", kind: "eqz" };
  if (BIN.has(op)) return { pops: 2, ty: t, kind: "bin" };
  if (UN.has(op)) return { pops: 1, ty: t, kind: "un" };
  if (/^(wrap_|extend_|trunc_|convert_|demote_|promote_|reinterpret_)/.test(op)) return { pops: 1, ty: t, kind: "cvt" };
  return null;
}

const SIMD_PREFIX = /^(v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./;
const LANE_TY: Record<string, WType> = { i8x16: "i32", i16x8: "i32", i32x4: "i32", i64x2: "i64", f32x4: "f32", f64x2: "f64" };

/** stack effect of SIMD / atomic / bulk-memory / reference instructions that have no C-like form */
export function otherSig(name: string): { pops: number; ty: WType | null; effect: boolean } | null {
  const sm = SIMD_PREFIX.exec(name);
  if (sm) {
    const op = name.slice(sm[0].length);
    const lane = LANE_TY[sm[1]!];
    if (name === "v128.const") return { pops: 0, ty: "v128", effect: false };
    if (/^v128\.store/.test(name)) return { pops: 2, ty: null, effect: true };
    if (/^v128\.load/.test(name)) return { pops: /_lane$/.test(name) ? 2 : 1, ty: "v128", effect: false };
    if (/^extract_lane/.test(op)) return { pops: 1, ty: lane ?? "i32", effect: false };
    if (/^replace_lane/.test(op)) return { pops: 2, ty: "v128", effect: false };
    if (op === "all_true" || op === "any_true" || op === "bitmask") return { pops: 1, ty: "i32", effect: false };
    if (name === "v128.bitselect") return { pops: 3, ty: "v128", effect: false };
    if (name === "v128.any_true") return { pops: 1, ty: "i32", effect: false };
    if (op === "splat" || op === "not" || /^(abs|neg|popcnt|sqrt|ceil|floor|trunc|nearest|extend_|convert_|trunc_sat|demote|promote|extadd|relaxed_trunc)/.test(op)) return { pops: 1, ty: "v128", effect: false };
    return { pops: 2, ty: "v128", effect: false }; // binary / compare / shift / shuffle / swizzle
  }
  if (name === "memory.atomic.notify") return { pops: 2, ty: "i32", effect: true };
  if (/^memory\.atomic\.wait/.test(name)) return { pops: 3, ty: "i32", effect: true };
  if (name === "atomic.fence") return { pops: 0, ty: null, effect: true };
  switch (name) {
    case "memory.fill": case "memory.copy": case "memory.init": return { pops: 3, ty: null, effect: true };
    case "data.drop": case "elem.drop": return { pops: 0, ty: null, effect: true };
    case "ref.null": case "ref.func": case "table.size": return { pops: 0, ty: name === "table.size" ? "i32" : name === "ref.func" ? "funcref" : "externref", effect: false };
    case "ref.is_null": return { pops: 1, ty: "i32", effect: false };
    case "table.get": return { pops: 1, ty: "funcref", effect: false };
    case "table.set": return { pops: 2, ty: null, effect: true };
    case "table.grow": return { pops: 2, ty: "i32", effect: true };
    case "table.fill": case "table.copy": case "table.init": return { pops: 3, ty: null, effect: true };
  }
  return null;
}

class Unsupported extends Error {}

interface Ctl {
  kind: "func" | "block" | "loop" | "if";
  label: number;
  node: Node | null;
  /** stack height right after the construct's params were popped */
  base: number;
  results: Var[];
  params: Var[];
  resultTypes: WType[];
  paramTypes: WType[];
  exitBB: BasicBlock | null;
  headBB: BasicBlock | null;
  /** the `false` edge of an `if` header that still has to be pointed at the else / join block */
  falseEdge: Edge | null;
  thenLive: boolean;
  inElse: boolean;
  parentBody: Node[];
}

export interface BuildOptions {
  /** name shown for a function (names from the module + user annotations may be layered on top by the caller) */
  funcName?: (idx: number) => string;
  /** the NUL-terminated printable string at a linear-memory address, if there is one */
  cstring?: (addr: number) => string | undefined;
  /** upper bound on instructions (defence against pathological bodies) */
  maxInstructions?: number;
}

export function buildIR(m: ModuleModel, funcIdx: number, opts: BuildOptions = {}): FuncIR {
  const bi = funcIdx - m.numImportedFuncs;
  if (bi < 0 || bi >= m.bodies.length) throw new RangeError(`function ${funcIdx} has no body`);
  const body = m.bodies[bi]!;
  const ft = m.types[m.funcTypeIdx[funcIdx]!];
  const nameOf = opts.funcName ?? ((i: number) => funcDisplayName(m, i));
  const sig = { params: (ft?.params ?? []) as WType[], results: (ft?.results ?? []) as WType[] };

  const ir: FuncIR = {
    version: 1, index: funcIdx, name: nameOf(funcIdx), params: sig.params, results: sig.results,
    vars: [], tree: [], blocks: [], callees: [], strings: {}, labels: {}, warnings: [], bodySize: body.end - body.start,
  };

  // ---- variables
  const varMap = new Map<string, Var>();
  const addVar = (id: string, kind: Var["kind"], ty: WType, index?: number): Var => {
    const v: Var = { id, kind, ty, hints: [], defs: 0, uses: 0, ...(index !== undefined ? { index } : {}) };
    varMap.set(id, v); ir.vars.push(v);
    return v;
  };
  sig.params.forEach((t, i) => addVar(`p${i}`, "param", t, i));
  const hdr = parseBodyHeader(m.bytes, body.start, body.end);
  const localTypes: WType[] = [];
  hdr.localEntries.forEach((e, i) => { const lr = new Reader(e); lr.u32(); const t = VT[lr.u8()] ?? "i32"; for (let k = 0; k < hdr.localCounts[i]!; k++) localTypes.push(t); });
  localTypes.forEach((t, i) => addVar(`l${sig.params.length + i}`, "local", t, sig.params.length + i));
  const localVar = (i: number): Var => varMap.get(i < sig.params.length ? `p${i}` : `l${i}`) ?? addVar(`l${i}`, "local", "i32", i);
  let tempN = 0, resN = 0;
  const newTemp = (ty: WType): Var => addVar(`t${++tempN}`, "temp", ty);
  const newResult = (ty: WType): Var => addVar(`r${++resN}`, "result", ty);

  // ---- which locals are ever written: reads of the others are stable and never need to be spilled
  const assigned = new Set<number>();
  try {
    const r = new Reader(m.bytes, hdr.codeStart, body.end);
    const ins = newIns();
    while (!r.eof) { decode(r, ins); if (ins.op.name === "local.set" || ins.op.name === "local.tee") assigned.add(ins.a); }
  } catch { /* the main pass reports it */ }

  // ---- basic blocks
  const bbs: BasicBlock[] = [];
  const newBB = (start: number): BasicBlock => { const b: BasicBlock = { id: bbs.length, start, end: start, edges: [], term: "fall" }; bbs.push(b); return b; };
  let cur = newBB(0);
  const link = (from: BasicBlock, to: BasicBlock, kind: Edge["kind"]): Edge => { const e: Edge = { to: to.id, kind }; from.edges.push(e); return e; };

  // ---- structure
  let labelN = 0;
  const funcCtl: Ctl = {
    kind: "func", label: 0, node: null, base: 0, results: [], params: [], resultTypes: sig.results, paramTypes: [],
    exitBB: null, headBB: null, falseEdge: null, thenLive: true, inElse: false, parentBody: [],
  };
  ir.labels[0] = { kind: "func", off: 0, refs: 0 };
  const ctls: Ctl[] = [funcCtl];
  let list: Node[] = ir.tree;
  const stack: Expr[] = [];
  let dead = false, deadNest = 0;

  const short = (e: Expr): string => (e.k === "const" ? e.v : e.k === "var" ? e.id : e.k === "global" ? `g${e.idx}` : e.k === "load" || e.k === "bin" || e.k === "un" ? e.op : e.k === "call" ? `call ${e.func}` : e.k);
  const emit = <T extends Node>(n: T): T => {
    (n as { bb: number }).bb = cur.id;
    // operand stack right after this statement (INFERRED snapshot for the IR view; lazily-built expressions are shown by their root operator)
    if (n.k !== "block" && n.k !== "loop" && n.k !== "if") (n as { stk?: string[] }).stk = stack.slice(-8).map(short);
    list.push(n);
    return n;
  };

  // ---- effect analysis on lazy expressions
  const hasCall = (e: Expr): boolean => { let r = false; mapExpr(e, (x) => { if (x.k === "call" || x.k === "calli" || (x.k === "opaque" && !/^(v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./.test(x.name) && !/^(ref|table\.(get|size))/.test(x.name))) r = true; }); return r; };
  const readsMem = (e: Expr): boolean => { let r = false; mapExpr(e, (x) => { if (x.k === "load" || (x.k === "opaque" && /(^|\.)(load|atomic|memory)/.test(x.name))) r = true; }); return r; };
  const readsGlobal = (e: Expr, idx?: number): boolean => { let r = false; mapExpr(e, (x) => { if (x.k === "global" && (idx === undefined || x.idx === idx) && m.globals[x.idx]?.mutable !== false) r = true; }); return r; };
  const readsLocal = (e: Expr, id: string): boolean => { let r = false; mapExpr(e, (x) => { if (x.k === "var" && x.id === id) r = true; }); return r; };
  const isStable = (e: Expr): boolean => {
    if (e.k === "const") return true;
    if (e.k === "var") { const v = varMap.get(e.id)!; return v.kind === "temp" || v.kind === "result" || !assigned.has(v.index!); }
    if (e.k === "global") return m.globals[e.idx]?.mutable === false;
    return false;
  };

  const spillIf = (pred: (e: Expr) => boolean): void => {
    for (let i = 0; i < stack.length; i++) {
      const e = stack[i]!;
      if (e.k === "var" && varMap.get(e.id)!.kind !== "local" && varMap.get(e.id)!.kind !== "param") continue;
      if (isStable(e) || !pred(e)) continue;
      const t = newTemp(e.k === "call" || e.k === "calli" ? (e.ty ?? "i32") : tyOf(e));
      emit({ k: "assign", dst: t.id, src: e, off: e.off, bb: cur.id } as Stmt);
      stack[i] = { k: "var", id: t.id, ty: t.ty, off: e.off };
    }
  };
  const spillAll = (): void => spillIf(() => true);
  const spillEffectful = (): void => spillIf((e) => hasCall(e) || readsMem(e) || readsGlobal(e));

  function tyOf(e: Expr): WType {
    switch (e.k) {
      case "call": case "calli": case "opaque": return e.ty ?? "i32";
      default: return e.ty;
    }
  }

  const pop = (): Expr => {
    const e = stack.pop();
    if (!e) throw new Unsupported("operand stack underflow (malformed or unsupported control flow)");
    if (stack.length < ctls[ctls.length - 1]!.base) throw new Unsupported("operand stack underflow below a block boundary");
    return e;
  };
  const popN = (n: number): Expr[] => { const r: Expr[] = []; for (let i = 0; i < n; i++) r.unshift(pop()); return r; };
  const push = (e: Expr): void => { stack.push(e); };

  // call results are lazy expressions; a statement-level call (no result, or dropped) is emitted right away
  const calleeOf = (idx: number): CalleeInfo => {
    let c = ir.callees.find((x) => x.index === idx);
    if (!c) {
      const t = m.types[m.funcTypeIdx[idx]!];
      c = { index: idx, params: (t?.params ?? []) as WType[], results: (t?.results ?? []) as WType[], name: nameOf(idx), imported: idx < m.numImportedFuncs };
      ir.callees.push(c);
    }
    return c;
  };

  // ---- labels
  const target = (depth: number): { ctl: Ctl; ref: LabelRef } => {
    const c = ctls[ctls.length - 1 - depth];
    if (!c) throw new Unsupported(`branch depth ${depth} is outside the function`);
    c.kind === "func" ? undefined : (ir.labels[c.label]!.refs++);
    if (c.kind === "func") ir.labels[0]!.refs++;
    return { ctl: c, ref: { label: c.label, kind: c.kind === "func" ? "return" : c.kind === "loop" ? "continue" : "break" } };
  };
  const targetBB = (c: Ctl): BasicBlock => {
    if (c.kind === "loop") return c.headBB!;
    if (!c.exitBB) c.exitBB = newBB(-1);
    return c.exitBB;
  };
  const arityOf = (c: Ctl): number => (c.kind === "loop" ? c.paramTypes.length : c.resultTypes.length);
  /** copy the top `arity` stack values into the target's result/param variables */
  const passValues = (c: Ctl, vals: Expr[], off: number): void => {
    const dst = c.kind === "loop" ? c.params : c.results;
    vals.forEach((v, i) => { const d = dst[i]!; if (!(v.k === "var" && v.id === d.id)) emit({ k: "assign", dst: d.id, src: v, off, bb: cur.id } as Stmt); });
  };
  /** values below the ones that survive a branch are dropped: keep their side effects */
  const dropBelow = (keep: number, off: number): void => {
    const lim = stack.length - keep;
    for (let i = 0; i < lim; i++) { const e = stack[i]!; if (hasCall(e)) emit({ k: "expr", e, off, bb: cur.id } as Stmt); }
  };

  const markDead = (): void => { dead = true; deadNest = 0; };

  // ---- main loop
  const r = new Reader(m.bytes, hdr.codeStart, body.end);
  const ins: Ins = newIns();
  const max = opts.maxInstructions ?? 200000;
  let count = 0;
  const bodyOff = (p: number) => p - body.start;
  let lastOff = 0;

  try {
    while (!r.eof) {
      decode(r, ins);
      if (++count > max) throw new Unsupported("function is too large to decompile");
      const off = bodyOff(ins.pos);
      lastOff = off;
      const name = ins.op.name;
      if (count === 1) cur.start = off; // the entry block starts at the first instruction, not at the locals header
      cur.end = off;

      if (dead) {
        if (name === "block" || name === "loop" || name === "if" || name === "try" || name === "try_table") { deadNest++; continue; }
        if (name === "end") { if (deadNest > 0) { deadNest--; continue; } }
        else if (name === "else") { if (deadNest > 0) continue; }
        else continue;
      }

      const sb = (): { params: Var[]; results: Var[]; pt: WType[]; rt: WType[] } => {
        let pt: WType[] = [], rt: WType[] = [];
        if (ins.bt === -64) { /* empty */ }
        else if (ins.bt < 0) rt = [BT[ins.bt] ?? "i32"];
        else { const t = m.types[ins.bt]; pt = (t?.params ?? []) as WType[]; rt = (t?.results ?? []) as WType[]; }
        return { params: [], results: [], pt, rt };
      };

      switch (name) {
        case "nop": break;

        // ---------------------------------------------------------- structure
        case "block": case "loop": case "if": {
          const s = sb();
          const cond = name === "if" ? pop() : null;
          const inVals = popN(s.pt.length);
          spillAll(); // everything below may be changed by the body: freeze it now
          const params = s.pt.map((t) => newTemp(t));
          inVals.forEach((v, i) => emit({ k: "assign", dst: params[i]!.id, src: v, off, bb: cur.id } as Stmt));
          const results = s.rt.map((t) => newResult(t));
          const label = ++labelN;
          ir.labels[label] = { kind: name as LabelInfo["kind"], off, refs: 0 };
          const base = stack.length;
          let node: Node;
          const ctl: Ctl = { kind: name as Ctl["kind"], label, node: null, base, results, params, resultTypes: s.rt, paramTypes: s.pt, exitBB: null, headBB: null, falseEdge: null, thenLive: true, inElse: false, parentBody: list };
          if (name === "block") {
            node = emit({ k: "block", label, body: [], results: results.map((x) => x.id), off, bb: cur.id });
            list = (node as Extract<Node, { k: "block" }>).body;
          } else if (name === "loop") {
            const head = newBB(off);
            link(cur, head, "fall"); cur.term = "fall";
            cur = head; ctl.headBB = head;
            node = emit({ k: "loop", label, body: [], params: params.map((x) => x.id), results: results.map((x) => x.id), off, bb: cur.id });
            list = (node as Extract<Node, { k: "loop" }>).body;
          } else {
            node = emit({ k: "if", label, cond: cond!, then: [], else: null, results: results.map((x) => x.id), off, bb: cur.id });
            const thenBB = newBB(off);
            link(cur, thenBB, "true");
            ctl.falseEdge = link(cur, thenBB, "false"); // patched at else / end
            cur.term = "if";
            cur = thenBB;
            list = (node as Extract<Node, { k: "if" }>).then;
          }
          ctl.node = node;
          // parameters become the first values on the stack inside the construct
          params.forEach((p) => push({ k: "var", id: p.id, ty: p.ty, off }));
          ctl.base = stack.length - params.length; // the params are the block's own
          ctls.push(ctl);
          break;
        }
        case "else": {
          const c = ctls[ctls.length - 1]!;
          if (c.kind !== "if") throw new Unsupported("else without if");
          if (!dead) {
            const vals = popN(c.resultTypes.length);
            passValues(c, vals, off);
            c.thenLive = true;
            const ex = targetBB(c); link(cur, ex, "fall"); cur.term = "fall";
          } else c.thenLive = false;
          stack.length = c.base; dead = false; deadNest = 0;
          const elseBB = newBB(off);
          if (c.falseEdge) { c.falseEdge.to = elseBB.id; c.falseEdge = null; }
          cur = elseBB;
          (c.node as Extract<Node, { k: "if" }>).else = [];
          list = (c.node as Extract<Node, { k: "if" }>).else!;
          c.inElse = true;
          c.paramTypes.length && c.params.forEach((p) => push({ k: "var", id: p.id, ty: p.ty, off }));
          break;
        }
        case "end": {
          const c = ctls[ctls.length - 1]!;
          if (c.kind === "func") {
            if (!dead && c.resultTypes.length) {
              const vals = popN(c.resultTypes.length);
              dropBelow(0, off);
              emit({ k: "return", values: vals, off, bb: cur.id } as Stmt);
              cur.term = "return";
            } else if (!dead) cur.term = "end";
            ctls.pop();
            break;
          }
          let liveOut: boolean;
          if (!dead) {
            const vals = popN(c.resultTypes.length);
            passValues(c, vals, off);
            liveOut = true;
          } else liveOut = c.kind === "if" && c.inElse ? c.thenLive : false;
          if (c.kind === "if" && !c.inElse) liveOut = true; // the implicit else path
          if (c.kind === "if" && c.inElse && !dead) liveOut = true;
          if (c.kind !== "loop" && ir.labels[c.label]!.refs > 0) liveOut = true;
          ctls.pop();
          list = c.parentBody;
          stack.length = c.base;
          // join block
          const join = c.kind === "loop" ? newBB(off) : (c.exitBB ?? newBB(off));
          if (c.kind !== "loop") { join.start = ir.labels[c.label] && join.start < 0 ? off : join.start; }
          if (!dead) { link(cur, join, "fall"); cur.term = "fall"; }
          if (c.falseEdge) { c.falseEdge.to = join.id; c.falseEdge = null; }
          if (join.start < 0) join.start = off;
          cur = join;
          dead = !liveOut; deadNest = 0;
          if (!dead) c.results.forEach((v) => push({ k: "var", id: v.id, ty: v.ty, off }));
          break;
        }
        case "br": {
          const t = target(ins.a);
          const ar = arityOf(t.ctl);
          const vals = popN(ar);
          dropBelow(0, off);
          if (t.ref.kind === "return") emit({ k: "return", values: vals, off, bb: cur.id } as Stmt);
          else { passValues(t.ctl, vals, off); emit({ k: "br", to: t.ref, off, bb: cur.id } as Stmt); }
          if (t.ref.kind === "return") cur.term = "return";
          else { link(cur, targetBB(t.ctl), t.ref.kind === "continue" ? "back" : "br"); cur.term = "br"; }
          markDead();
          break;
        }
        case "br_if": {
          const cond = pop();
          const t = target(ins.a);
          const ar = arityOf(t.ctl);
          spillEffectful();
          if (ar === 0) {
            emit({ k: "brif", cond, to: t.ref, off, bb: cur.id } as Stmt);
          } else {
            // values stay on the stack for the fall-through path: copy them for the taken path inside an `if`
            const top = stack.length - ar;
            for (let i = top; i < stack.length; i++) { const e = stack[i]!; if (!isStable(e)) { const tmp = newTemp(tyOf(e)); emit({ k: "assign", dst: tmp.id, src: e, off, bb: cur.id } as Stmt); stack[i] = { k: "var", id: tmp.id, ty: tmp.ty, off }; } }
            const vals = stack.slice(top);
            if (t.ref.kind === "return") {
              const lab = ++labelN; ir.labels[lab] = { kind: "if", off, refs: 0 };
              emit({ k: "if", label: lab, cond, then: [{ k: "return", values: vals, off, bb: cur.id } as Stmt], else: null, results: [], off, bb: cur.id });
            } else {
              const dst = t.ctl.kind === "loop" ? t.ctl.params : t.ctl.results;
              const thenN: Node[] = [];
              vals.forEach((v, i) => thenN.push({ k: "assign", dst: dst[i]!.id, src: v, off, bb: cur.id } as Stmt));
              thenN.push({ k: "br", to: t.ref, off, bb: cur.id } as Stmt);
              const lab = ++labelN; ir.labels[lab] = { kind: "if", off, refs: 0 };
              emit({ k: "if", label: lab, cond, then: thenN, else: null, results: [], off, bb: cur.id });
            }
          }
          const fallBB = newBB(off);
          if (t.ref.kind !== "return") link(cur, targetBB(t.ctl), t.ref.kind === "continue" ? "back" : "true");
          link(cur, fallBB, "false");
          cur.term = "brif";
          cur = fallBB;
          break;
        }
        case "br_table": {
          const idx = pop();
          const list2 = ins.list!;
          const refs = list2.map((d) => target(d));
          const ar = arityOf(refs[refs.length - 1]!.ctl);
          const vals = popN(ar);
          dropBelow(0, off);
          if (ar) vals.forEach((v) => { if (!isStable(v)) { /* evaluated once, before the dispatch */ } });
          // values for a br_table are only supported when every target is a return or takes no values
          if (ar && refs.some((x) => x.ref.kind !== "return")) {
            // copy to every distinct target's variables before dispatching would be wrong (only one target runs): mark it
            ir.warnings.push(`+${off.toString(16)}: br_table carrying ${ar} value(s) to block targets is shown without the value transfer`);
          }
          emit({ k: "brtable", idx, targets: refs.slice(0, -1).map((x) => x.ref), dflt: refs[refs.length - 1]!.ref, off, bb: cur.id } as Stmt);
          const seen = new Set<number>();
          refs.forEach((x, i) => {
            if (x.ref.kind === "return") return;
            const bbT = targetBB(x.ctl);
            if (seen.has(bbT.id) && i < refs.length - 1) return;
            seen.add(bbT.id);
            link(cur, bbT, i === refs.length - 1 ? "default" : "case");
          });
          cur.term = "brtable";
          markDead();
          break;
        }
        case "return": {
          const vals = popN(sig.results.length);
          dropBelow(0, off);
          ir.labels[0]!.refs++;
          emit({ k: "return", values: vals, off, bb: cur.id } as Stmt);
          cur.term = "return";
          markDead();
          break;
        }
        case "unreachable":
          spillEffectful();
          emit({ k: "unreachable", off, bb: cur.id } as Stmt);
          cur.term = "unreachable";
          markDead();
          break;

        // ---------------------------------------------------------- calls
        case "call": case "return_call": {
          const c = calleeOf(ins.a);
          const args = popN(c.params.length);
          const call: Expr = { k: "call", func: c.index, args, ty: c.results.length === 1 ? c.results[0]! : null, off };
          if (name === "return_call") { emit({ k: "return", values: [call], off, bb: cur.id } as Stmt); cur.term = "return"; markDead(); break; }
          if (c.results.length === 0) { spillEffectful(); emit({ k: "expr", e: call, off, bb: cur.id } as Stmt); }
          else if (c.results.length === 1) { spillEffectful(); push(call); }
          else {
            spillEffectful();
            const ds = c.results.map((t) => newTemp(t));
            emit({ k: "assignm", dsts: ds.map((x) => x.id), src: call, off, bb: cur.id } as Stmt);
            ds.forEach((d) => push({ k: "var", id: d.id, ty: d.ty, off }));
          }
          break;
        }
        case "call_indirect": case "return_call_indirect": {
          const t = m.types[ins.a];
          const tgt = pop();
          const args = popN(t?.params.length ?? 0);
          const res = (t?.results ?? []) as WType[];
          const call: Expr = { k: "calli", typeIdx: ins.a, table: ins.b, target: tgt, args, ty: res.length === 1 ? res[0]! : null, off };
          if (name === "return_call_indirect") { emit({ k: "return", values: [call], off, bb: cur.id } as Stmt); cur.term = "return"; markDead(); break; }
          spillEffectful();
          if (res.length === 0) emit({ k: "expr", e: call, off, bb: cur.id } as Stmt);
          else if (res.length === 1) push(call);
          else {
            const ds = res.map((tt) => newTemp(tt));
            emit({ k: "assignm", dsts: ds.map((x) => x.id), src: call, off, bb: cur.id } as Stmt);
            ds.forEach((d) => push({ k: "var", id: d.id, ty: d.ty, off }));
          }
          break;
        }

        // ---------------------------------------------------------- stack / variables
        case "drop": {
          const e = pop();
          if (e.k === "const" || e.k === "var" || e.k === "global") break;
          emit({ k: "expr", e, off, bb: cur.id } as Stmt);
          break;
        }
        case "select": {
          const c = pop(), b = pop(), a = pop();
          if (hasCall(a) || hasCall(b)) { // select evaluates both arms: keep their effects, in order
            const tmp = (x: Expr): Expr => {
              if (isStable(x)) return x;
              const t = newTemp(tyOf(x)); emit({ k: "assign", dst: t.id, src: x, off, bb: cur.id } as Stmt);
              return { k: "var", id: t.id, ty: t.ty, off };
            };
            const ta = tmp(a), tb = tmp(b);
            push({ k: "select", c, a: ta, b: tb, ty: tyOf(a), off });
          } else push({ k: "select", c, a, b, ty: tyOf(a), off });
          break;
        }
        case "local.get": { const v = localVar(ins.a); push({ k: "var", id: v.id, ty: v.ty, off }); break; }
        case "local.set": case "local.tee": {
          const v = localVar(ins.a);
          const val = pop();
          spillIf((e) => readsLocal(e, v.id));
          emit({ k: "assign", dst: v.id, src: val, off, bb: cur.id } as Stmt);
          if (name === "local.tee") push({ k: "var", id: v.id, ty: v.ty, off });
          break;
        }
        case "global.get": push({ k: "global", idx: ins.a, ty: (m.globals[ins.a]?.valType ?? "i32") as WType, off }); break;
        case "global.set": {
          const val = pop();
          spillIf((e) => readsGlobal(e, ins.a) || hasCall(e));
          emit({ k: "gset", idx: ins.a, value: val, off, bb: cur.id } as Stmt);
          break;
        }

        // ---------------------------------------------------------- constants
        case "i32.const": push({ k: "const", ty: "i32", v: String(ins.num | 0), off }); break;
        case "i64.const": push({ k: "const", ty: "i64", v: ins.big.toString(), off }); break;
        case "f32.const": { const f = new DataView(ins.bytes!.buffer, ins.bytes!.byteOffset, 4).getFloat32(0, true); push({ k: "const", ty: "f32", v: fmtFloat(f), off }); break; }
        case "f64.const": { const f = new DataView(ins.bytes!.buffer, ins.bytes!.byteOffset, 8).getFloat64(0, true); push({ k: "const", ty: "f64", v: fmtFloat(f), off }); break; }
        case "v128.const": push({ k: "const", ty: "v128", v: "0x" + Array.from(ins.bytes!, (b) => b.toString(16).padStart(2, "0")).reverse().join(""), off }); break;

        // ---------------------------------------------------------- memory
        case "memory.size": push({ k: "opaque", name, args: [], ty: "i32", off }); break;
        case "memory.grow": { const a = pop(); spillEffectful(); push({ k: "opaque", name, args: [a], ty: "i32", off }); break; }

        default: {
          const acc = ins.op.access;
          // ---- plain loads / stores (and their atomic / SIMD flavours with a memarg)
          if (acc && ins.op.imm === "memarg") {
            const pre = name.slice(0, name.indexOf("."));
            const ty = (pre === "i32" || pre === "i64" || pre === "f32" || pre === "f64" || pre === "v128" ? pre : "i32") as WType;
            if (acc.load && !acc.store) {
              const addr = pop();
              push({ k: "load", op: name, addr, offset: ins.offset, size: acc.size, ty, align: ins.align, off });
              break;
            }
            if (acc.store && !acc.load) {
              const value = pop(), addr = pop();
              spillIf((e) => readsMem(e) || hasCall(e));
              emit({ k: "store", op: name, addr, offset: ins.offset, size: acc.size, value, off, bb: cur.id } as Stmt);
              break;
            }
            // atomic read-modify-write / cmpxchg
            const n = /cmpxchg/.test(name) ? 3 : 2;
            const args = popN(n);
            const addr = args[0]!;
            spillIf((e) => readsMem(e) || hasCall(e));
            push({ k: "opaque", name, args: [{ ...addr }, ...args.slice(1)], ty, off });
            break;
          }
          if (ins.op.imm === "memarglane") {
            const pops = acc?.store ? 2 : 2;
            const a = popN(pops);
            if (acc?.store) { spillIf((e) => readsMem(e) || hasCall(e)); emit({ k: "effect", name, args: a, off, bb: cur.id } as Stmt); }
            else push({ k: "opaque", name, args: a, ty: "v128", off });
            break;
          }
          // ---- numeric
          const ns = numSig(name);
          if (ns) {
            if (ns.pops === 1) { const a = pop(); push({ k: "un", op: name, a, ty: ns.ty, off }); }
            else { const b = pop(), a = pop(); push({ k: "bin", op: name, a, b, ty: ns.ty, off }); }
            break;
          }
          // ---- everything with a known stack effect but no C form
          const os = otherSig(name);
          if (os) {
            const args = popN(os.pops);
            if (os.effect && os.ty === null) { spillIf((e) => readsMem(e) || hasCall(e)); emit({ k: "effect", name, args, off, bb: cur.id } as Stmt); }
            else {
              if (os.effect) spillEffectful();
              push({ k: "opaque", name, args, ty: os.ty, off });
            }
            break;
          }
          throw new Unsupported(`unsupported instruction ${name}`);
        }
      }
    }
    if (ctls.length > 0 && !dead && ctls[0]!.kind === "func" && ctls.length > 1) throw new Unsupported("unterminated block");
  } catch (e) {
    ir.incomplete = { off: lastOff, reason: (e as Error).message };
  }

  // ---- finish
  const strAt = opts.cstring;
  if (strAt) {
    let n = 0;
    walkNodes(ir.tree, (nd) => {
      for (const ex of stmtExprs(nd)) mapExpr(ex, (x) => {
        if (x.k === "const" && x.ty === "i32" && n < 4000) { const v = Number(x.v) >>> 0; if (v >= 0x400 && !(v in ir.strings)) { n++; const s = strAt(v); if (s) ir.strings[v] = s; } }
      });
    });
  }
  // drop basic blocks nothing reaches and nothing was emitted into
  const used = new Set<number>();
  walkNodes(ir.tree, (nd) => { used.add((nd as { bb: number }).bb); });
  const reach = new Set<number>([0]);
  for (const b of bbs) for (const e of b.edges) reach.add(e.to);
  ir.blocks = bbs.filter((b) => used.has(b.id) || reach.has(b.id));
  for (const b of ir.blocks) if (b.start < 0) b.start = b.end;
  analyze(ir);
  return ir;
}

function fmtFloat(f: number): string {
  if (Number.isNaN(f)) return "NaN";
  if (!Number.isFinite(f)) return f > 0 ? "INFINITY" : "-INFINITY";
  if (Object.is(f, -0)) return "-0.0";
  return Number.isInteger(f) && Math.abs(f) < 1e15 ? f.toFixed(1) : String(f);
}

// ---------------------------------------------------------------------------------------------------------------
// usage analysis: def/use counts and inferred hints
// ---------------------------------------------------------------------------------------------------------------
export function analyze(ir: FuncIR): void {
  const vars = new Map(ir.vars.map((v) => [v.id, v]));
  const hint = (id: string | undefined, h: Var["hints"][number]["hint"], why: string): void => {
    const v = id ? vars.get(id) : undefined;
    if (v && !v.hints.some((x) => x.hint === h)) v.hints.push({ hint: h, why });
  };
  const rootVar = (e: Expr): string | undefined => {
    if (e.k === "var") return e.id;
    if (e.k === "bin" && (e.op.endsWith(".add") || e.op.endsWith(".sub"))) return rootVar(e.a) ?? rootVar(e.b);
    return undefined;
  };
  const isBoolExpr = (e: Expr): boolean => (e.k === "bin" && /\.(eq|ne|lt|gt|le|ge)(_[su])?$/.test(e.op)) || (e.k === "un" && e.op.endsWith(".eqz"));
  const boolAssign = new Map<string, { all: boolean }>();

  walkNodes(ir.tree, (n) => {
    if (n.k === "assign") { const v = vars.get(n.dst); if (v) v.defs++; const b = boolAssign.get(n.dst) ?? { all: true }; if (!isBoolExpr(n.src)) b.all = false; boolAssign.set(n.dst, b); }
    if (n.k === "assignm") for (const d of n.dsts) { const v = vars.get(d); if (v) v.defs++; }
    if (n.k === "block" || n.k === "loop") for (const id of n.results) { const v = vars.get(id); if (v) v.defs++; }
    for (const ex of stmtExprs(n)) {
      mapExpr(ex, (x) => {
        if (x.k === "var") { const v = vars.get(x.id); if (v) v.uses++; }
        if (x.k === "load") hint(rootVar(x.addr), "ptr", `used as the base address of ${x.op}`);
        if (x.k === "calli") hint(rootVar(x.target), "funcptr", "used as a call_indirect target");
        if (x.k === "bin" && /\.(lt|gt|le|ge|div|rem|shr)_s$/.test(x.op)) { hint(rootVar(x.a), "signed", `operand of ${x.op}`); hint(rootVar(x.b), "signed", `operand of ${x.op}`); }
        if (x.k === "bin" && /\.(lt|gt|le|ge|div|rem|shr)_u$/.test(x.op)) { hint(rootVar(x.a), "unsigned", `operand of ${x.op}`); hint(rootVar(x.b), "unsigned", `operand of ${x.op}`); }
        if (x.k === "select") hint(x.c.k === "var" ? x.c.id : undefined, "bool", "used as a select condition");
      });
    }
    if (n.k === "store") hint(rootVar(n.addr), "ptr", `used as the base address of ${n.op}`);
    if (n.k === "brif" && n.cond.k === "var") hint(n.cond.id, "bool", "used as a br_if condition");
    if (n.k === "if" && n.cond.k === "var") hint(n.cond.id, "bool", "used as an if condition");
  });
  for (const [id, b] of boolAssign) if (b.all) hint(id, "bool", "only ever assigned the result of a comparison");
  // parameters count as defined once (by the caller)
  for (const v of ir.vars) if (v.kind === "param") v.defs++;
}
