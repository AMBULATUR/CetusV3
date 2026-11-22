/**
 * Cetus scripts: a small JavaScript-like language where cheat-table rows are variables.
 *
 *    TextFromAddress = "Text From Script"     // writes a string at the row's address
 *    Health = 999;  Gold += 100               // numbers, compound assignment
 *    if (Health < 50) { freeze(Health, 999) } else unfreeze(Health)
 *    for (let i = 0; i < 5; i++) { Ammo = 30; sleep(200) }
 *    while (true) { Mana = 100; sleep(250) }  // press the hotkey again to stop it
 *
 * It is interpreted (no eval / new Function), so it works on pages whose CSP forbids eval and can be
 * stopped at any time. Loops yield to the event loop so a runaway script never freezes the game.
 */
import type { Chain } from "../shared/addrexpr";

export interface RowDef { name: string; type: string; addr?: number; ptr?: Chain; len?: number; label?: string }

export interface ScriptEnv {
  rows: Map<string, RowDef>;
  addrOf(r: RowDef): number;
  readRow(r: RowDef): any;
  writeRow(r: RowDef, v: any): void;
  readAt(addr: number, type: string): any;
  writeAt(addr: number, type: string, v: any): void;
  readStr(addr: number, enc: "utf8" | "utf16", max: number): string;
  writeStr(addr: number, text: string, enc: "utf8" | "utf16", cap?: number): void;
  freeze(r: RowDef, v?: any): void;
  unfreeze(r: RowDef): void;
  isFrozen(r: RowDef): boolean;
  log(msg: string): void;
  notify(msg: string, kind?: "info" | "ok" | "error"): void;
  call(name: string, args: any[]): any;
}

export class ScriptError extends Error {
  constructor(msg: string, readonly line?: number) { super(line ? `line ${line}: ${msg}` : msg); }
}
class StopSignal extends Error { constructor() { super("stopped"); } }

// ---------------------------------------------------------------- lexer -------
interface Tok { k: "num" | "str" | "id" | "op" | "eof"; v: any; nl: boolean; line: number }

const OPS3 = ["===", "!==", "**="];
const OPS2 = ["==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "**"];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, line = 1, nl = false;
  const push = (k: Tok["k"], v: any) => { out.push({ k, v, nl, line }); nl = false; };
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") { line++; nl = true; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if ((c === "/" && src[i + 1] === "/") || c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) throw new ScriptError("unterminated /* comment", line);
      for (const ch of src.slice(i, e)) if (ch === "\n") { line++; nl = true; }
      i = e + 2; continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:0x[0-9a-f_]+|0b[01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:e[+-]?\d+)?)/i.exec(src.slice(i))!;
      i += m[0].length;
      const t = m[0].replace(/_/g, "");
      push("num", /^0b/i.test(t) ? parseInt(t.slice(2), 2) : Number(t));
      continue;
    }
    if (c === '"' || c === "'") {
      let s = ""; i++;
      for (;;) {
        if (i >= src.length || src[i] === "\n") throw new ScriptError("unterminated string", line);
        const d = src[i++]!;
        if (d === c) break;
        if (d === "\\") {
          const e = src[i++]!;
          if (e === "n") s += "\n"; else if (e === "t") s += "\t"; else if (e === "r") s += "\r"; else if (e === "0") s += "\0";
          else if (e === "x") { s += String.fromCharCode(parseInt(src.substr(i, 2), 16)); i += 2; }
          else if (e === "u") { s += String.fromCharCode(parseInt(src.substr(i, 4), 16)); i += 4; }
          else s += e;
        } else s += d;
      }
      push("str", s); continue;
    }
    const idm = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(src.slice(i));
    if (idm) { i += idm[0].length; push("id", idm[0]); continue; }
    const three = src.substr(i, 3), two = src.substr(i, 2);
    if (OPS3.includes(three)) { push("op", three); i += 3; continue; }
    if (OPS2.includes(two)) { push("op", two); i += 2; continue; }
    if ("+-*/%<>=!?:(),;{}.[]".includes(c)) { push("op", c); i++; continue; }
    throw new ScriptError(`unexpected character '${c}'`, line);
  }
  out.push({ k: "eof", v: null, nl: true, line });
  return out;
}

