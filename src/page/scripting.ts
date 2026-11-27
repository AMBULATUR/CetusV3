import type { CetusInstance } from "./instance";
import { RowDef, ScriptEnv, ScriptRun, rowIdentifier, ScriptError } from "./script";
import { resolveChain } from "./pointer";
import { readCString, writeCString } from "./cstring";
import { ValType, TYPE_INFO, isValType, readVal, writeVal, parseVal } from "../shared/codec";

export interface ScriptRowIn { label: string; type: string; addr?: number; ptr?: { base: number; offsets: number[]; global?: number }; len?: number }
export interface RunRequest { id: string; name?: string; code: string; rows: ScriptRowIn[]; silent?: boolean }

export function showToast(text: string, kind: "info" | "ok" | "error" = "info", ms = 2200): void {
  try {
    let host = document.getElementById("__cetus_toasts");
    if (!host) {
      host = document.createElement("div");
      host.id = "__cetus_toasts";
      host.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;flex-direction:column;gap:6px;pointer-events:none;font:13px system-ui,sans-serif";
      (document.body ?? document.documentElement).appendChild(host);
    }
    const t = document.createElement("div");
    t.textContent = "Cetus · " + text;
    t.style.cssText = `background:#14161aee;color:#e6e8ec;padding:7px 11px;border-radius:6px;border-left:3px solid ${kind === "error" ? "#ef6b6b" : kind === "ok" ? "#4cc38a" : "#35b9d6"};max-width:420px;box-shadow:0 4px 16px #0008`;
    host.appendChild(t);
    setTimeout(() => t.remove(), kind === "error" ? Math.max(ms, 5000) : ms);
  } catch { /* no DOM yet */ }
}

export interface RunState { id: string; name: string; running: boolean; error: string | null; logs: string[]; started: number; ended: number | null; run: ScriptRun }

export function buildRows(rows: ScriptRowIn[]): Map<string, RowDef> {
  const map = new Map<string, RowDef>();
  for (const r of rows) {
    let id = rowIdentifier(r.label || "");
    if (!id) continue;
    let n = 2; const base = id;
    while (map.has(id)) id = `${base}_${n++}`;
    map.set(id, { name: id, label: r.label, type: r.type, ...(r.addr !== undefined ? { addr: r.addr } : {}), ...(r.ptr ? { ptr: r.ptr } : {}), ...(r.len !== undefined ? { len: r.len } : {}) });
  }
  return map;
}

