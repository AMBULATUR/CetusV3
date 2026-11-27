/**
 * Intermediate representation between WASM disassembly and every output renderer.
 *
 * Plain JSON-serialisable data only (no classes, no BigInt): the IR is built next to the module (page realm) and
 * rendered in the app, and the same IR feeds the pseudocode renderer and the IR text renderer.
 *
 * Every node carries `off`, the offset of the WASM instruction it came from, relative to the start of the function
 * body (the same numbers the Code view shows as `+001a`), so any view can be mapped back to the disassembly.
 */
export type WType = "i32" | "i64" | "f32" | "f64" | "v128" | "funcref" | "externref" | string;

/** inferred facts about a variable. Everything here is a guess from usage unless noted; the wasm type itself is exact. */
export type Hint = "ptr" | "bool" | "signed" | "unsigned" | "funcptr";

export interface Var {
  id: string;
  kind: "param" | "local" | "temp" | "result";
  /** wasm local index for params / locals */
  index?: number;
  /** CONFIRMED: the wasm type */
  ty: WType;
  /** INFERRED from how the variable is used (`why` says how) */
  hints: { hint: Hint; why: string }[];
  /** how many times it is assigned / read */
  defs: number;
  uses: number;
}

export type Expr =
  | { k: "const"; ty: WType; v: string; off: number }
  | { k: "var"; id: string; ty: WType; off: number }
  | { k: "global"; idx: number; ty: WType; off: number }
  | { k: "un"; op: string; a: Expr; ty: WType; off: number }
  | { k: "bin"; op: string; a: Expr; b: Expr; ty: WType; off: number }
  | { k: "load"; op: string; addr: Expr; offset: number; size: number; ty: WType; align: number; off: number }
  | { k: "call"; func: number; args: Expr[]; ty: WType | null; off: number }
  | { k: "calli"; typeIdx: number; table: number; target: Expr; args: Expr[]; ty: WType | null; off: number }
  | { k: "select"; c: Expr; a: Expr; b: Expr; ty: WType; off: number }
  /** instruction the decompiler has no C form for but whose stack effect is known (SIMD, atomics, …) */
  | { k: "opaque"; name: string; args: Expr[]; ty: WType | null; off: number };

export interface LabelRef { label: number; kind: "break" | "continue" | "return" }

export type Stmt =
  | { k: "assign"; dst: string; src: Expr; off: number; bb: number }
  | { k: "assignm"; dsts: string[]; src: Expr; off: number; bb: number } // multi-value call
  | { k: "store"; op: string; addr: Expr; offset: number; size: number; value: Expr; off: number; bb: number }
  | { k: "gset"; idx: number; value: Expr; off: number; bb: number }
  | { k: "expr"; e: Expr; off: number; bb: number } // value computed and dropped / call without a used result
  | { k: "effect"; name: string; args: Expr[]; off: number; bb: number }
  | { k: "br"; to: LabelRef; off: number; bb: number }
  | { k: "brif"; cond: Expr; to: LabelRef; off: number; bb: number }
  | { k: "brtable"; idx: Expr; targets: LabelRef[]; dflt: LabelRef; off: number; bb: number }
  | { k: "return"; values: Expr[]; off: number; bb: number }
  | { k: "unreachable"; off: number; bb: number };

export type Node =
  | Stmt
  | { k: "block"; label: number; body: Node[]; results: string[]; off: number; bb: number }
  | { k: "loop"; label: number; body: Node[]; params: string[]; results: string[]; off: number; bb: number }
  | { k: "if"; label: number; cond: Expr; then: Node[]; else: Node[] | null; results: string[]; off: number; bb: number };

export interface Edge { to: number; kind: "fall" | "true" | "false" | "br" | "back" | "case" | "default" }

export interface BasicBlock {
  id: number;
  /** offset of the first instruction */
  start: number;
  /** offset of the last instruction that belongs to the block */
  end: number;
  edges: Edge[];
  /** how the block ends: falls through, branches, returns, traps */
  term: "fall" | "br" | "brif" | "brtable" | "if" | "return" | "unreachable" | "end";
}

export interface CalleeInfo { index: number; params: WType[]; results: WType[]; name: string; imported: boolean }

export interface LabelInfo { kind: "block" | "loop" | "if" | "func"; off: number; refs: number }

export interface FuncIR {
  version: 1;
  index: number;
  /** default display name (name section / export / import / func_N) */
  name: string;
  params: WType[];
  results: WType[];
  vars: Var[];
  tree: Node[];
  blocks: BasicBlock[];
  /** every function referenced by a direct call, with its signature */
  callees: CalleeInfo[];
  /** i32 constants that point at a NUL-terminated printable string in linear memory (INFERRED: it is only an i32) */
  strings: Record<number, string>;
  labels: Record<number, LabelInfo>;
  /** set when translation stopped early (unsupported instruction / malformed body); the tree is what was built so far */
  incomplete?: { off: number; reason: string };
  warnings: string[];
  bodySize: number;
}

// ---------------------------------------------------------------------------------------------------------------
// generic helpers shared by the builder and renderers
// ---------------------------------------------------------------------------------------------------------------
export function mapExpr(e: Expr, f: (x: Expr) => void): void {
  f(e);
  switch (e.k) {
    case "un": mapExpr(e.a, f); break;
    case "bin": mapExpr(e.a, f); mapExpr(e.b, f); break;
    case "load": mapExpr(e.addr, f); break;
    case "call": e.args.forEach((a) => mapExpr(a, f)); break;
    case "calli": mapExpr(e.target, f); e.args.forEach((a) => mapExpr(a, f)); break;
    case "select": mapExpr(e.c, f); mapExpr(e.a, f); mapExpr(e.b, f); break;
    case "opaque": e.args.forEach((a) => mapExpr(a, f)); break;
    default: break;
  }
}

/** expressions directly owned by a statement / node header */
export function stmtExprs(n: Node): Expr[] {
  switch (n.k) {
    case "assign": return [n.src];
    case "assignm": return [n.src];
    case "store": return [n.addr, n.value];
    case "gset": return [n.value];
    case "expr": return [n.e];
    case "effect": return n.args;
    case "brif": return [n.cond];
    case "brtable": return [n.idx];
    case "return": return n.values;
    case "if": return [n.cond];
    default: return [];
  }
}

/** every wasm offset an expression tree was built from */
export function exprOffs(e: Expr, out = new Set<number>()): Set<number> {
  mapExpr(e, (x) => out.add(x.off));
  return out;
}

export function walkNodes(nodes: Node[], f: (n: Node, depth: number) => void, depth = 0): void {
  for (const n of nodes) {
    f(n, depth);
    if (n.k === "block" || n.k === "loop") walkNodes(n.body, f, depth + 1);
    else if (n.k === "if") { walkNodes(n.then, f, depth + 1); if (n.else) walkNodes(n.else, f, depth + 1); }
  }
}