// ---------------------------------------------------------------- parser ------
type Expr =
  | { t: "lit"; v: any } | { t: "id"; name: string; line: number }
  | { t: "un"; op: string; e: Expr } | { t: "bin"; op: string; l: Expr; r: Expr }
  | { t: "log"; op: string; l: Expr; r: Expr } | { t: "cond"; c: Expr; a: Expr; b: Expr }
  | { t: "assign"; op: string; name: string; e: Expr; line: number }
  | { t: "upd"; op: string; prefix: boolean; name: string; line: number }
  | { t: "call"; name: string; args: Expr[]; line: number } | { t: "member"; obj: Expr; prop: string; line: number };
type Stmt =
  | { t: "expr"; e: Expr } | { t: "let"; name: string; e: Expr | null }
  | { t: "if"; c: Expr; a: Stmt; b: Stmt | null } | { t: "while"; c: Expr; body: Stmt }
  | { t: "for"; init: Stmt | null; c: Expr | null; step: Expr | null; body: Stmt }
  | { t: "block"; body: Stmt[] } | { t: "break" } | { t: "continue" } | { t: "return"; e: Expr | null };

const KEYWORDS = new Set(["if", "else", "while", "for", "let", "var", "const", "break", "continue", "return", "true", "false", "null", "undefined"]);

class Parser {
  p = 0;
  constructor(readonly t: Tok[]) {}
  private get cur() { return this.t[this.p]!; }
  private err(m: string, tok = this.cur): never { throw new ScriptError(m, tok.line); }
  private atEof(): boolean { return this.t[this.p]!.k === "eof"; }
  private isIdent(): boolean { return this.t[this.p]!.k === "id"; }
  private isOp(v: string) { return this.cur.k === "op" && this.cur.v === v; }
  private isId(v: string) { return this.cur.k === "id" && this.cur.v === v; }
  private eat(v: string): boolean { if (this.isOp(v)) { this.p++; return true; } return false; }
  private expect(v: string) { if (!this.eat(v)) this.err(`expected '${v}' but found ${this.atEof() ? "end of script" : "'" + this.cur.v + "'"}`); }

  program(): Stmt[] {
    const out: Stmt[] = [];
    while (this.cur.k !== "eof") out.push(this.stmt());
    return out;
  }
  private endStmt() {
    if (this.eat(";")) return;
    if (this.cur.k === "eof" || this.isOp("}") || this.cur.nl) return;
    this.err(`unexpected '${this.cur.v}' — missing ';' or newline?`);
  }
  private stmt(): Stmt {
    if (this.eat(";")) return { t: "block", body: [] };
    if (this.isOp("{")) return this.block();
    if (this.cur.k === "id") {
      switch (this.cur.v) {
        case "if": { this.p++; this.expect("("); const c = this.expr(); this.expect(")"); const a = this.stmt(); let b: Stmt | null = null; if (this.isId("else")) { this.p++; b = this.stmt(); } return { t: "if", c, a, b }; }
        case "while": { this.p++; this.expect("("); const c = this.expr(); this.expect(")"); return { t: "while", c, body: this.stmt() }; }
        case "for": {
          this.p++; this.expect("(");
          let init: Stmt | null = null;
          if (!this.isOp(";")) init = this.isLet() ? this.letStmt(false) : { t: "expr", e: this.expr() };
          this.expect(";");
          const c = this.isOp(";") ? null : this.expr(); this.expect(";");
          const step = this.isOp(")") ? null : this.expr(); this.expect(")");
          return { t: "for", init, c, step, body: this.stmt() };
        }
        case "let": case "var": case "const": return this.letStmt(true);
        case "break": this.p++; this.endStmt(); return { t: "break" };
        case "continue": this.p++; this.endStmt(); return { t: "continue" };
        case "return": { this.p++; const e = this.isOp(";") || this.isOp("}") || this.cur.nl || this.atEof() ? null : this.expr(); this.endStmt(); return { t: "return", e }; }
        case "else": this.err("'else' without 'if'");
      }
    }
    const e = this.expr();
    this.endStmt();
    return { t: "expr", e };
  }
  private isLet() { return this.cur.k === "id" && ["let", "var", "const"].includes(this.cur.v); }
  private letStmt(end: boolean): Stmt {
    this.p++;
    if (this.cur.k !== "id" || KEYWORDS.has(this.cur.v)) this.err("expected a variable name");
    const name = this.cur.v as string; this.p++;
    let e: Expr | null = null;
    if (this.eat("=")) e = this.expr();
    if (end) this.endStmt();
    return { t: "let", name, e };
  }
  private block(): Stmt {
    this.expect("{");
    const body: Stmt[] = [];
    while (!this.isOp("}")) { if (this.cur.k === "eof") this.err("missing '}'"); body.push(this.stmt()); }
    this.p++;
    return { t: "block", body };
  }

