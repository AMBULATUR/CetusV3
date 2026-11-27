/**
 * Project-level annotation database.
 *
 * One database per WASM *module* (identified by a hash of its bytes), not per function and not per page: rename
 * func_1986 once and every function that calls it shows the new name; a string at 320855 has one annotation, shared
 * by every instruction that points at it. Annotations are stored beside the module, never inside it: the binary is
 * never modified.
 *
 * Every name carries a confidence. `confirmed` = the user is sure (or the module itself says so, e.g. the name
 * section); `inferred` = a guess. Nothing is ever invented: with no annotation the renderers print what the binary says.
 */
import type { Conf, Resolver, UserSig } from "./render";

export interface Named { name?: string; conf?: Conf; comment?: string }
export interface VarAnn { name?: string; type?: string }
export interface FuncAnn extends Named { sig?: UserSig; vars?: Record<string, VarAnn> }
export interface InsAnn { comment?: string; /** replaces the i32 constant at this instruction */ name?: string; conf?: Conf }
export interface FieldAnn extends Named { type?: string }

export interface AnnotationDB {
  version: 1;
  moduleId: string;
  updated: number;
  funcs: Record<string, FuncAnn>;
  /** i32 constants named by VALUE (applies to every use of the value) */
  consts: Record<string, Named>;
  /** string / data addresses: one shared label + comment per address */
  strings: Record<string, Named>;
  /** struct field offsets (`ptr + 140`): shared by every access with that static offset */
  fields: Record<string, FieldAnn>;
  globals: Record<string, Named>;
  /** instruction level, keyed `func:off` (off = function-relative offset shown as +001a) */
  ins: Record<string, InsAnn>;
}

export const emptyDB = (moduleId: string): AnnotationDB => ({ version: 1, moduleId, updated: 0, funcs: {}, consts: {}, strings: {}, fields: {}, globals: {}, ins: {} });

/** Fast non-cryptographic identity of a module: length + two independent 32-bit hash lanes over every byte. */
export function moduleIdentity(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5 | 0, h2 = 0x9747b28c | 0;
  const n = bytes.length;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n);
  const w = n >> 2;
  for (let i = 0; i < w; i++) {
    const k = dv.getUint32(i << 2, true);
    h1 = Math.imul(h1 ^ k, 0x01000193);
    h1 = (h1 << 13) | (h1 >>> 19);
    h2 = Math.imul(h2 + k | 0, 0x85ebca6b) ^ (h2 >>> 15);
    h2 = Math.imul(h2, 0xc2b2ae35);
  }
  for (let i = w << 2; i < n; i++) { h1 = Math.imul(h1 ^ bytes[i]!, 0x01000193); h2 = Math.imul(h2 + bytes[i]! | 0, 0x85ebca6b); }
  const hx = (x: number) => (x >>> 0).toString(16).padStart(8, "0");
  return `${n.toString(16)}-${hx(h1)}${hx(h2)}`;
}

export interface SymbolRow { kind: "function" | "string" | "constant" | "field" | "global" | "variable"; key: string; name: string; conf: Conf; where: string; comment?: string }

const clean = <T extends Named>(o: T): T | null => (o.name || o.comment ? o : null);

/** The database plus the Resolver the renderers use. All mutators fire `onChange` so views can re-render. */
export class Annotations implements Resolver {
  private listeners = new Set<() => void>();
  constructor(public db: AnnotationDB) {}
  onChange(f: () => void): () => void { this.listeners.add(f); return () => this.listeners.delete(f); }
  private touch(): void { this.db.updated = Date.now(); for (const f of this.listeners) f(); }

