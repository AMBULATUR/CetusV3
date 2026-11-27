/**
 * IR -> text. Two renderers share one segment model:
 *   renderPseudo : readable C-like pseudocode
 *   renderIR     : basic blocks, edges, statements, defs/uses, memory accesses
 *
 * Output is a list of lines made of segments. A segment may carry `off` (the WASM instruction offset it came from)
 * and `ref` (a symbol the user can rename / annotate), so a UI can highlight and edit in place, and `toText` flattens
 * the same data into plain text for copying. Names come from a Resolver (the annotation database); every name says
 * whether it is confirmed or inferred, and nothing is renamed that the module or the user did not name.
 */
import { Expr, FuncIR, Node, Stmt, LabelRef, Var, mapExpr, exprOffs, stmtExprs } from "./ir";

export type Conf = "confirmed" | "inferred";

export type SymRef =
  | { kind: "func"; id: number }
  | { kind: "const"; id: number; off: number }
  | { kind: "str"; id: number }
  | { kind: "var"; id: string }
  | { kind: "field"; id: number }
  | { kind: "global"; id: number };

export interface Seg { t: string; off?: number; cls?: string; ref?: SymRef; conf?: Conf }
export interface Line { indent: number; segs: Seg[]; offs: number[]; kind?: "decl" | "head" | "code" | "comment" | "bb" }
export interface Doc { lines: Line[]; warnings: string[] }

export interface UserSig { ret?: string; params?: { name?: string; type?: string }[] }

/** everything the renderers may ask the annotation database. All lookups are optional: no annotation -> default text. */
export interface Resolver {
  funcName(idx: number, moduleName: string): { name: string; conf: Conf | "default" };
  funcSig(idx: number): UserSig | undefined;
  funcComment(idx: number): string | undefined;
  varName(func: number, id: string): string | undefined;
  varType(func: number, id: string): string | undefined;
  /** name for the i32 constant at this instruction: instruction-level first, then shared by value */
  constName(func: number, off: number, value: number): { name: string; conf: Conf; shared: boolean } | undefined;
  stringLabel(addr: number): { name: string; conf: Conf } | undefined;
  fieldName(offset: number): { name: string; conf: Conf } | undefined;
  globalName(idx: number): { name: string; conf: Conf } | undefined;
  insComment(func: number, off: number): string | undefined;
  /** comment attached to a constant value / string address (shared) */
  constComment(value: number): string | undefined;
}

export const NO_ANNOTATIONS: Resolver = {
  funcName: (_i, n) => ({ name: n, conf: /^func_\d+$/.test(n) ? "default" : "confirmed" }),
  funcSig: () => undefined, funcComment: () => undefined, varName: () => undefined, varType: () => undefined,
  constName: () => undefined, stringLabel: () => undefined, fieldName: () => undefined, globalName: () => undefined,
  insComment: () => undefined, constComment: () => undefined,
};

export const toText = (d: Doc): string => d.lines.map((l) => "  ".repeat(l.indent) + l.segs.map((s) => s.t).join("")).join("\n");

// ---------------------------------------------------------------------------------------------------------------
// expression rendering
// ---------------------------------------------------------------------------------------------------------------
interface R { segs: Seg[]; prec: number }
interface Ctx { ir: FuncIR; res: Resolver; used: { funcs: Set<number>; consts: Set<number>; strs: Set<number> } }

const T = (t: string, o: Partial<Seg> = {}): Seg => ({ t, ...o });
const paren = (r: R, max: number): Seg[] => (r.prec > max ? [T("("), ...r.segs, T(")")] : r.segs);

const C_BIN: Record<string, [string, number]> = {
  add: ["+", 4], sub: ["-", 4], mul: ["*", 3], div: ["/", 3], div_s: ["/", 3], div_u: ["/", 3], rem_s: ["%", 3], rem_u: ["%", 3],
  and: ["&", 8], or: ["|", 10], xor: ["^", 9], shl: ["<<", 5], shr_s: [">>", 5], shr_u: [">>", 5],
  eq: ["==", 7], ne: ["!=", 7], lt: ["<", 6], gt: [">", 6], le: ["<=", 6], ge: [">=", 6],
  lt_s: ["<", 6], lt_u: ["<", 6], gt_s: [">", 6], gt_u: [">", 6], le_s: ["<=", 6], le_u: ["<=", 6], ge_s: [">=", 6], ge_u: [">=", 6],
};
const UNSIGNED_OPS = new Set(["div_u", "rem_u", "shr_u", "lt_u", "gt_u", "le_u", "ge_u"]);
const FN_BIN: Record<string, string> = { min: "fmin", max: "fmax", copysign: "copysign", rotl: "rotl", rotr: "rotr" };
const FN_UN: Record<string, string> = { clz: "clz", ctz: "ctz", popcnt: "popcnt", abs: "fabs", sqrt: "sqrt", ceil: "ceil", floor: "floor", trunc: "trunc", nearest: "nearbyint" };
const CT: Record<string, string> = { i32: "i32", i64: "i64", f32: "f32", f64: "f64", v128: "v128" };
const uOf = (t: string): string => (t === "i32" ? "u32" : t === "i64" ? "u64" : t);