  expr(): Expr { return this.assignment(); }
  private assignment(): Expr {
    const left = this.ternary();
    if (this.cur.k === "op" && ["=", "+=", "-=", "*=", "/=", "%=", "**="].includes(this.cur.v)) {
      const op = this.cur.v as string, tok = this.cur;
      if (left.t !== "id") this.err("the left side of an assignment must be a row or variable name", tok);
      this.p++;
      return { t: "assign", op, name: left.name, e: this.assignment(), line: tok.line };
    }
    return left;
  }
  private ternary(): Expr {
    const c = this.logic(0);
    if (this.eat("?")) { const a = this.assignment(); this.expect(":"); const b = this.assignment(); return { t: "cond", c, a, b }; }
    return c;
  }
  private static LEVELS: string[][] = [["||"], ["&&"], ["==", "!=", "===", "!=="], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/", "%"]];
  private logic(level: number): Expr {
    if (level >= Parser.LEVELS.length) return this.unary();
    let l = this.logic(level + 1);
    while (this.cur.k === "op" && Parser.LEVELS[level]!.includes(this.cur.v)) {
      const op = this.cur.v as string; this.p++;
      const r = this.logic(level + 1);
      l = level <= 1 ? { t: "log", op, l, r } : { t: "bin", op, l, r };
    }
    return l;
  }
  private unary(): Expr {
    if (this.cur.k === "op") {
      const v = this.cur.v as string, tok = this.cur;
      if (v === "!" || v === "-" || v === "+") { this.p++; return { t: "un", op: v, e: this.unary() }; }
      if (v === "++" || v === "--") {
        this.p++;
        if (!this.isIdent()) this.err(`'${v}' needs a variable`);
        const name = this.cur.v as string; this.p++;
        return { t: "upd", op: v, prefix: true, name, line: tok.line };
      }
    }
    return this.power();
  }
  private power(): Expr {
    const b = this.postfix();
    if (this.eat("**")) return { t: "bin", op: "**", l: b, r: this.unary() };
    return b;
  }
  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.isOp("(") && !this.cur.nl && e.t === "id") {
        const line = this.cur.line; this.p++;
        const args: Expr[] = [];
        if (!this.isOp(")")) { do { args.push(this.expr()); } while (this.eat(",")); }
        this.expect(")");
        e = { t: "call", name: e.name, args, line };
      } else if (this.isOp(".")) {
        this.p++;
        if (this.cur.k !== "id") this.err("expected a property name");
        e = { t: "member", obj: e, prop: this.cur.v as string, line: this.cur.line }; this.p++;
      } else if ((this.isOp("++") || this.isOp("--")) && !this.cur.nl && e.t === "id") {
        const op = this.cur.v as string; this.p++;
        e = { t: "upd", op, prefix: false, name: e.name, line: this.cur.line };
      } else return e;
    }
  }
  private primary(): Expr {
    const t = this.cur;
    if (t.k === "num" || t.k === "str") { this.p++; return { t: "lit", v: t.v }; }
    if (t.k === "id") {
      this.p++;
      if (t.v === "true") return { t: "lit", v: true };
      if (t.v === "false") return { t: "lit", v: false };
      if (t.v === "null") return { t: "lit", v: null };
      if (t.v === "undefined") return { t: "lit", v: undefined };
      if (KEYWORDS.has(t.v)) this.err(`unexpected keyword '${t.v}'`, t);
      return { t: "id", name: t.v, line: t.line };
    }
    if (this.eat("(")) { const e = this.expr(); this.expect(")"); return e; }
    this.err(t.k === "eof" ? "unexpected end of script" : `unexpected '${t.v}'`);
  }
}