export function createEnv(inst: CetusInstance, rows: Map<string, RowDef>, st: { logs: string[] }, silent: boolean, globals: Map<string, any> = new Map()): ScriptEnv {
  const buf = () => inst.buf();
  const isText = (t: string) => t === "str8" || t === "str16";
  const addrOf = (r: RowDef): number => {
    if (r.ptr) {
      const a = resolveChain(buf(), r.ptr, (i) => inst.globalValue(i));
      if (a === null) throw new ScriptError(`pointer path of '${r.name}' does not resolve right now (game not in the right state?)`);
      return a;
    }
    if (r.addr === undefined) throw new ScriptError(`row '${r.name}' has no address`);
    return r.addr;
  };
  const num = (r: RowDef, v: any): number | bigint => {
    const t = r.type as ValType;
    if (typeof v === "boolean") v = v ? 1 : 0;
    if (typeof v === "string") return parseVal(t, v);
    if (typeof v !== "number" || Number.isNaN(v)) throw new Error("expected a number");
    if (TYPE_INFO[t].float) return v;
    if (!Number.isFinite(v)) throw new Error("expected a finite number");
    return TYPE_INFO[t].big ? BigInt(Math.trunc(v)) : Math.trunc(v);
  };
  const env: ScriptEnv = {
    rows, addrOf, globals,
    readRow(r) {
      const a = addrOf(r);
      if (isText(r.type)) return readCString(buf(), a, r.type === "str16" ? "utf16" : "utf8", r.len ?? 256);
      if (!isValType(r.type)) throw new Error(`unknown row type ${r.type}`);
      const v = readVal(inst.dv(), a, r.type);
      return typeof v === "bigint" ? Number(v) : v;
    },
    writeRow(r, v) {
      const a = addrOf(r);
      if (isText(r.type)) { writeCString(buf(), a, typeof v === "string" ? v : String(v), r.type === "str16" ? "utf16" : "utf8", r.len); return; }
      if (typeof v === "string" && !/^\s*-?(0x[0-9a-f]+|\d+(\.\d+)?)\s*$/i.test(v)) throw new Error(`cannot store text in a ${r.type} row (use a text row type, str8 / str16)`);
      writeVal(inst.dv(), a, r.type as ValType, num(r, v));
    },
    readAt(addr, type) { if (!isValType(type)) throw new Error(`unknown type ${type}`); const v = readVal(inst.dv(), addr, type); return typeof v === "bigint" ? Number(v) : v; },
    writeAt(addr, type, v) { if (!isValType(type)) throw new Error(`unknown type ${type}`); writeVal(inst.dv(), addr, type, typeof v === "string" ? parseVal(type, v) : TYPE_INFO[type].big ? BigInt(Math.trunc(Number(v))) : TYPE_INFO[type].float ? Number(v) : Math.trunc(Number(v))); },
    readStr: (addr, enc, max) => readCString(buf(), addr, enc, max),
    writeStr: (addr, text, enc, cap) => { writeCString(buf(), addr, text, enc, cap); },
    freeze(r, v) {
      if (isText(r.type)) throw new Error("text rows cannot be frozen");
      const addr = addrOf(r);
      const t = r.type as ValType;
      inst.op_cheat_freeze({ addr, type: t, mode: "hard", ...(v !== undefined ? { value: String(TYPE_INFO[t].float ? v : Math.trunc(Number(v))) } : {}) });
    },
    unfreeze(r) {
      const addr = addrOf(r);
      const slot = inst.slots.find((s) => s && s.addr === addr);
      inst.op_cheat_release({ addr, size: TYPE_INFO[r.type as ValType]?.size ?? 4, keepFlags: slot ? slot.flags & 3 : 0 });
    },
    isFrozen(r) {
      let addr: number;
      try { addr = addrOf(r); } catch { return false; }
      return inst.soft.has(addr) || inst.slots.some((s) => s && s.addr === addr && (s.flags & 4));
    },
    log(m) { st.logs.push(m); if (st.logs.length > 500) st.logs.shift(); console.log("%c CETUS script ", "background:#0e7490;color:#fff;border-radius:3px", m); },
    notify(m, kind = "info") { if (!silent) showToast(m, kind); },
    call(name, args) {
      const f = inst.exps[name];
      if (typeof f !== "function") throw new Error(`no exported function '${name}'`);
      const r = f(...args);
      return typeof r === "bigint" ? Number(r) : r;
    },
  };
  return env;
}

/** Per-instance registry of running scripts. Running a script that is already running stops it (toggle). */
export class ScriptManager {
  runs = new Map<string, RunState>();
  /** `global.x` values: shared by all scripts of this page, kept across runs until the page reloads */
  globals = new Map<string, any>();

  start(inst: CetusInstance, req: RunRequest): { started: boolean; stopped?: boolean } {
    const old = this.runs.get(req.id);
    if (old?.running) {
      old.run.stop();
      old.running = false; old.ended = Date.now();
      if (!req.silent) showToast(`■ ${req.name ?? req.id} stopped`, "info");
      return { started: false, stopped: true };
    }
    const rows = buildRows(req.rows);
    const st: RunState = { id: req.id, name: req.name ?? req.id, running: true, error: null, logs: [], started: Date.now(), ended: null, run: undefined as unknown as ScriptRun };
    const env = createEnv(inst, rows, st, !!req.silent, this.globals);
    st.run = new ScriptRun(env);
    this.runs.set(req.id, st);
    // syntax errors are reported synchronously
    const p = st.run.run(req.code);
    p.then(() => {
      if (!st.running) return;
      st.running = false; st.ended = Date.now();
      if (!req.silent) showToast(`✔ ${st.name} finished (${st.ended - st.started} ms)`, "ok");
    }).catch((e) => {
      st.running = false; st.ended = Date.now();
      st.error = String((e as Error)?.message ?? e);
      showToast(`✖ ${st.name}: ${st.error}`, "error");
    });
    if (!req.silent) showToast(`▶ ${st.name}`, "info", 1200);
    return { started: true };
  }
  stop(id: string): boolean {
    const r = this.runs.get(id);
    if (!r) return false;
    r.run.stop(); r.running = false; r.ended = Date.now();
    return true;
  }
  stopAll(): void { for (const r of this.runs.values()) if (r.running) { r.run.stop(); r.running = false; } }
  status(id: string) {
    const r = this.runs.get(id);
    return r ? { running: r.running, error: r.error, logs: r.logs.slice(-200), started: r.started, ended: r.ended } : null;
  }
}