/** C element type that a load / store op moves */
export function memType(op: string): string {
  const m = /^(i32|i64|f32|f64|v128)\.(?:atomic\.)?(?:load|store|rmw)(8|16|32|64)?(?:x\d+)?(?:_(s|u))?/.exec(op);
  if (!m) return "i32";
  const base = m[1]!, w = m[2];
  if (!w) return CT[base] ?? base;
  const sgn = m[3] === "u" ? "u" : "i";
  return `${sgn}${w}`;
}
const isAtomic = (op: string): boolean => op.includes(".atomic.");

const hexN = (n: number): string => "0x" + (n >>> 0).toString(16);
function numText(v: string): string {
  const n = Number(v);
  if (n >= 0 && n < 4096) return v;
  if (n >= 4096) return hexN(n);
  return v; // negative: decimal
}

export function negateExpr(e: Expr): Expr | null {
  if (e.k === "un" && e.op.endsWith(".eqz")) return e.a;
  if (e.k === "bin") {
    const [t, op] = [e.op.slice(0, e.op.indexOf(".")), e.op.slice(e.op.indexOf(".") + 1)];
    if (t === "f32" || t === "f64") return null; // NaN: !(a < b) is not (a >= b)
    const flip: Record<string, string> = { eq: "ne", ne: "eq", lt_s: "ge_s", ge_s: "lt_s", gt_s: "le_s", le_s: "gt_s", lt_u: "ge_u", ge_u: "lt_u", gt_u: "le_u", le_u: "gt_u" };
    const f = flip[op];
    if (f) return { ...e, op: `${t}.${f}` };
  }
  return null;
}

function constR(e: Extract<Expr, { k: "const" }>, c: Ctx, func: number): R {
  if (e.ty !== "i32") {
    const neg = e.v.startsWith("-");
    return { segs: [T(e.ty === "i64" && Math.abs(Number(e.v)) >= 4096 && !neg ? hexN(Number(e.v)) : e.v, { off: e.off, cls: "num" })], prec: neg ? 2 : 0 };
  }
  const val = Number(e.v);
  const u = val >>> 0;
  const named = c.res.constName(func, e.off, u);
  const str = c.ir.strings[u];
  if (named) {
    c.used.consts.add(u);
    return { segs: [T(named.name, { off: e.off, cls: "const-named", ref: { kind: "const", id: u, off: e.off }, conf: named.conf }), T(` /* ${hexN(u)}${str !== undefined ? " " + JSON.stringify(str) : ""} */`, { cls: "cm" })], prec: 0 };
  }
  if (str !== undefined) {
    const lab = c.res.stringLabel(u);
    c.used.strs.add(u);
    if (lab) return { segs: [T(lab.name, { off: e.off, cls: "const-named", ref: { kind: "str", id: u }, conf: lab.conf }), T(` /* ${hexN(u)} ${JSON.stringify(str)} */`, { cls: "cm" })], prec: 0 };
    return { segs: [T(JSON.stringify(str), { off: e.off, cls: "str", ref: { kind: "str", id: u } }), T(` /* @${hexN(u)}, inferred string */`, { cls: "cm" })], prec: 0 };
  }
  const neg = val < 0;
  return { segs: [T(numText(String(val)), { off: e.off, cls: "num", ref: { kind: "const", id: u, off: e.off } })], prec: neg ? 2 : 0 };
}

function varSeg(id: string, off: number, c: Ctx, func: number): Seg {
  return T(c.res.varName(func, id) ?? id, { off, cls: "var", ref: { kind: "var", id } });
}

function addrR(addr: Expr, offset: number, c: Ctx, func: number): Seg[] {
  const a = rExpr(addr, c, func);
  const f = offset ? c.res.fieldName(offset) : undefined;
  if (!offset) return a.segs;
  const left = paren(a, 4);
  return [...left, T(" + "), T(String(offset), { off: addr.off, cls: "num", ref: { kind: "field", id: offset } }), ...(f ? [T(` /*.${f.name}${f.conf === "inferred" ? "?" : ""}*/`, { cls: "cm", ref: { kind: "field", id: offset }, conf: f.conf })] : [])];
}

function callArgs(args: Expr[], c: Ctx, func: number): Seg[] {
  const out: Seg[] = [T("(")];
  args.forEach((a, i) => { if (i) out.push(T(", ")); out.push(...rExpr(a, c, func).segs); });
  out.push(T(")"));
  return out;
}

export function funcSeg(idx: number, off: number | undefined, c: Ctx): Seg {
  const info = c.ir.callees.find((x) => x.index === idx);
  const mod = info?.name ?? (idx === c.ir.index ? c.ir.name : `func_${idx}`);
  const r = c.res.funcName(idx, mod);
  c.used.funcs.add(idx);
  return T(r.name, { ...(off !== undefined ? { off } : {}), cls: r.conf === "default" ? "fn unresolved" : r.conf === "inferred" ? "fn sym-inferred" : "fn", ref: { kind: "func", id: idx }, ...(r.conf !== "default" ? { conf: r.conf } : {}) });
}