  static fromJSON(json: unknown, moduleId: string): Annotations {
    const d = (json && typeof json === "object" ? json : {}) as Partial<AnnotationDB>;
    const db = emptyDB(moduleId);
    if (d.moduleId === moduleId && d.version === 1) {
      for (const k of ["funcs", "consts", "strings", "fields", "globals", "ins"] as const) if (d[k] && typeof d[k] === "object") Object.assign(db[k], d[k]);
      db.updated = d.updated ?? 0;
    }
    return new Annotations(db);
  }
  /** an exported database only applies to the module it was made for */
  static matches(json: unknown, moduleId: string): boolean { return !!json && typeof json === "object" && (json as AnnotationDB).moduleId === moduleId && (json as AnnotationDB).version === 1; }
  isEmpty(): boolean { const d = this.db; return ![d.funcs, d.consts, d.strings, d.fields, d.globals, d.ins].some((m) => Object.keys(m).length); }

  // ---- Resolver
  funcName(idx: number, moduleName: string): { name: string; conf: Conf | "default" } {
    const a = this.db.funcs[idx];
    if (a?.name) return { name: a.name, conf: a.conf ?? "inferred" };
    return { name: moduleName, conf: /^func_\d+$/.test(moduleName) ? "default" : "confirmed" };
  }
  funcSig(idx: number): UserSig | undefined { return this.db.funcs[idx]?.sig; }
  funcComment(idx: number): string | undefined { return this.db.funcs[idx]?.comment; }
  varName(func: number, id: string): string | undefined { return this.db.funcs[func]?.vars?.[id]?.name; }
  varType(func: number, id: string): string | undefined { return this.db.funcs[func]?.vars?.[id]?.type; }
  constName(func: number, off: number, value: number): { name: string; conf: Conf; shared: boolean } | undefined {
    const i = this.db.ins[`${func}:${off}`];
    if (i?.name) return { name: i.name, conf: i.conf ?? "inferred", shared: false };
    const c = this.db.consts[value >>> 0];
    if (c?.name) return { name: c.name, conf: c.conf ?? "inferred", shared: true };
    return undefined;
  }
  stringLabel(addr: number): { name: string; conf: Conf } | undefined { const s = this.db.strings[addr >>> 0]; return s?.name ? { name: s.name, conf: s.conf ?? "inferred" } : undefined; }
  fieldName(offset: number): { name: string; conf: Conf } | undefined { const s = this.db.fields[offset]; return s?.name ? { name: s.name, conf: s.conf ?? "inferred" } : undefined; }
  globalName(idx: number): { name: string; conf: Conf } | undefined { const s = this.db.globals[idx]; return s?.name ? { name: s.name, conf: s.conf ?? "inferred" } : undefined; }
  insComment(func: number, off: number): string | undefined { return this.db.ins[`${func}:${off}`]?.comment; }
  constComment(value: number): string | undefined { return this.db.consts[value >>> 0]?.comment ?? this.db.strings[value >>> 0]?.comment; }