/** Synchronous evaluation of a boolean condition such as `ea == 0x7d0 && value > 100` (used by breakpoints). */
export function compileCondition(src: string, allowed: string[]): (vars: Record<string, number>) => boolean {
  const toks = lex(src);
  const p = new Parser(toks);
  const e = p.expr();
  if (toks[p.p]!.k !== "eof") throw new ScriptError(`unexpected '${toks[p.p]!.v}' in condition`, toks[p.p]!.line);
  const ev = (x: Expr, v: Record<string, number>): any => {
    switch (x.t) {
      case "lit": return x.v;
      case "id": if (!allowed.includes(x.name)) throw new ScriptError(`unknown name '${x.name}' (available: ${allowed.join(", ")})`); return v[x.name];
      case "un": { const a = ev(x.e, v); return x.op === "!" ? !a : x.op === "-" ? -a : +a; }
      case "bin": {
        const l = ev(x.l, v), r = ev(x.r, v);
        switch (x.op) {
          case "+": return l + r; case "-": return l - r; case "*": return l * r; case "/": return l / r; case "%": return l % r;
          case "<": return l < r; case ">": return l > r; case "<=": return l <= r; case ">=": return l >= r;
          case "==": case "===": return l === r; case "!=": case "!==": return l !== r;
        }
        throw new ScriptError("operator " + x.op + " is not allowed in conditions");
      }
      case "log": { const l = ev(x.l, v); return x.op === "&&" ? (l ? ev(x.r, v) : l) : (l ? l : ev(x.r, v)); }
      case "cond": return ev(x.c, v) ? ev(x.a, v) : ev(x.b, v);
      default: throw new ScriptError("only comparisons, arithmetic and && || ! are allowed in conditions");
    }
  };
  ev(e, Object.fromEntries(allowed.map((n) => [n, 0]))); // validate names/operators now
  return (vars) => !!ev(e, vars);
}

export function parseScript(src: string): Stmt[] {
  return new Parser(lex(src)).program();
}

// ---------------------------------------------------------------- runtime -----
function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
}

export class RowRef { constructor(readonly def: RowDef) {} }

const isStr = (t: string) => t === "str8" || t === "str16";

type Sig = "break" | "continue" | "return" | null;

export class ScriptRun {
  private scopes: Map<string, any>[] = [new Map()];
  private steps = 0;
  private lastYield = performance.now();
  private stopped = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private wake = new Set<() => void>();
  returned: any = undefined;
  readonly started = Date.now();