function rExpr(e: Expr, c: Ctx, func: number): R {
  switch (e.k) {
    case "const": return constR(e, c, func);
    case "var": return { segs: [varSeg(e.id, e.off, c, func)], prec: 0 };
    case "global": {
      const g = c.res.globalName(e.idx);
      return { segs: [T(g ? g.name : `g${e.idx}`, { off: e.off, cls: "var", ref: { kind: "global", id: e.idx }, ...(g ? { conf: g.conf } : {}) })], prec: 0 };
    }
    case "load": {
      const ty = memType(e.op);
      if (isAtomic(e.op)) return { segs: [T(`atomic_load_${ty}`, { off: e.off, cls: "op" }), T("("), ...addrR(e.addr, e.offset, c, func), T(")")], prec: 1 };
      const inner = addrR(e.addr, e.offset, c, func);
      const bare = e.offset === 0 && (e.addr.k === "var" || e.addr.k === "const" || e.addr.k === "global");
      return { segs: [T(`*(${ty}*)`, { off: e.off, cls: "op" }), ...(bare ? inner : [T("("), ...inner, T(")")])], prec: 2 };
    }
    case "call": return { segs: [funcSeg(e.func, e.off, c), ...callArgs(e.args, c, func)], prec: 1 };
    case "calli": return { segs: [T(`call_indirect<type ${e.typeIdx}${e.table ? `, table ${e.table}` : ""}>`, { off: e.off, cls: "fn unresolved" }), T("("), ...rExpr(e.target, c, func).segs, ...e.args.flatMap((a) => [T(", "), ...rExpr(a, c, func).segs]), T(")")], prec: 1 };
    case "opaque": return { segs: [T(e.name.replace(/[.]/g, "_"), { off: e.off, cls: "op opaque" }), ...callArgs(e.args, c, func)], prec: 1 };
    case "select": {
      const cc = rExpr(e.c, c, func), a = rExpr(e.a, c, func), b = rExpr(e.b, c, func);
      return { segs: [...paren(cc, 12), T(" ? ", { off: e.off, cls: "op" }), ...paren(a, 13), T(" : "), ...paren(b, 13)], prec: 13 };
    }
    case "bin": {
      const dot = e.op.indexOf(".");
      const ty = e.op.slice(0, dot), op = e.op.slice(dot + 1);
      const fn = FN_BIN[op];
      const a = rExpr(e.a, c, func), b = rExpr(e.b, c, func);
      if (fn) return { segs: [T(fn + (op === "rotl" || op === "rotr" ? (ty === "i64" ? "64" : "32") : ty === "f32" ? "f" : ""), { off: e.off, cls: "op" }), T("("), ...a.segs, T(", "), ...b.segs, T(")")], prec: 1 };
      const co = C_BIN[op];
      if (!co) return { segs: [T(e.op.replace(/[.]/g, "_"), { off: e.off, cls: "op opaque" }), T("("), ...a.segs, T(", "), ...b.segs, T(")")], prec: 1 };
      const [sym, p] = co;
      const uns = UNSIGNED_OPS.has(op);
      const cast = (s: Seg[], r: R): Seg[] => (uns ? [T(`(${uOf(ty)})`, { off: e.off, cls: "op" }), ...(r.prec > 2 ? [T("("), ...s, T(")")] : s)] : s);
      const shift = op === "shl" || op === "shr_s" || op === "shr_u";
      const L = uns ? cast(a.segs, a) : paren(a, p);
      const Rr = uns && !shift ? cast(b.segs, b) : paren({ segs: b.segs, prec: b.prec }, p - 1); // a shift count is not reinterpreted
      return { segs: [...L, T(` ${sym} `, { off: e.off, cls: "op" }), ...Rr], prec: uns ? Math.max(p, 3) : p };
    }
    case "un": {
      const dot = e.op.indexOf(".");
      const ty = e.op.slice(0, dot), op = e.op.slice(dot + 1);
      const a = rExpr(e.a, c, func);
      const cast = (t: string, extra = ""): R => ({ segs: [T(`(${t})`, { off: e.off, cls: "op" }), ...(extra ? [T(extra)] : []), ...(a.prec > 2 ? [T("("), ...a.segs, T(")")] : a.segs)], prec: 2 });
      if (op === "eqz") return { segs: [T("!", { off: e.off, cls: "op" }), ...(a.prec > 2 ? [T("("), ...a.segs, T(")")] : a.segs)], prec: 2 };
      if (op === "neg" && (ty === "f32" || ty === "f64")) return { segs: [T("-", { off: e.off, cls: "op" }), ...(a.prec > 2 ? [T("("), ...a.segs, T(")")] : a.segs)], prec: 2 };
      if (FN_UN[op]) return { segs: [T(FN_UN[op] + (op === "clz" || op === "ctz" || op === "popcnt" ? (ty === "i64" ? "64" : "32") : ty === "f32" && op !== "abs" ? "f" : ""), { off: e.off, cls: "op" }), T("("), ...a.segs, T(")")], prec: 1 };
      if (op === "extend8_s") return cast("i8");
      if (op === "extend16_s") return cast("i16");
      if (op === "extend32_s") return cast("i32");
      if (op === "wrap_i64") return cast("i32");
      if (op === "extend_i32_s") return cast("i64");
      if (op === "extend_i32_u") return { segs: [T("(i64)(u32)", { off: e.off, cls: "op" }), ...(a.prec > 2 ? [T("("), ...a.segs, T(")")] : a.segs)], prec: 2 };
      const tr = /^trunc(_sat)?_f(32|64)_(s|u)$/.exec(op);
      if (tr) return cast((tr[3] === "u" ? "u" : "i") + (ty === "i64" ? "64" : "32"));
      const cv = /^convert_i(32|64)_(s|u)$/.exec(op);
      if (cv) return cv[2] === "u" ? { segs: [T(`(${ty})(u${cv[1]})`, { off: e.off, cls: "op" }), ...(a.prec > 2 ? [T("("), ...a.segs, T(")")] : a.segs)], prec: 2 } : cast(ty);
      if (op === "demote_f64") return cast("f32");
      if (op === "promote_f32") return cast("f64");
      if (op.startsWith("reinterpret")) return { segs: [T(`reinterpret_${ty}`, { off: e.off, cls: "op" }), T("("), ...a.segs, T(")")], prec: 1 };
      return { segs: [T(e.op.replace(/[.]/g, "_"), { off: e.off, cls: "op opaque" }), T("("), ...a.segs, T(")")], prec: 1 };
    }
  }
}

