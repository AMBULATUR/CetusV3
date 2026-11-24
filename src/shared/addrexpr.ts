/**
 * Address expressions as used in cheat engines:
 *    0x1234                         plain address
 *    0x1000+0x20                    arithmetic
 *    [0x4a2220]+0x34                one pointer hop
 *    [[[[0x4a2220]+0x34]+0x24]+0xd8]+0x18
 * Each pair of brackets reads a 32-bit pointer; the offset after a closing bracket is added to the value read.
 * The result is a Chain: read u32 at `base`, then for every offset except the last read u32 at (value+offset);
 * the final address is value + lastOffset.
 */
export interface Chain {
  base: number;
  offsets: number[];
  /** rooted in this Wasm global (written `$g12`) instead of a memory cell; `base` is -1 */
  global?: number;
}
export type AddrExpr = { kind: "addr"; addr: number } | { kind: "ptr"; chain: Chain };

type Node = { t: "num"; v: number } | { t: "glob"; i: number } | { t: "deref"; e: Node } | { t: "add"; l: Node; k: number };
type Op = { d: true } | { a: number };

class Parser {
  i = 0;
  constructor(readonly s: string) {}
  private ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++; }
  private peek() { this.ws(); return this.s[this.i]; }
  private err(m: string): never { throw new Error(`${m} at position ${this.i + 1} of "${this.s}"`); }

  parse(): Node {
    const n = this.expr();
    this.ws();
    if (this.i < this.s.length) this.err(`unexpected '${this.s[this.i]}'`);
    return n;
  }
  private expr(): Node {
    let n = this.term();
    for (;;) {
      const c = this.peek();
      if (c !== "+" && c !== "-") return n;
      this.i++;
      const r = this.term();
      if (r.t !== "num") this.err("only constants can be added or subtracted after a pointer read");
      n = { t: "add", l: n, k: c === "-" ? -r.v : r.v };
    }
  }
  private term(): Node {
    const c = this.peek();
    if (c === "[") {
      this.i++;
      const e = this.expr();
      if (this.peek() !== "]") this.err("missing ]");
      this.i++;
      return { t: "deref", e };
    }
    if (c === "(") {
      this.i++;
      const e = this.expr();
      if (this.peek() !== ")") this.err("missing )");
      this.i++;
      return e;
    }
    this.ws();
    const gm = /^\$?g(\d+)\b/i.exec(this.s.slice(this.i));
    if (gm && (this.s[this.i] === "$" || /^g\d/i.test(this.s.slice(this.i)))) { this.i += gm[0].length; return { t: "glob", i: Number(gm[1]) }; }
    const m = /^(?:0x[0-9a-f_]+|[0-9][0-9a-f]*h(?![0-9a-z])|\d[\d_]*)/i.exec(this.s.slice(this.i));
    if (!m) this.err("expected a number or [");
    this.i += m![0].length;
    const t = m![0].replace(/_/g, "");
    return { t: "num", v: /h$/i.test(t) ? parseInt(t.slice(0, -1), 16) : /^0x/i.test(t) ? parseInt(t, 16) : parseInt(t, 10) };
  }
}

/** Evaluate left to right: returns the base number and the ordered pointer-read / add operations. */
function walk(n: Node, ops: Op[]): number {
  if (n.t === "glob") throw new Error("global roots are handled separately");
  if (n.t === "num") return n.v;
  if (n.t === "deref") {
    const b = walk(n.e, ops);
    ops.push({ d: true });
    return b;
  }
  const b = walk(n.l, ops);
  if (ops.length === 0) return b + n.k; // plain arithmetic before the first pointer read
  ops.push({ a: n.k });
  return b;
}

/** `[$g12+0x34]+0x18`: value of Wasm global 12, +0x34, read a pointer, +0x18 */
function globalRoot(n: Node, ops: Op[]): number | null {
  if (n.t === "glob") return n.i;
  if (n.t === "num") return null;
  const r = globalRoot(n.t === "deref" ? n.e : n.l, ops);
  if (r === null) return null;
  ops.push(n.t === "deref" ? { d: true } : { a: n.k });
  return r;
}

export function parseAddressExpr(text: string): AddrExpr {
  const s = text.trim();
  if (!s) throw new Error("empty address");
  const tree = new Parser(s).parse();
  const gops: Op[] = [];
  const g = globalRoot(tree, gops);
  if (g !== null) {
    const offsets: number[] = [];
    let cur = 0;
    for (const o of gops) { if ("d" in o) { offsets.push(cur); cur = 0; } else cur += o.a; }
    offsets.push(cur);
    return { kind: "ptr", chain: { base: -1, global: g, offsets } };
  }
  const ops: Op[] = [];
  const base = walk(tree, ops);
  if (!ops.length) return { kind: "addr", addr: base };
  const offsets: number[] = [];
  for (const o of ops) {
    if ("d" in o) offsets.push(0);
    else offsets[offsets.length - 1] = offsets[offsets.length - 1]! + o.a;
  }
  return { kind: "ptr", chain: { base, offsets } };
}

export function formatChain(c: Chain): string {
  const h = (n: number) => (n < 0 ? "-0x" + (-n).toString(16) : "+0x" + n.toString(16));
  let s = c.global !== undefined ? `$g${c.global}` : `[0x${c.base.toString(16)}]`;
  for (let i = 0; i < c.offsets.length - 1; i++) s = `[${s}${h(c.offsets[i]!)}]`;
  const last = c.offsets[c.offsets.length - 1]!;
  return last === 0 ? s : `${s}${h(last)}`;
}