  constructor(readonly env: ScriptEnv) {}

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const w of this.wake) w();
    this.wake.clear();
  }

  async run(src: string): Promise<void> {
    const prog = parseScript(src);
    try {
      for (const s of prog) { const sig = await this.exec(s); if (sig === "return") break; }
    } catch (e) {
      if (e instanceof StopSignal) return;
      throw e;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) throw new StopSignal();
    // never starve the game: hand control back to the event loop every ~8 ms of work
    if ((++this.steps & 127) === 0 && performance.now() - this.lastYield > 8) {
      await new Promise<void>((r) => setTimeout(r, 0));
      this.lastYield = performance.now();
    }
    if (this.stopped) throw new StopSignal();
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stopped) return resolve();
      const t = setTimeout(() => { this.timers.delete(t); this.wake.delete(resolve); resolve(); }, Math.max(0, Math.min(ms, 3_600_000)));
      this.timers.add(t);
      this.wake.add(resolve);
    }).then(() => { if (this.stopped) throw new StopSignal(); });
  }

  // ---- scopes
  private lookup(name: string): Map<string, any> | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i]!.has(name)) return this.scopes[i]!;
    return null;
  }
  private unknown(name: string, line?: number): never {
    const names = [...this.env.rows.keys()];
    const lo = name.toLowerCase();
    const near = names
      .map((n) => ({ n, d: lev(n.toLowerCase(), lo), sub: n.toLowerCase().includes(lo) || lo.includes(n.toLowerCase()) }))
      .filter((x) => x.sub || x.d <= Math.max(2, Math.floor(name.length / 3)))
      .sort((a, b) => a.d - b.d).slice(0, 3).map((x) => x.n);
    throw new ScriptError(`unknown name '${name}'. ` + (near.length ? `Did you mean ${near.join(", ")}? ` : "") + (names.length ? `Rows in the cheat table: ${names.slice(0, 12).join(", ")}${names.length > 12 ? "…" : ""}` : "The cheat table has no named rows (give rows a description)."), line);
  }

  // ---- statements
  private async exec(s: Stmt): Promise<Sig> {
    await this.tick();
    switch (s.t) {
      case "expr": await this.ev(s.e); return null;
      case "let": this.scopes[this.scopes.length - 1]!.set(s.name, s.e ? await this.ev(s.e) : undefined); return null;
      case "block": {
        this.scopes.push(new Map());
        try { for (const x of s.body) { const sig = await this.exec(x); if (sig) return sig; } } finally { this.scopes.pop(); }
        return null;
      }
      case "if": return (this.truthy(await this.ev(s.c))) ? this.exec(s.a) : s.b ? this.exec(s.b) : null;
      case "while":
        while (this.truthy(await this.ev(s.c))) {
          const sig = await this.exec(s.body);
          if (sig === "break") break;
          if (sig === "return") return sig;
          await this.tick();
        }
        return null;
      case "for": {
        this.scopes.push(new Map());
        try {
          if (s.init) await this.exec(s.init);
          while (!s.c || this.truthy(await this.ev(s.c))) {
            const sig = await this.exec(s.body);
            if (sig === "break") break;
            if (sig === "return") return sig;
            if (s.step) await this.ev(s.step);
            await this.tick();
          }
        } finally { this.scopes.pop(); }
        return null;
      }
      case "break": return "break";
      case "continue": return "continue";
      case "return": this.returned = s.e ? await this.ev(s.e) : undefined; return "return";
    }
  }
  private truthy(v: any): boolean { return v instanceof RowRef ? !!this.env.readRow(v.def) : !!v; }

  // ---- expressions
  private val(v: any): any { return v instanceof RowRef ? this.env.readRow(v.def) : v; }

  private async ev(e: Expr): Promise<any> {
    switch (e.t) {
      case "lit": return e.v;
      case "id": {
        const sc = this.lookup(e.name);
        if (sc) return sc.get(e.name);
        const r = this.env.rows.get(e.name);
        if (r) return this.env.readRow(r);
        if (e.name === "NaN") return NaN;
        if (e.name === "Infinity") return Infinity;
        if (e.name === "PI") return Math.PI;
        return this.unknown(e.name, e.line);
      }
      case "un": {
        const v = this.val(await this.ev(e.e));
        return e.op === "!" ? !v : e.op === "-" ? -v : +v;
      }
      case "bin": return this.binop(e.op, this.val(await this.ev(e.l)), this.val(await this.ev(e.r)));
      case "log": {
        const l = this.val(await this.ev(e.l));
        if (e.op === "&&") return l ? this.val(await this.ev(e.r)) : l;
        return l ? l : this.val(await this.ev(e.r));
      }
      case "cond": return this.truthy(await this.ev(e.c)) ? this.ev(e.a) : this.ev(e.b);
      case "assign": {
        let v = this.val(await this.ev(e.e));
        if (e.op !== "=") v = this.binop(e.op.slice(0, -1), this.val(await this.ev({ t: "id", name: e.name, line: e.line })), v);
        this.store(e.name, v, e.line);
        return v;
      }
      case "upd": {
        const old = Number(this.val(await this.ev({ t: "id", name: e.name, line: e.line })));
        const nv = e.op === "++" ? old + 1 : old - 1;
        this.store(e.name, nv, e.line);
        return e.prefix ? nv : old;
      }
      case "member": {
        // `Health.addr` must see the row itself, not its current value
        const o = e.obj.t === "id" && !this.lookup(e.obj.name) && this.env.rows.has(e.obj.name) ? new RowRef(this.env.rows.get(e.obj.name)!) : await this.ev(e.obj);
        if (o instanceof RowRef) return this.prop(o, e.prop, e.line);
        if (typeof o === "string" && e.prop === "length") return o.length;
        throw new ScriptError(`cannot read property '${e.prop}'`, e.line);
      }
      case "call": return this.call(e);
    }
  }

  private store(name: string, v: any, line?: number): void {
    const sc = this.lookup(name);
    if (sc) { sc.set(name, v); return; }
    const r = this.env.rows.get(name);
    if (!r) this.unknown(name, line);
    try { this.env.writeRow(r!, v); } catch (er) { if (er instanceof ScriptError) throw er; throw new ScriptError(`${name}: ${(er as Error).message}`, line); }
  }

  private prop(r: RowRef, p: string, line: number): any {
    switch (p) {
      case "addr": case "address": return this.env.addrOf(r.def);
      case "type": return r.def.type;
      case "name": return r.def.name;
      case "value": return this.env.readRow(r.def);
      case "frozen": return this.env.isFrozen(r.def);
      case "len": return r.def.len;
    }
    throw new ScriptError(`rows have no property '${p}' (addr, type, name, value, frozen)`, line);
  }

  private binop(op: string, l: any, r: any): any {
    switch (op) {
      case "+": return l + r; case "-": return l - r; case "*": return l * r; case "/": return l / r; case "%": return l % r; case "**": return l ** r;
      case "<": return l < r; case ">": return l > r; case "<=": return l <= r; case ">=": return l >= r;
      case "==": return l == r; case "!=": return l != r; case "===": return l === r; case "!==": return l !== r; // eslint-disable-line eqeqeq
    }
    throw new ScriptError("unknown operator " + op);
  }

  private async call(e: Extract<Expr, { t: "call" }>): Promise<any> {
    const b = BUILTINS[e.name];
    if (!b) throw new ScriptError(`unknown function '${e.name}'. Available: ${Object.keys(BUILTINS).join(", ")}`, e.line);
    const args: any[] = [];
    for (let i = 0; i < e.args.length; i++) {
      const a = e.args[i]!;
      if (b.refs?.includes(i) && a.t === "id" && !this.lookup(a.name) && this.env.rows.has(a.name)) args.push(new RowRef(this.env.rows.get(a.name)!));
      else args.push(await this.ev(a));
    }
    try { return await b.fn(this, args); } catch (er) {
      if (er instanceof StopSignal || er instanceof ScriptError) throw er;
      throw new ScriptError(`${e.name}(): ${(er as Error).message}`, e.line);
    }
  }

  // ---- helpers for builtins
  def(x: any): RowDef {
    if (x instanceof RowRef) return x.def;
    if (typeof x === "string") { const r = this.env.rows.get(x) ?? [...this.env.rows.values()].find((d) => d.label === x); if (r) return r.type ? r : r; }
    throw new Error("expected a cheat-table row (pass the row name, e.g. freeze(Health))");
  }
  target(x: any): { addr: number; def?: RowDef } {
    if (x instanceof RowRef) return { addr: this.env.addrOf(x.def), def: x.def };
    if (typeof x === "number") return { addr: x };
    if (typeof x === "string") { const d = this.def(x); return { addr: this.env.addrOf(d), def: d }; }
    throw new Error("expected a row or an address");
  }
}