/** a condition: comparisons and `!x` read as they are; anything else is a C truth value */
function condR(e: Expr, c: Ctx, func: number): Seg[] { return rExpr(e, c, func).segs; }

// ---------------------------------------------------------------------------------------------------------------
// pseudocode
// ---------------------------------------------------------------------------------------------------------------
interface Scope { label: number; kind: "block" | "loop" | "if"; shown: boolean }

export interface PseudoResult extends Doc {
  /** every symbol the text mentions (for the legend and the exported header) */
  used: { funcs: number[]; consts: number[]; strs: number[] };
}

export function renderPseudo(ir: FuncIR, res: Resolver = NO_ANNOTATIONS, opt: { legend?: boolean } = {}): PseudoResult {
  const c: Ctx = { ir, res, used: { funcs: new Set(), consts: new Set(), strs: new Set() } };
  const f = ir.index;
  const lines: Line[] = [];
  const body: Line[] = [];
  const out = (arr: Line[], indent: number, segs: Seg[], offs: Iterable<number> = [], kind: Line["kind"] = "code") => { arr.push({ indent, segs, offs: [...new Set(offs)], kind }); };

  const scopes: Scope[] = [];
  const offsOf = (n: Node): Set<number> => { const s = new Set<number>([n.off]); for (const e of stmtExprs(n)) exprOffs(e, s); return s; };
  /** user comments attached to any instruction the statement was built from, in offset order */
  const comment = (offs: number | Iterable<number>): Seg[] => {
    const list = typeof offs === "number" ? [offs] : [...offs].sort((a, b) => a - b);
    return list.flatMap((o) => { const t = res.insComment(f, o); return t ? [T("  // " + t, { cls: "cm user", off: o })] : []; });
  };

  const refName = (r: LabelRef): Seg[] => {
    if (r.kind === "return") return [T("return", { cls: "kw" })];
    const innermostLoop = [...scopes].reverse().find((s) => s.kind === "loop");
    if (r.kind === "continue") {
      const sc = scopes.find((s) => s.label === r.label);
      if (sc) sc.shown = sc.shown || innermostLoop?.label !== r.label;
      return innermostLoop?.label === r.label ? [T("continue", { cls: "kw" })] : [T("continue", { cls: "kw" }), T(` L${r.label}`)];
    }
    const sc = scopes.find((s) => s.label === r.label);
    if (sc) sc.shown = true;
    return [T("break", { cls: "kw" }), T(` L${r.label}`)];
  };

  const jump = (r: LabelRef, ret: Expr[] | null = null): Seg[] => {
    if (r.kind === "return") return [T("return", { cls: "kw" }), ...(ret && ret.length ? [T(" "), ...ret[0] ? rExpr(ret[0], c, f).segs : []] : []), T(";")];
    return [...refName(r), T(";")];
  };

  const stmtSegs = (n: Stmt): Seg[] => {
    switch (n.k) {
      case "assign": return [varSeg(n.dst, n.off, c, f), T(" = ", { off: n.off, cls: "op" }), ...rExpr(n.src, c, f).segs, T(";")];
      case "assignm": return [T("("), ...n.dsts.flatMap((d, i) => [...(i ? [T(", ")] : []), varSeg(d, n.off, c, f)]), T(") = ", { off: n.off, cls: "op" }), ...rExpr(n.src, c, f).segs, T(";")];
      case "store": {
        const ty = memType(n.op);
        if (isAtomic(n.op)) return [T(`atomic_store_${ty}`, { off: n.off, cls: "op" }), T("("), ...addrR(n.addr, n.offset, c, f), T(", "), ...rExpr(n.value, c, f).segs, T(");")];
        const bare = n.offset === 0 && (n.addr.k === "var" || n.addr.k === "const" || n.addr.k === "global");
        return [T(`*(${ty}*)`, { off: n.off, cls: "op" }), ...(bare ? addrR(n.addr, n.offset, c, f) : [T("("), ...addrR(n.addr, n.offset, c, f), T(")")]), T(" = ", { off: n.off, cls: "op" }), ...rExpr(n.value, c, f).segs, T(";")];
      }
      case "gset": { const g = res.globalName(n.idx); return [T(g ? g.name : `g${n.idx}`, { off: n.off, cls: "var", ref: { kind: "global", id: n.idx } }), T(" = ", { off: n.off, cls: "op" }), ...rExpr(n.value, c, f).segs, T(";")]; }
      case "expr": return [...(n.e.k === "call" || n.e.k === "calli" ? [] : [T("(void)", { off: n.off, cls: "op" })]), ...rExpr(n.e, c, f).segs, T(";")];
      case "effect": return [T(n.name.replace(/[.]/g, "_"), { off: n.off, cls: "op opaque" }), ...callArgs(n.args, c, f), T(";")];
      case "br": return jump(n.to);
      case "brif": return [T("if ", { cls: "kw", off: n.off }), T("("), ...condR(n.cond, c, f), T(") "), ...jump(n.to)];
      case "brtable": {
        const parts: Seg[] = [T("br_table", { cls: "kw", off: n.off }), T("("), ...rExpr(n.idx, c, f).segs, T(") { ")];
        n.targets.forEach((t, i) => { parts.push(T(`${i}: `), ...jump(t), T(" ")); });
        parts.push(T("default: "), ...jump(n.dflt), T(" }"));
        return parts;
      }
      case "return": return n.values.length === 0 ? [T("return", { cls: "kw", off: n.off }), T(";")] : [T("return ", { cls: "kw", off: n.off }), ...(n.values.length === 1 ? rExpr(n.values[0]!, c, f).segs : [T("("), ...n.values.flatMap((v, i) => [...(i ? [T(", ")] : []), ...rExpr(v, c, f).segs]), T(")")]), T(";")];
      case "unreachable": return [T("unreachable();", { cls: "kw", off: n.off })];
    }
  };

  const negCond = (e: Expr): Seg[] => {
    const n = negateExpr(e);
    if (n) return rExpr(n, c, f).segs;
    const r = rExpr(e, c, f);
    return [T("!", { cls: "op" }), ...(r.prec > 2 ? [T("("), ...r.segs, T(")")] : r.segs)];
  };

  function block(arr: Line[], nodes: Node[], ind: number): void {
    for (let i = 0; i < nodes.length; i++) node(arr, nodes[i]!, ind);
  }

  function node(arr: Line[], n: Node, ind: number): void {
    switch (n.k) {
      case "block": {
        const li = ir.labels[n.label]!;
        // block { …; br_if 0 (c); rest } is `if (!c) { rest }` when that br_if is the only way out
        if (li.refs === 1 && n.results.length === 0) {
          const k = n.body.findIndex((x) => x.k === "brif" && x.to.label === n.label && x.to.kind === "break");
          if (k >= 0) {
            const br = n.body[k] as Extract<Stmt, { k: "brif" }>;
            block(arr, n.body.slice(0, k), ind);
            const rest = n.body.slice(k + 1);
            if (!rest.length) { out(arr, ind, [T("(void)", { cls: "op" }), ...condR(br.cond, c, f), T(";"), ...comment(offsOf(br))], offsOf(br)); return; }
            out(arr, ind, [T("if ", { cls: "kw", off: br.off }), T("("), ...negCond(br.cond), T(") {"), ...comment(offsOf(br))], [br.off, ...offsOf(br)]);
            block(arr, rest, ind + 1);
            out(arr, ind, [T("}")], []);
            return;
          }
        }
        if (li.refs === 0 && n.results.length === 0) { block(arr, n.body, ind); return; } // nothing jumps to it
        const sc: Scope = { label: n.label, kind: "block", shown: false };
        scopes.push(sc);
        const inner: Line[] = [];
        block(inner, n.body, ind + 1);
        scopes.pop();
        out(arr, ind, [T(`L${n.label}: {`, { cls: "kw", off: n.off }), ...comment(n.off)], [n.off]);
        arr.push(...inner);
        out(arr, ind, [T("}")], []);
        return;
      }
      case "loop": {
        const li = ir.labels[n.label]!;
        const last = n.body[n.body.length - 1];
        // do { … } while (c): the loop's only back edge is a trailing br_if
        if (li.refs === 1 && last && last.k === "brif" && last.to.label === n.label && last.to.kind === "continue" && n.params.length === 0) {
          const sc: Scope = { label: n.label, kind: "loop", shown: false };
          scopes.push(sc);
          const inner: Line[] = [];
          block(inner, n.body.slice(0, -1), ind + 1);
          scopes.pop();
          out(arr, ind, [T("do {", { cls: "kw", off: n.off }), ...comment(n.off)], [n.off]);
          arr.push(...inner);
          out(arr, ind, [T("} while ("), ...condR(last.cond, c, f), T(");"), ...comment(offsOf(last))], offsOf(last));
          return;
        }
        if (li.refs === 0 && n.params.length === 0) { block(arr, n.body, ind); return; }
        const sc: Scope = { label: n.label, kind: "loop", shown: false };
        scopes.push(sc);
        const inner: Line[] = [];
        block(inner, n.body, ind + 1);
        scopes.pop();
        out(arr, ind, [T(`${sc.shown ? `L${n.label}: ` : ""}while (true) {`, { cls: "kw", off: n.off }), ...comment(n.off)], [n.off]);
        arr.push(...inner);
        out(arr, ind, [T("}")], []);
        return;
      }
      case "if": {
        const sc: Scope = { label: n.label, kind: "if", shown: false };
        const emitIf = (cur: Extract<Node, { k: "if" }>, a: Line[], ind2: number, elseIf: boolean): void => {
          const useNeg = cur.then.length === 0 && cur.else && cur.else.length > 0;
          const cs = useNeg ? negCond(cur.cond) : condR(cur.cond, c, f);
          const thenB = useNeg ? cur.else! : cur.then;
          const elseB = useNeg ? null : cur.else;
          scopes.push(sc);
          const ti: Line[] = [];
          block(ti, thenB, ind2 + 1);
          out(a, ind2, [T(elseIf ? "} else if " : "if ", { cls: "kw", off: cur.off }), T("("), ...cs, T(") {"), ...comment(offsOf(cur))], offsOf(cur));
          a.push(...ti);
          if (elseB && elseB.length) {
            if (elseB.length === 1 && elseB[0]!.k === "if" && (elseB[0] as Extract<Node, { k: "if" }>).results.length === 0 && cur.results.length === 0) {
              scopes.pop();
              emitIf(elseB[0] as Extract<Node, { k: "if" }>, a, ind2, true);
              return;
            }
            out(a, ind2, [T("} else {")], []);
            block(a, elseB, ind2 + 1);
          }
          scopes.pop();
          out(a, ind2, [T("}")], []);
        };
        emitIf(n, arr, ind, false);
        return;
      }
      default: {
        const segs = stmtSegs(n);
        out(arr, ind, [...segs, ...comment(offsOf(n))], offsOf(n));
      }
    }
  }
  block(body, ir.tree, 1);

  // ---- header
  const fn = funcSeg(f, undefined, c);
  const sig = res.funcSig(f);
  const pname = (v: Var, i: number): string => res.varName(f, v.id) ?? sig?.params?.[i]?.name ?? v.id;
  const ptype = (v: Var, i: number): string => sig?.params?.[i]?.type ?? res.varType(f, v.id) ?? v.ty;
  const params = ir.vars.filter((v) => v.kind === "param");
  const ret = sig?.ret ?? (ir.results.length === 0 ? "void" : ir.results.length === 1 ? ir.results[0]! : `(${ir.results.join(", ")})`);
  const headSegs: Seg[] = [T(ret + " ", { cls: "ty" }), fn, T("(")];
  params.forEach((v, i) => { if (i) headSegs.push(T(", ")); headSegs.push(T(ptype(v, i) + " ", { cls: "ty" }), T(pname(v, i), { cls: "var", ref: { kind: "var", id: v.id } })); });
  headSegs.push(T(") {"));

  if (opt.legend !== false) {
    out(lines, 0, [T(`// wasm func #${f}  (${ir.params.join(", ")}) -> ${ir.results.length ? ir.results.join(", ") : "()"}  ·  ${ir.bodySize} bytes`)], [], "comment");
    const fc = res.funcComment(f);
    if (fc) out(lines, 0, [T("// " + fc, { cls: "cm user" })], [], "comment");
    if (sig) out(lines, 0, [T("// signature declared by the user (not read from the binary)")], [], "comment");
    out(lines, 0, [T("// '?' / dashed names = inferred (a guess from usage or entered by the user); everything else is read from the binary")], [], "comment");
  }
  out(lines, 0, headSegs, [], "head");
  // inferred facts about parameters (their wasm types are in the signature; these are guesses from usage)
  for (const v of params) if (v.hints.length) out(lines, 1, [T(`// ${res.varName(f, v.id) ?? v.id}: ${v.hints.map((h) => h.hint + "?").join(" ")} (inferred: ${v.hints.map((h) => h.why).join("; ")})`, { cls: "cm inferred" })], [], "comment");

  // declarations: every variable the body mentions that is not a parameter
  const decl = (v: Var): Line => {
    const hints = v.hints.map((h) => h.hint).filter((h, i, a) => a.indexOf(h) === i);
    const note = hints.length ? `  // ${hints.map((h) => h + "?").join(" ")}${v.hints.length ? ` (${v.hints[0]!.why})` : ""}` : "";
    const ty = res.varType(f, v.id) ?? v.ty;
    // wasm guarantees that non-parameter locals start at zero; temporaries and block results are always assigned before use
    const init = v.kind === "local" ? (v.ty === "f32" || v.ty === "f64" ? " = 0.0" : v.ty === "i32" || v.ty === "i64" ? " = 0" : "") : "";
    return { indent: 1, kind: "decl", offs: [], segs: [T(ty + " ", { cls: "ty" }), T(res.varName(f, v.id) ?? v.id, { cls: "var", ref: { kind: "var", id: v.id } }), T(init + ";"), T(note, { cls: "cm inferred" })] };
  };
  const seen = new Set<string>();
  walkVars(ir, (id) => seen.add(id));
  for (const v of ir.vars) if (v.kind !== "param" && seen.has(v.id)) lines.push(decl(v));
  if (lines.some((l) => l.kind === "decl")) out(lines, 0, [], [], "decl");

  lines.push(...body);
  if (ir.incomplete) out(lines, 1, [T(`/* decompilation stopped at +${ir.incomplete.off.toString(16).padStart(4, "0")}: ${ir.incomplete.reason}. The rest of the function is not shown. */`, { cls: "cm warn" })], [ir.incomplete.off], "comment");
  out(lines, 0, [T("}")], [], "head");

  return { lines, warnings: [...ir.warnings, ...(ir.incomplete ? [`incomplete: ${ir.incomplete.reason}`] : [])], used: { funcs: [...c.used.funcs], consts: [...c.used.consts], strs: [...c.used.strs] } };
}