  // ---- mutators (an empty name / comment removes the entry)
  private put<T extends Named>(m: Record<string, T>, key: string | number, patch: Partial<T>): void {
    const k = String(key);
    const cur = { ...(m[k] ?? {}) } as T;
    for (const [pk, pv] of Object.entries(patch)) { if (pv === undefined || pv === "") delete (cur as Record<string, unknown>)[pk]; else (cur as Record<string, unknown>)[pk] = pv; }
    if (!cur.name) delete cur.conf;
    const keep = Object.keys(cur).length ? cur : null;
    if (keep) m[k] = keep; else delete m[k];
    this.touch();
  }
  setFuncName(idx: number, name: string, conf: Conf = "inferred"): void { this.put(this.db.funcs, idx, { name: name.trim(), conf }); }
  setFuncComment(idx: number, comment: string): void { this.put(this.db.funcs, idx, { comment }); }
  setFuncSig(idx: number, sig: UserSig | null): void {
    const cur = this.db.funcs[idx] ?? {};
    if (sig && (sig.ret || sig.params?.length)) cur.sig = sig; else delete cur.sig;
    if (Object.keys(cur).length) this.db.funcs[idx] = cur; else delete this.db.funcs[idx];
    this.touch();
  }
  setVar(func: number, id: string, patch: VarAnn): void {
    const f = (this.db.funcs[func] ??= {});
    const vars = (f.vars ??= {});
    const cur = { ...(vars[id] ?? {}) };
    for (const [k, v] of Object.entries(patch)) { if (!v) delete (cur as Record<string, unknown>)[k]; else (cur as Record<string, unknown>)[k] = v; }
    if (Object.keys(cur).length) vars[id] = cur; else delete vars[id];
    if (!Object.keys(vars).length) delete f.vars;
    if (!Object.keys(f).length) delete this.db.funcs[func];
    this.touch();
  }
  setConst(value: number, patch: Partial<Named>): void { this.put(this.db.consts, value >>> 0, patch); }
  setString(addr: number, patch: Partial<Named>): void { this.put(this.db.strings, addr >>> 0, patch); }
  setField(offset: number, patch: Partial<FieldAnn>): void { this.put(this.db.fields, offset, patch); }
  setGlobal(idx: number, patch: Partial<Named>): void { this.put(this.db.globals, idx, patch); }
  setIns(func: number, off: number, patch: Partial<InsAnn>): void {
    const k = `${func}:${off}`;
    const cur = { ...(this.db.ins[k] ?? {}) };
    for (const [pk, pv] of Object.entries(patch)) { if (!pv) delete (cur as Record<string, unknown>)[pk]; else (cur as Record<string, unknown>)[pk] = pv; }
    if (!cur.name) delete cur.conf;
    if (Object.keys(cur).length) this.db.ins[k] = cur; else delete this.db.ins[k];
    this.touch();
  }
  /** flip confirmed / inferred without retyping the name */
  setConf(kind: SymbolRow["kind"], key: string, conf: Conf): void {
    const tgt = kind === "function" ? this.db.funcs[key] : kind === "string" ? this.db.strings[key] : kind === "constant" ? this.db.consts[key] : kind === "field" ? this.db.fields[key] : kind === "global" ? this.db.globals[key] : this.db.ins[key];
    if (tgt && (tgt as Named).name) { (tgt as Named).conf = conf; this.touch(); }
  }

  /** every name in the project with its confidence (the symbol table view / export header) */
  symbols(): SymbolRow[] {
    const out: SymbolRow[] = [];
    const d = this.db;
    for (const [k, v] of Object.entries(d.funcs)) { if (v.name) out.push({ kind: "function", key: k, name: v.name, conf: v.conf ?? "inferred", where: `func #${k}`, ...(v.comment ? { comment: v.comment } : {}) }); }
    for (const [k, v] of Object.entries(d.strings)) if (v.name) out.push({ kind: "string", key: k, name: v.name, conf: v.conf ?? "inferred", where: "0x" + Number(k).toString(16), ...(v.comment ? { comment: v.comment } : {}) });
    for (const [k, v] of Object.entries(d.consts)) if (v.name) out.push({ kind: "constant", key: k, name: v.name, conf: v.conf ?? "inferred", where: `value ${k} (0x${Number(k).toString(16)})`, ...(v.comment ? { comment: v.comment } : {}) });
    for (const [k, v] of Object.entries(d.fields)) if (v.name) out.push({ kind: "field", key: k, name: v.name, conf: v.conf ?? "inferred", where: `offset +${k}`, ...(v.comment ? { comment: v.comment } : {}) });
    for (const [k, v] of Object.entries(d.globals)) if (v.name) out.push({ kind: "global", key: k, name: v.name, conf: v.conf ?? "inferred", where: `global ${k}` });
    for (const [k, v] of Object.entries(d.funcs)) for (const [id, vv] of Object.entries(v.vars ?? {})) if (vv.name) out.push({ kind: "variable", key: `${k}:${id}`, name: vv.name, conf: "inferred", where: `func #${k} ${id}` });
    return out;
  }
  toJSON(): AnnotationDB { return this.db; }
  /** merge another database of the SAME module (import); `theirs` wins on conflicts */
  merge(other: AnnotationDB): void {
    for (const k of ["funcs", "consts", "strings", "fields", "globals", "ins"] as const) {
      const a = this.db[k] as Record<string, unknown>;
      for (const [key, v] of Object.entries(other[k])) a[key] = { ...(a[key] as object ?? {}), ...(v as object) };
    }
    this.touch();
  }
}
void clean;