const num = (x: any): number => { const v = x instanceof RowRef ? NaN : Number(x); if (Number.isNaN(v)) throw new Error("expected a number"); return v; };
const fmtLog = (v: any): string => (typeof v === "string" ? v : v instanceof RowRef ? `<row ${v.def.name}>` : typeof v === "number" && !Number.isInteger(v) ? String(+v.toFixed(6)) : String(v));

interface Builtin { refs?: number[]; fn: (it: ScriptRun, a: any[]) => any }
const BUILTINS: Record<string, Builtin> = {
  sleep: { fn: (it, a) => it.sleep(num(a[0] ?? 0)) },
  log: { fn: (it, a) => { it.env.log(a.map((x) => fmtLog(it["val"](x))).join(" ")); } },
  toast: { fn: (it, a) => { it.env.notify(a.map((x) => fmtLog(it["val"](x))).join(" "), "info"); } },
  notify: { fn: (it, a) => { it.env.notify(a.map((x) => fmtLog(it["val"](x))).join(" "), "info"); } },
  stop: { fn: (it) => { it.stop(); throw new StopSignal(); } },
  row: { fn: (it, a) => new RowRef(it.def(String(a[0]))) },
  freeze: { refs: [0], fn: (it, a) => { const d = it.def(a[0]); it.env.freeze(d, a.length > 1 ? it["val"](a[1]) : undefined); } },
  unfreeze: { refs: [0], fn: (it, a) => { it.env.unfreeze(it.def(a[0])); } },
  toggle: { refs: [0], fn: (it, a) => { const d = it.def(a[0]); if (it.env.isFrozen(d)) { it.env.unfreeze(d); return false; } it.env.freeze(d); return true; } },
  frozen: { refs: [0], fn: (it, a) => it.env.isFrozen(it.def(a[0])) },
  addr: { refs: [0], fn: (it, a) => it.target(a[0]).addr },
  read: { refs: [0], fn: (it, a) => { const t = it.target(a[0]); const type = a[1] !== undefined ? String(a[1]) : t.def?.type; if (!type) throw new Error("read(address, type) needs a type"); return it.env.readAt(t.addr, type); } },
  write: { refs: [0], fn: (it, a) => {
    const t = it.target(a[0]);
    if (t.def && a.length === 2) { it.env.writeRow(t.def, it["val"](a[1])); return; }
    it.env.writeAt(t.addr, String(a[1]), it["val"](a[2]));
  } },
  str: { refs: [0], fn: (it, a) => { const t = it.target(a[0]); const enc = a[1] === "utf16" || t.def?.type === "str16" ? "utf16" : "utf8"; return it.env.readStr(t.addr, enc, a[2] !== undefined ? num(a[2]) : t.def?.len ?? 256); } },
  setStr: { refs: [0], fn: (it, a) => { const t = it.target(a[0]); const enc = a[2] === "utf16" || t.def?.type === "str16" ? "utf16" : "utf8"; it.env.writeStr(t.addr, String(it["val"](a[1])), enc, a[3] !== undefined ? num(a[3]) : t.def?.len); } },
  call: { fn: (it, a) => it.env.call(String(a[0]), a.slice(1).map((x) => it["val"](x))) },
  hex: { fn: (it, a) => "0x" + (num(it["val"](a[0])) >>> 0).toString(16).padStart(a[1] !== undefined ? num(a[1]) : 0, "0") },
  int: { fn: (it, a) => Math.trunc(num(it["val"](a[0]))) },
  float: { fn: (it, a) => num(it["val"](a[0])) },
  number: { fn: (it, a) => Number(it["val"](a[0])) },
  string: { fn: (it, a) => String(it["val"](a[0])) },
  len: { fn: (it, a) => String(it["val"](a[0])).length },
  floor: { fn: (it, a) => Math.floor(num(it["val"](a[0]))) },
  ceil: { fn: (it, a) => Math.ceil(num(it["val"](a[0]))) },
  round: { fn: (it, a) => Math.round(num(it["val"](a[0]))) },
  abs: { fn: (it, a) => Math.abs(num(it["val"](a[0]))) },
  sqrt: { fn: (it, a) => Math.sqrt(num(it["val"](a[0]))) },
  pow: { fn: (it, a) => Math.pow(num(it["val"](a[0])), num(it["val"](a[1]))) },
  min: { fn: (it, a) => Math.min(...a.map((x) => num(it["val"](x)))) },
  max: { fn: (it, a) => Math.max(...a.map((x) => num(it["val"](x)))) },
  rand: { fn: (it, a) => { const lo = a.length > 1 ? num(it["val"](a[0])) : 0; const hi = a.length > 1 ? num(it["val"](a[1])) : a.length ? num(it["val"](a[0])) : 1; return a.length ? Math.floor(lo + Math.random() * (hi - lo + 1)) : Math.random(); } },
  now: { fn: () => Date.now() },
};
export const BUILTIN_NAMES = Object.keys(BUILTINS);

/** Turn a row description into a script identifier ("Max Health" -> Max_Health). */
export function rowIdentifier(label: string): string {
  let s = label.trim().replace(/[^\p{L}\p{N}_$]+/gu, "_").replace(/^_+|_+$/g, "");
  if (!s) return "";
  if (/^[0-9]/.test(s)) s = "_" + s;
  if (KEYWORDS.has(s) || BUILTINS[s]) s += "_";
  return s;
}
export { isStr };