function walkVars(ir: FuncIR, f: (id: string) => void): void {
  const visit = (nodes: Node[]): void => {
    for (const n of nodes) {
      if (n.k === "assign") f(n.dst);
      if (n.k === "assignm") n.dsts.forEach(f);
      if (n.k === "block") { n.results.forEach(f); visit(n.body); }
      if (n.k === "loop") { n.params.forEach(f); n.results.forEach(f); visit(n.body); }
      if (n.k === "if") { n.results.forEach(f); visit(n.then); if (n.else) visit(n.else); }
      for (const e of stmtExprs(n)) mapExpr(e, (x) => { if (x.k === "var") f(x.id); });
    }
  };
  visit(ir.tree);
}

// ---------------------------------------------------------------------------------------------------------------
// IR text
// ---------------------------------------------------------------------------------------------------------------
/** compact prefix form: op(args) — no C idioms, every operator is the wasm instruction name */
function irE(e: Expr, c: Ctx, func: number): Seg[] {
  const args = (xs: Expr[]): Seg[] => xs.flatMap((a, i) => [...(i ? [T(", ")] : []), ...irE(a, c, func)]);
  switch (e.k) {
    case "const": { const r = constR(e, c, func); return [T(`${e.ty}.const `, { off: e.off, cls: "op" }), ...r.segs]; }
    case "var": return [varSeg(e.id, e.off, c, func)];
    case "global": return [T(`global.get ${e.idx}`, { off: e.off, cls: "op", ref: { kind: "global", id: e.idx } })];
    case "un": return [T(e.op, { off: e.off, cls: "op" }), T("("), ...irE(e.a, c, func), T(")")];
    case "bin": return [T(e.op, { off: e.off, cls: "op" }), T("("), ...args([e.a, e.b]), T(")")];
    case "load": return [T(`${e.op}${e.offset ? ` offset=${e.offset}` : ""}`, { off: e.off, cls: "op" }), T("("), ...irE(e.addr, c, func), T(")")];
    case "call": return [T("call ", { off: e.off, cls: "op" }), funcSeg(e.func, e.off, c), T("("), ...e.args.flatMap((a, i) => [...(i ? [T(", ")] : []), T(`arg${i}=`, { cls: "cm" }), ...irE(a, c, func)]), T(")")];
    case "calli": return [T(`call_indirect type=${e.typeIdx}`, { off: e.off, cls: "op" }), T("["), ...irE(e.target, c, func), T("]("), ...args(e.args), T(")")];
    case "select": return [T("select", { off: e.off, cls: "op" }), T("("), ...args([e.c, e.a, e.b]), T(")")];
    case "opaque": return [T(e.name, { off: e.off, cls: "op opaque" }), T("("), ...args(e.args), T(")")];
  }
}

function defsUses(n: Node): { defs: string[]; uses: string[]; mem: string[] } {
  const defs: string[] = [], uses: string[] = [], mem: string[] = [];
  if (n.k === "assign") defs.push(n.dst);
  if (n.k === "assignm") defs.push(...n.dsts);
  if (n.k === "store") mem.push(`W${n.size} @ ${n.op}`);
  for (const e of stmtExprs(n)) mapExpr(e, (x) => {
    if (x.k === "var") uses.push(x.id);
    if (x.k === "load") mem.push(`R${x.size} @ ${x.op}`);
    if (x.k === "opaque" && /atomic|memory\.(fill|copy|init)/.test(x.name)) mem.push(x.name);
  });
  if (n.k === "effect" && /^memory\./.test(n.name)) mem.push(n.name);
  return { defs, uses: [...new Set(uses)], mem };
}

export function renderIR(ir: FuncIR, res: Resolver = NO_ANNOTATIONS): Doc {
  const c: Ctx = { ir, res, used: { funcs: new Set(), consts: new Set(), strs: new Set() } };
  const f = ir.index;
  const lines: Line[] = [];
  const hx = (n: number) => "+" + n.toString(16).padStart(4, "0");
  lines.push({ indent: 0, kind: "comment", offs: [], segs: [T(`// IR of wasm func #${f} ${ir.name}  ·  ${ir.blocks.length} basic blocks  ·  offsets are function-relative (as in the Code view)`)] });
  lines.push({ indent: 0, kind: "comment", offs: [], segs: [T(`// vars: ` + ir.vars.map((v) => `${res.varName(f, v.id) ?? v.id}:${v.ty}${v.hints.length ? "(" + v.hints.map((h) => h.hint + "?").join(",") + ")" : ""}`).join("  "))] });
  const byBB = new Map<number, Node[]>();
  const collect = (nodes: Node[]): void => {
    for (const n of nodes) {
      const bb = (n as { bb: number }).bb;
      (byBB.get(bb) ?? byBB.set(bb, []).get(bb)!).push(n);
      if (n.k === "block" || n.k === "loop") collect(n.body);
      else if (n.k === "if") { collect(n.then); if (n.else) collect(n.else); }
    }
  };
  collect(ir.tree);
  const preds = new Map<number, number[]>();
  for (const b of ir.blocks) for (const e of b.edges) (preds.get(e.to) ?? preds.set(e.to, []).get(e.to)!).push(b.id);
  for (const b of ir.blocks) {
    const p = preds.get(b.id) ?? [];
    lines.push({ indent: 0, kind: "bb", offs: [], segs: [T(`bb${b.id}`, { cls: "kw" }), T(`  ${hx(b.start)}..${hx(b.end)}  term=${b.term}`), T(p.length ? `  preds: ${[...new Set(p)].map((x) => "bb" + x).join(" ")}` : "  (entry)", { cls: "cm" })] });
    for (const n of byBB.get(b.id) ?? []) {
      const du = defsUses(n);
      const pre = [T(hx(n.off) + "  ", { off: n.off, cls: "off" })];
      let segs: Seg[];
      switch (n.k) {
        case "assign": segs = [varSeg(n.dst, n.off, c, f), T(" := ", { cls: "op" }), ...irE(n.src, c, f)]; break;
        case "assignm": segs = [T(n.dsts.join(", ")), T(" := "), ...irE(n.src, c, f)]; break;
        case "store": segs = [T(`${n.op}${n.offset ? ` offset=${n.offset}` : ""}`, { off: n.off, cls: "op" }), T(" ["), ...irE(n.addr, c, f), T("] := "), ...irE(n.value, c, f)]; break;
        case "gset": segs = [T(`global.set ${n.idx} := `, { off: n.off, cls: "op" }), ...irE(n.value, c, f)]; break;
        case "expr": segs = [T("eval ", { cls: "op" }), ...irE(n.e, c, f)]; break;
        case "effect": segs = [T(n.name, { off: n.off, cls: "op opaque" }), T("("), ...n.args.flatMap((a, i) => [...(i ? [T(", ")] : []), ...irE(a, c, f)]), T(")")]; break;
        case "br": segs = [T(`br ${n.to.kind} L${n.to.label}`, { off: n.off, cls: "kw" })]; break;
        case "brif": segs = [T("br_if ", { off: n.off, cls: "kw" }), ...irE(n.cond, c, f), T(` → ${n.to.kind} L${n.to.label}`)]; break;
        case "brtable": segs = [T("br_table ", { off: n.off, cls: "kw" }), ...irE(n.idx, c, f), T(` → [${n.targets.map((t) => `${t.kind} L${t.label}`).join(", ")}] default ${n.dflt.kind} L${n.dflt.label}`)]; break;
        case "return": segs = [T("return ", { off: n.off, cls: "kw" }), ...n.values.flatMap((v, i) => [...(i ? [T(", ")] : []), ...irE(v, c, f)])]; break;
        case "unreachable": segs = [T("unreachable", { off: n.off, cls: "kw" })]; break;
        case "block": segs = [T(`block L${n.label}`, { off: n.off, cls: "kw" }), T(n.results.length ? ` results=${n.results.join(",")}` : "")]; break;
        case "loop": segs = [T(`loop L${n.label}`, { off: n.off, cls: "kw" }), T(n.params.length ? ` params=${n.params.join(",")}` : ""), T(n.results.length ? ` results=${n.results.join(",")}` : "")]; break;
        case "if": segs = [T(`if L${n.label} `, { off: n.off, cls: "kw" }), ...irE(n.cond, c, f), T(n.results.length ? ` results=${n.results.join(",")}` : "")]; break;
      }
      const stk = (n as { stk?: string[] }).stk;
      const notes = [du.defs.length ? `defs ${du.defs.join(",")}` : "", du.uses.length ? `uses ${du.uses.join(",")}` : "", du.mem.length ? `mem ${du.mem.join("; ")}` : "", stk && stk.length ? `stack [${stk.join(", ")}]` : ""].filter(Boolean).join("  ·  ");
      const offs = new Set<number>([n.off]); for (const e of stmtExprs(n)) exprOffs(e, offs);
      lines.push({ indent: 1, kind: "code", offs: [...offs], segs: [...pre, ...segs, ...(notes ? [T("    ; " + notes, { cls: "cm" })] : [])] });
    }
    if (b.edges.length) lines.push({ indent: 1, kind: "bb", offs: [], segs: [T("→ " + b.edges.map((e) => `bb${e.to} (${e.kind})`).join("  "), { cls: "cm" })] });
  }
  if (ir.incomplete) lines.push({ indent: 0, kind: "comment", offs: [ir.incomplete.off], segs: [T(`// INCOMPLETE at ${hx(ir.incomplete.off)}: ${ir.incomplete.reason}`, { cls: "cm warn" })] });
  return { lines, warnings: ir.warnings };
}
