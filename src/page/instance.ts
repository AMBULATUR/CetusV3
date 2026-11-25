import { ModuleRec, PageConfig } from "./module-rec";
import { WatchMem } from "./watchmem";
import { ScanSession, ScanParams, parsePattern, findPattern } from "./scan";
import { StringStore, StringScanParams, StringQuery } from "./strings";
import { ValType, TYPE_INFO, isValType, readVal, writeVal, parseVal, enc, Val, fmtVal } from "../shared/codec";
import { MatchSpec, compileMatcher } from "../shared/matcher";
import { hex, fromHex } from "../wasm/leb";
import { funcDisplayName, funcTypeString, SECTION_NAMES, ModuleModel } from "../wasm/module";
import { disassembleBody } from "../wasm/text";
import { mapFunctionOffsets } from "../wasm/rewrite";
import { SpeedHack } from "./speedhack";
import { PointerScan, PtrParams, Chain, resolveChain } from "./pointer";
import { findStaticLayout } from "../wasm/analysis";
import { ScriptManager, RunRequest } from "./scripting";
import { compileCondition } from "./script";
import type { BpFound } from "../wasm/rewrite";
import { readCString, writeCString } from "./cstring";

export interface Frame { fn: number; off: number; origOff: number | null; name: string }
interface Slot { addr: number; size: number; flags: number; hard: boolean }
interface HitAgg { id: number; kind: "read" | "write" | "func"; slot: number; addr: number; count: number; first: number; last: number; frames: Frame[]; fn: number; off: number | null }

export interface BpHit { n: number; id: number; t: number; ea: number; value: string | null; old: string | null; frames: Frame[]; locals: [number, string][] }
const BP_VARS = ["ea", "value", "old", "size", "func", "off"];

export type Emit = (type: string, data: unknown) => void;

let nextInstId = 0;
export const speedhack = new SpeedHack();

const MAX_PAGE = 20000;
const fmtLocked = (t: ValType, v: Val): string => (typeof v === "bigint" ? v.toString() : t === "f32" || t === "f64" ? (Number.isFinite(v) ? fmtVal(t, v) : String(v)) : String(v));
const clampLimit = (n: unknown, d = 100) => Math.max(1, Math.min(MAX_PAGE, Number(n) || d));

export class CetusInstance {
  id = nextInstId++;
  memory: WebAssembly.Memory | null = null;
  exps: Record<string, any> = {};
  created = Date.now();
  scan = new ScanSession();
  strings = new StringStore();
  pattern: { addrs: number[]; len: number; truncated: boolean; kind: string } | null = null;
  slots: (Slot | null)[] = [];
  soft = new Map<number, { type: ValType; value: Val }>();
  softTimer: ReturnType<typeof setInterval> | null = null;
  hits = new Map<string, HitAgg>();
  hitSeq = 0;
  traceCounts: Uint32Array | null = null;
  tracing = false;
  fbp: (number | null)[] = [];
  offsetMaps = new Map<number, number[]>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private fbpRate = new Map<number, { t: number; n: number }>();
  private memRate = new Map<number, { t: number; n: number }>();
  private exportsBy: Map<number, string[]> | null = null;
  ptrScan: PointerScan | null = null;
  /** watch table in linear memory (threaded modules): shared with every Web Worker running this module */
  wm: WatchMem | null = null;
  private ringTimer: ReturnType<typeof setInterval> | null = null;
  scripts = new ScriptManager();
  imports: { hit: (k: number, s: number) => void; fhit: (s: number, i: number) => void; bp: (id: number, ea: number, bits: bigint) => void; bpl: (id: number, idx: number, bits: bigint) => void };
  // ---- line breakpoints
  bpState: { enabled: boolean; cond: string; condFn: ((v: Record<string, number>) => boolean) | null; pause: boolean; count: number; rate: { t: number; n: number } }[] = [];
  bpHits: BpHit[] = [];
  private bpSeq = 0;
  private curBp: BpHit | null = null;

  constructor(readonly rec: ModuleRec, readonly cfg: PageConfig, private emit: Emit, readonly url: string) {
    this.imports = {
      hit: (k, s) => this.onMemHit(k, s),
      fhit: (s, i) => this.onFuncHit(s, i),
      bp: (id, ea, bits) => this.onBp(id, ea, bits),
      bpl: (id, idx, bits) => this.onBpl(id, idx, bits),
    };
  }

  // ------------------------------------------------------------ attach ------
  attach(instance: WebAssembly.Instance | null, importObject: any): void {
    this.exps = (instance?.exports as any) ?? {};
    const m = this.rec.model;
    let mem: unknown = null;
    if (m) {
      const imp = m.imports.find((i) => i.kind === 2);
      if (imp) mem = importObject?.[imp.module]?.[imp.field];
      if (!(mem instanceof WebAssembly.Memory)) {
        const ex = m.exports.find((e) => e.kind === 2 && e.index === 0);
        if (ex) mem = this.exps[ex.name];
      }
    }
    if (!(mem instanceof WebAssembly.Memory) && this.exps.__c_mem instanceof WebAssembly.Memory) mem = this.exps.__c_mem;
    if (!(mem instanceof WebAssembly.Memory)) {
      for (const v of Object.values(this.exps)) if (v instanceof WebAssembly.Memory) { mem = v; break; }
    }
    if (!(mem instanceof WebAssembly.Memory) && importObject && typeof importObject === "object") {
      outer: for (const mod of Object.values(importObject)) {
        if (mod && typeof mod === "object") for (const v of Object.values(mod as object)) if (v instanceof WebAssembly.Memory) { mem = v; break outer; }
      }
    }
    this.memory = mem instanceof WebAssembly.Memory ? mem : null;
    const sh = this.rec.rr?.shared;
    if (sh && this.memory) {
      this.wm = new WatchMem(this.memory, sh.ctrl);
      this.wm.init();
    }
    const nf = (m?.funcTypeIdx.length ?? 0);
    this.traceCounts = new Uint32Array(nf);
    const feat = this.rec.rr?.features;
    this.slots = new Array(feat?.slots ?? 0).fill(null);
    this.fbp = new Array(feat?.funcSlots ?? 0).fill(null);
    // line breakpoints: restore conditions / pause flags from the saved config
    const reqs = this.rec.rr?.bp.reqs ?? [];
    this.bpState = reqs.map((q) => {
      const c = this.cfg.lineBps.find((b) => b.func === q.func && b.off === q.off);
      const st = { enabled: q.enabled, cond: c?.cond ?? "", condFn: null as ((v: Record<string, number>) => boolean) | null, pause: !!c?.pause, count: 0, rate: { t: 0, n: 0 } };
      if (st.cond) { try { st.condFn = compileCondition(st.cond, BP_VARS); } catch { st.cond = ""; } }
      return st;
    });
  }

  get features() {
    return this.rec.rr?.features ?? { write: false, read: false, funcHooks: false, slots: 0, funcSlots: 0 };
  }

  buf(): ArrayBufferLike {
    if (!this.memory) throw new Error("no WebAssembly.Memory found for this instance");
    return this.memory.buffer;
  }
  dv(): DataView { return new DataView(this.buf()); }
  private g(name: string): WebAssembly.Global {
    const x = this.exps[name];
    if (!x) throw new Error("instrumentation global missing: " + name);
    return x;
  }

  // ------------------------------------------------------------ names -------
  funcName(idx: number): string {
    const u = this.rec.userNames.get(idx);
    if (u) return u;
    const m = this.rec.model;
    return m ? funcDisplayName(m, idx) : `func_${idx}`;
  }

  // ------------------------------------------------------------ hits --------
  private parseStack(stack: string): Frame[] {
    const rr = this.rec.rr;
    const m = this.rec.model;
    const out: Frame[] = [];
    const re = /wasm-function\[(\d+)\]:0x([0-9a-f]+)/gi;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(stack))) {
      let idx = Number(mm[1]);
      const off = parseInt(mm[2]!, 16);
      if (rr && rr.K) {
        if (idx >= rr.helperStart) continue;
        if (idx >= rr.N0 + rr.K) idx -= rr.K;
      }
      let origOff: number | null = null;
      if (m && idx >= (m.numImportedFuncs)) {
        const di = idx - m.numImportedFuncs;
        try {
          if (rr && rr.K && rr.newBodyStart.length) {
            const rel = off - rr.newBodyStart[di]!;
            let map = this.offsetMaps.get(idx);
            if (!map) { map = mapFunctionOffsets(m, idx, rr, this.cfg.instrument); this.offsetMaps.set(idx, map); }
            for (let i = 0; i < map.length; i += 2) { if (map[i]! <= rel) origOff = map[i + 1]!; else break; }
          } else if (m.bodies[di]) origOff = off - m.bodies[di]!.start;
        } catch { /* ignore */ }
      }
      out.push({ fn: idx, off, origOff, name: this.funcName(idx) });
    }
    return out;
  }

  private capture(): Frame[] {
    const old = Error.stackTraceLimit;
    Error.stackTraceLimit = 64;
    const st = new Error().stack ?? "";
    Error.stackTraceLimit = old;
    return this.parseStack(st);
  }

  private record(kind: HitAgg["kind"], slot: number, addr: number, frames: Frame[]): void {
    const top = frames[0];
    const key = `${kind}|${slot}|${frames.slice(0, 2).map((f) => f.fn + ":" + f.origOff).join(">")}`;
    let h = this.hits.get(key);
    const now = Date.now();
    if (!h) {
      if (this.hits.size > 3000) this.hits.delete(this.hits.keys().next().value as string);
      h = { id: this.hitSeq++, kind, slot, addr, count: 0, first: now, last: now, frames, fn: top?.fn ?? -1, off: top?.origOff ?? null };
      this.hits.set(key, h);
    }
    h.count++;
    h.last = now;
    if (this.cfg.pauseOnHit) {
      // eslint-disable-next-line no-debugger
      debugger;
    }
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => { this.emitTimer = null; this.emit("hits", { inst: this.id, total: this.hits.size }); }, 250);
    }
  }

  private onMemHit(kind: number, slot: number): void {
    const s = this.slots[slot];
    // Capturing a call stack is expensive; for very hot addresses keep counting but stop capturing.
    const now = Date.now();
    const rk = slot * 4 + kind;
    const r = this.memRate.get(rk) ?? { t: now, n: 0 };
    if (now - r.t > 1000) { r.t = now; r.n = 0; }
    r.n++;
    this.memRate.set(rk, r);
    const kindName = kind === 1 ? "read" : "write";
    if (r.n <= 60) { this.record(kindName, slot, s?.addr ?? -1, this.capture()); return; }
    let latest: HitAgg | null = null;
    for (const h of this.hits.values()) if (h.kind === kindName && h.slot === slot && (!latest || h.last > latest.last)) latest = h;
    if (latest) { latest.count++; latest.last = now; }
  }

  private onFuncHit(slot: number, idx: number): void {
    if (slot < 0) {
      if (this.traceCounts && idx < this.traceCounts.length) this.traceCounts[idx]!++;
      return;
    }
    const now = Date.now();
    const r = this.fbpRate.get(slot) ?? { t: now, n: 0 };
    if (now - r.t > 1000) { r.t = now; r.n = 0; }
    r.n++;
    this.fbpRate.set(slot, r);
    const frames = r.n <= 200 ? this.capture() : [];
    if (frames.length) this.record("func", slot, idx, frames);
    else {
      for (const h of this.hits.values()) if (h.kind === "func" && h.slot === slot) { h.count++; h.last = now; break; }
    }
  }

  // ------------------------------------------------------------ RPC ---------
  async handle(op: string, a: any): Promise<unknown> {
    const fn = (this as any)["op_" + op.replace(/\./g, "_")];
    if (typeof fn !== "function") throw new Error("unknown op " + op);
    return fn.call(this, a ?? {});
  }

  info() {
    const m = this.rec.model;
    return {
      id: this.id, url: this.url, created: this.created,
      memBytes: this.memory ? this.memory.buffer.byteLength : 0,
      hasMemory: !!this.memory,
      shared: this.memory ? typeof SharedArrayBuffer !== "undefined" && this.memory.buffer instanceof SharedArrayBuffer : false,
      funcs: m?.funcTypeIdx.length ?? 0,
      imported: m?.numImportedFuncs ?? 0,
      moduleBytes: this.rec.orig.length,
      instrumented: !!this.rec.rr?.instrumented,
      features: this.features,
      patched: this.rec.rr?.patched ?? [],
      error: this.rec.error,
      notes: this.rec.notes,
      hasNames: (m?.funcNames.size ?? 0) > 0,
      slotsUsed: this.slots.filter(Boolean).length,
    };
  }
  op_info() { return this.info(); }

  // ---- memory -------------------------------------------------------------
  op_read(a: { addr: number; len: number }) {
    const len = Math.min(a.len | 0, 1 << 20);
    const b = this.buf();
    const addr = a.addr >>> 0;
    if (addr >= b.byteLength) return { hex: "", memBytes: b.byteLength };
    return { hex: hex(new Uint8Array(b, addr, Math.min(len, b.byteLength - addr))), memBytes: b.byteLength };
  }
  private vtSpan: { lo: number; hi: number } | null | undefined;
  /** span of the module's static data (where vtables / .rodata live); null when unknown */
  private vtableSpan(): { lo: number; hi: number } | null {
    if (this.vtSpan !== undefined) return this.vtSpan;
    let r: { lo: number; hi: number } | null = null;
    const m = this.rec.model;
    if (m) {
      const L = findStaticLayout(m);
      const rs = L.ranges.filter((x) => x.hi > x.lo);
      if (rs.length) r = { lo: Math.min(...rs.map((x) => x.lo)), hi: Math.max(L.end, ...rs.map((x) => x.hi)) };
    }
    return (this.vtSpan = r);
  }
  /**
   * Struct dissector: ONE round trip reads many blocks, at any pointer depth. An item is a start address plus the
   * offsets of the pointer fields to follow (`steps`); the block is read where the last pointer leads.
   * With `probe`, every 4-byte aligned word that looks like a heap pointer also returns the word it points at
   * (`vt[i]` for word i), so the UI can tag `[vtable]` pointers.
   */
  op_dissect_read(a: { items: { addr: number; steps?: number[]; len: number; probe?: boolean }[] }) {
    const b = this.buf();
    const n = b.byteLength;
    const dv = new DataView(b);
    const items = a.items.slice(0, 512).map((it) => {
      let cur = it.addr >>> 0;
      let ok = cur < n;
      for (const st of it.steps ?? []) {
        if (!ok) break;
        const p = cur + st;
        if (p < 0 || p + 4 > n) { ok = false; break; }
        cur = dv.getUint32(p, true);
        if (cur < 0x1000 || cur >= n) ok = false;
      }
      const len = Math.max(0, Math.min(it.len | 0, 8192, n - cur));
      if (!ok || len <= 0) return { a: -1, hex: "", vt: null as (number | null)[] | null };
      let vt: (number | null)[] | null = null;
      if (it.probe) {
        vt = [];
        for (let o = 0; o + 4 <= len; o += 4) {
          const w = dv.getUint32(cur + o, true);
          vt.push(w >= 0x1000 && w + 4 <= n && (w & 3) === 0 ? dv.getUint32(w, true) : null);
        }
      }
      return { a: cur, hex: hex(new Uint8Array(b, cur, len)), vt };
    });
    return { memBytes: n, items, vtRange: this.vtableSpan() };
  }
  op_readValues(a: { items: { addr: number; type: ValType }[] }) {
    const dv = this.dv();
    return a.items.map((it) => {
      if (!isValType(it.type)) return null;
      if (it.addr < 0 || it.addr + TYPE_INFO[it.type].size > dv.byteLength) return null;
      return enc(readVal(dv, it.addr, it.type));
    });
  }
  op_write(a: { addr: number; type: ValType; value: string }) {
    if (!isValType(a.type)) throw new Error("bad type");
    const v = parseVal(a.type, a.value);
    const dv = this.dv();
    if (a.addr < 0 || a.addr + TYPE_INFO[a.type].size > dv.byteLength) throw new RangeError("address out of range");
    writeVal(dv, a.addr, a.type, v);
    const s = this.soft.get(a.addr);
    if (s) s.value = v;
    return true;
  }
  op_writeBytes(a: { addr: number; hex: string }) {
    const b = fromHex(a.hex);
    const mem = new Uint8Array(this.buf());
    if (a.addr < 0 || a.addr + b.length > mem.length) throw new RangeError("address out of range");
    mem.set(b, a.addr);
    return true;
  }

  // ---- value scanning -----------------------------------------------------
  op_scan_first(a: ScanParams) {
    this.pattern = null;
    this.scan.first(this.buf(), { ...a, upper: a.upper || this.buf().byteLength });
    return this.scanState();
  }
  op_scan_next(a: ScanParams) {
    this.scan.next(this.buf(), { ...a, type: this.scan.type, upper: a.upper || this.buf().byteLength });
    return this.scanState();
  }
  op_scan_reset() { this.scan.reset(); this.pattern = null; return this.scanState(); }
  scanState() {
    return { count: this.pattern ? this.pattern.addrs.length : this.scan.count, type: this.scan.type, truncated: this.scan.truncated, started: this.scan.started, snapshot: !!this.scan.snapshot, pattern: !!this.pattern };
  }
  op_scan_page(a: { offset: number; limit: number }) {
    const limit = clampLimit(a.limit);
    if (this.pattern) {
      const p = this.pattern;
      const dv = this.dv();
      const rows = p.addrs.slice(a.offset, a.offset + limit).map((addr) => {
        const n = Math.min(p.len, 48);
        const bytes = new Uint8Array(dv.buffer, addr, Math.min(n, dv.byteLength - addr));
        return { addr, value: hex(bytes, " "), prev: null };
      });
      return { ...this.scanState(), rows };
    }
    return { ...this.scanState(), rows: this.scan.page(this.buf(), Math.max(0, a.offset), limit).map((r) => ({ addr: r.addr, value: enc(r.value), prev: r.prev === null ? null : enc(r.prev) })) };
  }
  op_scan_export(a: { offset: number; limit: number }) { return this.op_scan_page({ offset: a.offset, limit: Math.min(a.limit, MAX_PAGE) }); }
  op_scan_pattern(a: { kind: "ascii" | "utf16" | "bytes"; text: string; lower: number; upper: number }) {
    const pat = parsePattern(a.kind, a.text);
    const r = findPattern(this.buf(), pat, a.lower || 0, a.upper || 0, 5_000_000);
    this.scan.reset();
    this.pattern = { addrs: r.addrs, len: pat.bytes.length, truncated: r.truncated, kind: a.kind };
    return this.scanState();
  }

  // ---- strings ------------------------------------------------------------
  op_strings_scan(a: StringScanParams) {
    this.strings.scan(this.buf(), { ...a, upper: a.upper || this.buf().byteLength });
    return { count: this.strings.count, truncated: this.strings.truncated };
  }
  op_strings_query(a: StringQuery) {
    return this.strings.query({ ...a, limit: clampLimit(a.limit), offset: Math.max(0, a.offset | 0) });
  }
  op_strings_state() { return { count: this.strings.count, truncated: this.strings.truncated }; }

  // ---- hardware-style watchpoints ----------------------------------------
  private recomputeEnables(): void {
    const f = this.features;
    const w = this.slots.some((s) => s && (s.flags & 6));
    const r = this.slots.some((s) => s && (s.flags & 1));
    if (this.wm) this.wm.setEnables(f.write && w, f.read && r);
    else {
      if (f.write) this.g("__c_wen").value = w ? 1 : 0;
      if (f.read) this.g("__c_ren").value = r ? 1 : 0;
    }
    if (this.wm) this.syncRingPoll();
  }

  /** Hits from Web Workers cannot call into this realm: they land in the ring buffer, which we poll while anything is armed. */
  private syncRingPoll(): void {
    const armed = this.slots.some(Boolean);
    if (armed && !this.ringTimer) this.ringTimer = setInterval(() => this.pollRing(), 100);
    else if (!armed && this.ringTimer) { this.pollRing(); clearInterval(this.ringTimer); this.ringTimer = null; }
  }
  ringLost = 0;
  pollRing(): void {
    const wm = this.wm;
    if (!wm) return;
    let hits;
    try { hits = wm.drain(); } catch { return; } // memory detached / grown: try again next tick
    this.ringLost = wm.lost;
    for (const h of hits) {
      const s = this.slots[h.slot];
      const frame: Frame = { fn: h.func, off: 0, origOff: h.off, name: this.funcName(h.func) };
      this.record(h.kind === 1 ? "read" : "write", h.slot, s?.addr ?? h.ea, [frame]);
    }
  }
  op_watch_set(a: { addr: number; size: number; flags: number; value?: string }) {
    const f = this.features;
    if (!f.slots) throw new Error("watchpoints unavailable: " + (this.rec.error ?? "instrumentation is disabled for this module"));
    const size = a.size | 0;
    if (![1, 2, 4, 8].includes(size)) throw new Error("size must be 1, 2, 4 or 8");
    const flags = a.flags & 7;
    if (!flags) return this.op_watch_clear({ addr: a.addr, size });
    if ((flags & 1) && !f.read) throw new Error("read watch needs read instrumentation (enable it in Settings and reload the page)");
    if ((flags & 6) && !f.write) throw new Error("write watch / freeze needs store instrumentation (enable it in Settings and reload the page)");
    const dv = this.dv();
    if (a.addr < 0 || a.addr + size > dv.byteLength) throw new RangeError("address out of range");
    let slot = this.slots.findIndex((s) => s && s.addr === a.addr && s.size === size);
    if (slot < 0) slot = this.slots.findIndex((s) => !s);
    if (slot < 0) throw new Error(`all ${this.slots.length} watch slots are in use — remove one first`);
    let cur: bigint;
    if (a.value !== undefined && a.value !== "") cur = BigInt.asUintN(size * 8, BigInt(a.value));
    else cur = size === 8 ? dv.getBigUint64(a.addr, true) : BigInt(size === 4 ? dv.getUint32(a.addr, true) : size === 2 ? dv.getUint16(a.addr, true) : dv.getUint8(a.addr));
    if (this.wm) this.wm.arm(slot, a.addr, size, flags, cur);
    else {
      this.g(`__c_wf${slot}`).value = 0;
      this.g(`__c_wa${slot}`).value = a.addr | 0;
      this.g(`__c_ws${slot}`).value = size;
      this.g(`__c_wv${slot}`).value = BigInt.asIntN(64, cur);
      this.g(`__c_wf${slot}`).value = flags;
    }
    this.slots[slot] = { addr: a.addr, size, flags, hard: true };
    this.recomputeEnables();
    return { slot, flags };
  }
  op_watch_clear(a: { addr?: number; size?: number; slot?: number }) {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s) continue;
      if (a.slot === i || (a.addr === s.addr && (a.size === undefined || a.size === s.size))) {
        if (this.wm) this.wm.disarm(i);
        else this.g(`__c_wf${i}`).value = 0;
        this.slots[i] = null;
      }
    }
    if (this.features.slots) this.recomputeEnables();
    return true;
  }
  op_watch_list() {
    return this.slots.map((s, i) => (s ? { slot: i, ...s } : null)).filter(Boolean);
  }
  op_hits_get(a: { kind?: string }) {
    const rows = [...this.hits.values()].filter((h) => !a.kind || h.kind === a.kind).sort((x, y) => y.last - x.last).slice(0, 500);
    return rows;
  }
  op_hits_clear() { this.hits.clear(); return true; }

  // ---- soft freeze (JS timer; unlimited, also works on uninstrumented modules)
  op_freeze_set(a: { addr: number; type: ValType; value: string }) {
    const v = parseVal(a.type, a.value);
    this.soft.set(a.addr, { type: a.type, value: v });
    if (!this.softTimer) {
      this.softTimer = setInterval(() => {
        if (!this.memory) return;
        const dv = this.dv();
        for (const [addr, f] of this.soft) {
          if (addr + TYPE_INFO[f.type].size > dv.byteLength) continue;
          if (readVal(dv, addr, f.type) !== f.value && !(Number.isNaN(f.value as number))) writeVal(dv, addr, f.type, f.value);
        }
      }, 8);
    }
    this.op_write(a);
    return true;
  }
  op_freeze_clear(a: { addr: number }) {
    this.soft.delete(a.addr);
    if (!this.soft.size && this.softTimer) { clearInterval(this.softTimer); this.softTimer = null; }
    return true;
  }
  op_freeze_list() { return [...this.soft].map(([addr, f]) => ({ addr, type: f.type, value: enc(f.value) })); }

  // ---- function breakpoints & tracing ------------------------------------
  private needFuncHooks(): void {
    if (!this.features.funcHooks) throw new Error("function hooks unavailable — enable them in Settings and reload the page");
  }
  private recomputeFen(): void {
    this.g("__c_fen").value = this.tracing ? 2 : this.fbp.some((x) => x !== null) ? 1 : 0;
  }
  op_fbp_set(a: { index: number }) {
    this.needFuncHooks();
    const idx = a.index | 0;
    if (this.fbp.includes(idx)) return { slot: this.fbp.indexOf(idx) };
    const slot = this.fbp.findIndex((x) => x === null);
    if (slot < 0) throw new Error(`all ${this.fbp.length} function breakpoint slots are in use`);
    this.fbp[slot] = idx;
    this.g(`__c_fb${slot}`).value = idx;
    this.recomputeFen();
    return { slot };
  }
  op_fbp_clear(a: { index: number }) {
    const slot = this.fbp.indexOf(a.index | 0);
    if (slot >= 0) { this.fbp[slot] = null; this.g(`__c_fb${slot}`).value = -1; this.recomputeFen(); }
    return true;
  }
  op_fbp_list() {
    return this.fbp.map((idx, slot) => {
      if (idx === null) return null;
      let count = 0;
      for (const h of this.hits.values()) if (h.kind === "func" && h.slot === slot) count += h.count;
      return { slot, index: idx, name: this.funcName(idx), count };
    }).filter(Boolean);
  }
  op_trace_start() { this.needFuncHooks(); this.traceCounts!.fill(0); this.tracing = true; this.recomputeFen(); return true; }
  op_trace_stop() { this.tracing = false; if (this.features.funcHooks) this.recomputeFen(); return true; }
  op_trace_state() { return { tracing: this.tracing, called: this.traceCounts ? this.traceCounts.reduce((n, c) => n + (c ? 1 : 0), 0) : 0 }; }
  op_trace_clear() { this.traceCounts?.fill(0); return true; }

  // ---- cheat-table helpers: one round trip per user action ------------------------
  op_cheat_poll(a: { items: { addr?: number; ptr?: Chain; type: string; len?: number }[] }) {
    const buf = this.buf();
    const dv = new DataView(buf);
    return a.items.map((it) => {
      let addr = it.addr ?? -1;
      if (it.ptr) { const r = resolveChain(buf, it.ptr, this.gv); addr = r ?? -1; }
      if (it.type === "str8" || it.type === "str16") {
        if (addr < 0 || addr >= dv.byteLength) return { a: addr, v: null };
        return { a: addr, v: readCString(buf, addr, it.type === "str16" ? "utf16" : "utf8", Math.min(it.len ?? 128, 1024)) };
      }
      if (!isValType(it.type) || addr < 0 || addr + TYPE_INFO[it.type].size > dv.byteLength) return { a: addr, v: null };
      return { a: addr, v: enc(readVal(dv, addr, it.type)) };
    });
  }
  /** freeze an address (hard = inside the store instruction, timer = JS loop). Returns the locked value. */
  op_cheat_freeze(a: { addr: number; type: ValType; mode: "hard" | "timer"; value?: string; watchFlags?: number }) {
    const size = TYPE_INFO[a.type].size;
    const dv = this.dv();
    if (a.value === undefined || a.value === "") a = { ...a, value: fmtLocked(a.type, readVal(dv, a.addr, a.type)) };
    const value = a.value!;
    const haveSlot = this.slots.some((s) => s && s.addr === a.addr && s.size === size);
    const freeSlot = this.slots.some((s) => !s);
    if (a.mode === "hard" && this.features.write && this.features.slots && (haveSlot || freeSlot)) {
      this.op_write({ addr: a.addr, type: a.type, value });
      this.soft.delete(a.addr);
      this.op_watch_set({ addr: a.addr, size, flags: 4 | ((a.watchFlags ?? 0) & 3) });
      return { value, mode: "hard" };
    }
    this.op_freeze_set({ addr: a.addr, type: a.type, value });
    return { value, mode: "timer" };
  }
  /** many entries in one round trip; hard freezes fall back to timer mode when the slots are full */
  op_cheat_freezeMany(a: { items: { addr: number; type: ValType; mode: "hard" | "timer"; value?: string; watchFlags?: number }[] }) {
    return a.items.map((it) => {
      try { return this.op_cheat_freeze(it); } catch (e) { return { error: String((e as Error)?.message ?? e) }; }
    });
  }
  op_cheat_releaseMany(a: { items: { addr: number; size?: number; keepFlags?: number }[] }) {
    for (const it of a.items) { try { this.op_cheat_release(it); } catch { /* keep going */ } }
    return true;
  }
  op_cheat_release(a: { addr: number; size?: number; keepFlags?: number }) {
    this.op_freeze_clear({ addr: a.addr });
    if (this.features.slots) {
      if (a.keepFlags) this.op_watch_set({ addr: a.addr, size: a.size ?? 4, flags: a.keepFlags & 3 });
      else this.op_watch_clear({ addr: a.addr });
    }
    return true;
  }
  /** one round trip for everything the debugger view shows */
  op_dbg_poll(a: { trace?: boolean }) {
    const out: any = { watch: this.op_watch_list(), fbp: this.op_fbp_list(), hits: this.op_hits_get({}), trace: this.op_trace_state() };
    if (a.trace) out.called = this.op_mod_funcs({ calledOnly: true, sort: "calls", desc: true, offset: 0, limit: 5000 }).rows;
    return out;
  }

  // ---- pointer paths ("offset finder") -----------------------------------------
  op_ptr_staticRange() {
    const m = this.rec.model;
    const memLen = this.buf().byteLength;
    let end = 0;
    let source = "unknown";
    if (m) { const L = findStaticLayout(m); end = L.end; source = L.source; }
    // linker symbols, when the module exports them as globals
    let heapBase = 0;
    for (const n of ["__heap_base", "__data_end"]) {
      const g = this.exps[n];
      if (g && typeof g === "object" && "value" in g && typeof g.value === "number" && g.value > 0) {
        if (n === "__heap_base") { heapBase = g.value >>> 0; end = Math.max(end, heapBase); source = "exported __heap_base"; }
        else if ((g.value >>> 0) > end) { end = g.value >>> 0; source = "exported __data_end"; }
      }
    }
    const detected = end > 0;
    const hi = Math.min(memLen, detected ? (end + 15) & ~15 : 0x400000);
    return { lo: 0x100, hi, end, detected, source: detected ? source : "could not be detected (defaulting to the first 4 MiB — adjust it)", memLen, heapBase };
  }
  private gv = (i: number): number | null => this.globalValue(i);
  /** current value of Wasm global `idx` (i32 only): our `__c_g<idx>` export, or the module's own export of it */
  globalValue(idx: number): number | null {
    const g = this.globalObj(idx);
    if (!g) return null;
    try { const v = g.value; return typeof v === "number" ? v >>> 0 : null; } catch { return null; }
  }
  private globalExportNames: Map<number, string> | null = null;
  private globalObj(idx: number): WebAssembly.Global | null {
    let x = this.exps[`__c_g${idx}`];
    if (!x) {
      if (!this.globalExportNames) {
        this.globalExportNames = new Map();
        for (const e of this.rec.model?.exports ?? []) if (e.kind === 3 && !this.globalExportNames.has(e.index)) this.globalExportNames.set(e.index, e.name);
      }
      const n = this.globalExportNames.get(idx);
      if (n) x = this.exps[n];
    }
    return x && typeof x === "object" && "value" in x ? (x as WebAssembly.Global) : null;
  }
  /** i32 globals that currently hold something that looks like a heap/static pointer */
  op_ptr_globals() {
    const m = this.rec.model;
    const memLen = this.memory ? this.buf().byteLength : 0;
    // linker constants describe the layout, not objects
    const skip = /^(__stack_pointer|__stack_base|__stack_end|__stack_low|__stack_high|__heap_base|__heap_end|__data_end|__global_base|__memory_base|__table_base|__tls_base|__tls_size|__tls_align)$/;
    const names = new Map<number, string>();
    for (const e of m?.exports ?? []) if (e.kind === 3 && !names.has(e.index)) names.set(e.index, e.name);
    const out: { idx: number; value: number; name: string; mutable: boolean }[] = [];
    (m?.globals ?? []).forEach((g, idx) => {
      if (g.valType !== "i32") return;
      const name = names.get(idx) ?? "";
      if (skip.test(name)) return;
      const v = this.globalValue(idx);
      if (v === null || v < 0x1000 || v >= memLen || (v & 3) !== 0) return;
      out.push({ idx, value: v, name, mutable: g.mutable });
    });
    return out;
  }
  op_ptr_start(a: PtrParams & { useGlobals?: boolean }) {
    this.ptrScan?.cancel();
    // vtables live in static data: the span of the module's active data segments (or the user's static range)
    let vtLo = a.vtLo, vtHi = a.vtHi;
    if (a.requireVtable && (vtLo === undefined || vtHi === undefined)) {
      const L = this.rec.model ? findStaticLayout(this.rec.model) : null;
      const rs = L?.ranges.filter((x) => x.hi > x.lo) ?? [];
      if (rs.length) { vtLo ??= Math.min(...rs.map((x) => x.lo)); vtHi ??= Math.max(L!.end, ...rs.map((x) => x.hi)); }
      else { vtLo ??= a.staticLo; vtHi ??= a.staticHi; }
    }
    const sc = new PointerScan(() => this.buf(), {
      ...a, vtLo, vtHi, globals: a.useGlobals ? this.op_ptr_globals().map((g) => ({ idx: g.idx, value: g.value })) : [],
      maxPairs: Math.max(1_000_000, Math.min(200_000_000, a.maxPairs ?? 64_000_000)), maxOff: Math.max(0, a.maxOff | 0), levels: Math.max(1, Math.min(6, a.levels | 0)),
      maxFrontier: Math.max(1000, Math.min(2_000_000, a.maxFrontier ?? 20000)), maxResults: Math.max(100, Math.min(100_000, a.maxResults ?? 5000)),
    });
    this.ptrScan = sc;
    void sc.run();
    return true;
  }
  op_ptr_status() {
    const s = this.ptrScan;
    if (!s) return { running: false, progress: 0, level: 0, results: 0, frontier: 0, capped: false, error: null, started: false };
    return { running: s.running, progress: s.progress, level: s.level, results: s.results.length, frontier: s.frontier, capped: s.capped, error: s.error, started: true, indexed: s.indexed, vtableRejected: s.vtableRejected };
  }
  op_ptr_results(a: { offset: number; limit: number; type?: ValType }) {
    const s = this.ptrScan;
    if (!s) return { total: 0, rows: [] };
    const buf = this.buf();
    const dv = new DataView(buf);
    const rows = s.results.slice(a.offset | 0, (a.offset | 0) + clampLimit(a.limit)).map((c) => {
      const now = resolveChain(buf, c, this.gv);
      const v = a.type && isValType(a.type) && now !== null && now + TYPE_INFO[a.type].size <= dv.byteLength ? enc(readVal(dv, now, a.type)) : null;
      return { ...c, now, v };
    });
    return { total: s.results.length, rows };
  }
  /** resolve saved chains in the current run and read the value they lead to */
  op_ptr_eval(a: { chains: Chain[]; type?: ValType }) {
    const buf = this.buf();
    const dv = new DataView(buf);
    return a.chains.map((c) => {
      const now = resolveChain(buf, c, this.gv);
      const v = a.type && isValType(a.type) && now !== null && now + TYPE_INFO[a.type].size <= dv.byteLength ? enc(readVal(dv, now, a.type)) : null;
      return { now, v };
    });
  }
  op_ptr_cancel() { this.ptrScan?.cancel(); return true; }
  op_ptr_resolve(a: { chains: Chain[] }) {
    const buf = this.buf();
    return a.chains.map((c) => resolveChain(buf, c, this.gv));
  }

  // ---- text rows ------------------------------------------------------------------
  op_writeStr(a: { addr: number; text: string; enc: "utf8" | "utf16"; cap?: number }) {
    return { bytes: writeCString(this.buf(), a.addr, a.text, a.enc, a.cap) };
  }
  op_readStr(a: { addr: number; enc: "utf8" | "utf16"; max?: number }) {
    return { text: readCString(this.buf(), a.addr, a.enc, Math.min(a.max ?? 256, 100000)) };
  }

  // ---- scripts -------------------------------------------------------------------
  op_script_run(a: RunRequest) { return this.scripts.start(this, a); }
  op_script_stop(a: { id: string }) { return this.scripts.stop(a.id); }
  op_script_status(a: { id: string }) { return this.scripts.status(a.id); }
  op_script_list() { return [...this.scripts.runs.values()].map((r) => ({ id: r.id, name: r.name, running: r.running })); }

  // ---- line breakpoints --------------------------------------------------------------
  private onBp(id: number, ea: number, bits: bigint): void {
    const st = this.bpState[id];
    const f = this.rec.rr?.bp.found[id];
    this.curBp = null;
    if (!st || !f) return;
    st.count++;
    const now = Date.now();
    if (now - st.rate.t > 1000) { st.rate.t = now; st.rate.n = 0; }
    if (++st.rate.n > 200) return; // hot line: keep counting, stop capturing
    const size = f.size;
    const width = f.valType === 0x7e || f.valType === 0x7c ? 64 : 32;
    let value: bigint | null = null;
    let old: bigint | null = null;
    if (f.kind !== "generic") {
      value = BigInt.asUintN(size * 8, bits);
      if (f.kind === "store" && this.memory && ea >= 0 && ea + size <= this.memory.buffer.byteLength) {
        const dv = this.dv();
        old = size === 8 ? dv.getBigUint64(ea, true) : BigInt(size === 4 ? dv.getUint32(ea, true) : size === 2 ? dv.getUint16(ea, true) : dv.getUint8(ea));
      }
    }
    const num = (b: bigint | null): number => {
      if (b === null) return 0;
      if (f.valType === 0x7d) return new DataView(new Uint32Array([Number(b)]).buffer).getFloat32(0, true);
      if (f.valType === 0x7c) return new DataView(new BigUint64Array([b]).buffer).getFloat64(0, true);
      return size * 8 === width ? Number(BigInt.asIntN(width, b)) : Number(b);
    };
    if (st.condFn) {
      try { if (!st.condFn({ ea: ea >>> 0, value: num(value), old: num(old), size, func: f.func, off: f.off })) return; } catch { return; }
    }
    const hit: BpHit = { n: this.bpSeq++, id, t: now, ea: ea >>> 0, value: value === null ? null : value.toString(), old: old === null ? null : old.toString(), frames: this.capture(), locals: [] };
    this.bpHits.push(hit);
    if (this.bpHits.length > 500) this.bpHits.shift();
    this.curBp = hit;
    if (st.pause) {
      // eslint-disable-next-line no-debugger
      debugger;
    }
  }
  private onBpl(id: number, idx: number, bits: bigint): void {
    const h = this.curBp;
    if (h && h.id === id) h.locals.push([idx, BigInt.asUintN(64, bits).toString()]);
  }
  op_bp_sites() {
    const rr = this.rec.rr;
    const reqs = rr?.bp.reqs ?? [];
    return reqs.map((q, id) => {
      const f: BpFound | null = rr!.bp.found[id] ?? null;
      const st = this.bpState[id]!;
      const flag = this.exps[rr!.bp.flagNames[id]!];
      return { id, func: q.func, off: q.off, fn: this.funcName(q.func), found: !!f, name: f?.name ?? "", kind: f?.kind ?? "generic", size: f?.size ?? 0, valType: f?.valType ?? 0, offset: f?.offset ?? 0, localCodes: f?.localCodes ?? [], enabled: flag ? !!flag.value : st.enabled, cond: st.cond, pause: st.pause, count: st.count };
    });
  }
  op_bp_config(a: { func: number; off: number; enabled?: boolean; cond?: string; pause?: boolean }) {
    const rr = this.rec.rr;
    const id = (rr?.bp.reqs ?? []).findIndex((q) => q.func === a.func && q.off === a.off);
    if (id < 0) throw new Error("this breakpoint is not compiled into the running module — reload the page to apply it");
    const st = this.bpState[id]!;
    if (a.cond !== undefined) {
      if (a.cond.trim()) { st.condFn = compileCondition(a.cond, BP_VARS); st.cond = a.cond.trim(); } else { st.condFn = null; st.cond = ""; }
    }
    if (a.pause !== undefined) st.pause = a.pause;
    if (a.enabled !== undefined) { st.enabled = a.enabled; const g = this.exps[rr!.bp.flagNames[id]!]; if (g) g.value = a.enabled ? 1 : 0; }
    return true;
  }
  op_bp_hits(a: { func?: number; limit?: number }) {
    const reqs = this.rec.rr?.bp.reqs ?? [];
    const rows = this.bpHits.filter((h) => a.func === undefined || reqs[h.id]?.func === a.func).slice(-Math.min(a.limit ?? 100, 300)).reverse();
    return rows;
  }
  op_bp_poll(a: { func?: number; limit?: number }) { return { sites: this.op_bp_sites(), hits: this.op_bp_hits(a) }; }
  op_bp_clear() { this.bpHits.length = 0; for (const s of this.bpState) s.count = 0; return true; }

  // ---- speedhack ----------------------------------------------------------
  op_speed_set(a: { multiplier: number }) { speedhack.set(Number(a.multiplier)); return speedhack.multiplier; }
  op_speed_get() { return speedhack.multiplier; }

  // ---- static module info --------------------------------------------------
  private model(): ModuleModel {
    if (!this.rec.model) throw new Error("module could not be parsed");
    return this.rec.model;
  }
  op_mod_summary() {
    const m = this.model();
    return {
      sections: m.sections.map((s) => ({ name: s.name ?? SECTION_NAMES[s.id] ?? String(s.id), size: s.end - s.payloadStart })),
      types: m.types.length, imports: m.imports.length, funcs: m.funcTypeIdx.length, importedFuncs: m.numImportedFuncs,
      globals: m.globals.length, tables: m.tables.length, memories: m.memories.map((x) => x.limits),
      exports: m.exports.length, start: m.startFunc, data: m.data.length, moduleName: m.moduleName ?? null, warnings: m.warnings,
      hasNames: m.funcNames.size > 0,
    };
  }
  op_mod_funcs(a: { filter?: MatchSpec; kind?: string; sort?: string; desc?: boolean; offset: number; limit: number; calledOnly?: boolean; minSize?: number; refText?: boolean }) {
    const m = this.model();
    const test = compileMatcher(a.filter ?? null);
    if (!this.exportsBy) {
      this.exportsBy = new Map<number, string[]>();
      for (const e of m.exports) if (e.kind === 0) { const l = this.exportsBy.get(e.index) ?? []; l.push(e.name); this.exportsBy.set(e.index, l); }
    }
    const exportsBy = this.exportsBy;
    const n = m.funcTypeIdx.length;
    // fast path: only functions seen by the trace (avoids touching every function of a 100k-function module)
    const candidates: number[] | null = a.calledOnly && this.traceCounts ? (() => { const out: number[] = []; const tc = this.traceCounts!; for (let i = 0; i < tc.length; i++) if (tc[i]) out.push(i); return out; })() : null;
    const needAnalysis = a.sort === "callers" || a.sort === "callees";
    const A = needAnalysis ? this.rec.analysis : null;
    const rows: any[] = [];
    const numeric = /^\d+$/.test(a.filter?.text ?? "") && a.filter?.mode !== "regex";
    const total = candidates ? candidates.length : n;
    for (let ci = 0; ci < total; ci++) {
      const i = candidates ? candidates[ci]! : ci;
      const imported = i < m.numImportedFuncs;
      if (a.kind === "import" && !imported) continue;
      if (a.kind === "defined" && imported) continue;
      if (a.kind === "export" && !exportsBy.has(i)) continue;
      const calls = this.traceCounts?.[i] ?? 0;
      if (a.calledOnly && !calls) continue;
      const bodySize = imported ? 0 : m.bodies[i - m.numImportedFuncs]!.end - m.bodies[i - m.numImportedFuncs]!.start;
      if (a.minSize && bodySize < a.minSize) continue;
      const name = this.funcName(i);
      if (a.filter && a.filter.text) {
        const hit = test(name) || (numeric && String(i) === a.filter.text) || (exportsBy.get(i) ?? []).some(test);
        if (!hit) continue;
      }
      rows.push({
        index: i, name, kind: imported ? "import" : "defined", size: bodySize, exports: exportsBy.get(i) ?? [],
        sig: funcTypeString(m.types[m.funcTypeIdx[i]!]), calls,
        callers: A ? (A.callers.get(i)?.length ?? 0) : undefined, callees: A ? (A.callees.get(i)?.length ?? 0) : undefined,
      });
    }
    const dir = a.desc ? -1 : 1;
    switch (a.sort) {
      case "size": rows.sort((x, y) => dir * (x.size - y.size)); break;
      case "name": rows.sort((x, y) => dir * x.name.localeCompare(y.name)); break;
      case "calls": rows.sort((x, y) => dir * (x.calls - y.calls)); break;
      case "callers": rows.sort((x, y) => dir * (x.callers - y.callers)); break;
      case "callees": rows.sort((x, y) => dir * (x.callees - y.callees)); break;
      default: if (a.desc) rows.reverse();
    }
    const limit = clampLimit(a.limit);
    return { total: rows.length, rows: rows.slice(Math.max(0, a.offset | 0), (a.offset | 0) + limit) };
  }
  op_mod_table(a: { table: "imports" | "exports" | "globals" | "tables" | "memories" | "types" | "data" | "customs"; filter?: MatchSpec; offset: number; limit: number }) {
    const m = this.model();
    const test = compileMatcher(a.filter ?? null);
    let rows: any[] = [];
    switch (a.table) {
      case "imports": {
        let fi = 0, gi = 0, ti = 0, mi = 0;
        rows = m.imports.map((i, n) => {
          const space = i.kind === 0 ? fi++ : i.kind === 3 ? gi++ : i.kind === 1 ? ti++ : i.kind === 2 ? mi++ : -1;
          return { n, kind: ["func", "table", "memory", "global", "tag"][i.kind], index: space, module: i.module, field: i.field, type: i.kind === 0 ? funcTypeString(m.types[i.typeIdx!]) : i.kind === 3 ? `${i.mutable ? "mut " : ""}${i.valType}` : i.kind === 2 ? JSON.stringify(i.limits) : "", name: `${i.module}.${i.field}` };
        });
        break;
      }
      case "exports":
        rows = m.exports.map((e) => ({ name: e.name, kind: ["func", "table", "memory", "global", "tag"][e.kind] ?? e.kind, index: e.index, type: e.kind === 0 ? funcTypeString(m.types[m.funcTypeIdx[e.index]!]) : "" }));
        break;
      case "globals":
        rows = m.globals.map((g, i) => ({ name: String(i), index: i, type: g.valType, mutable: g.mutable, imported: g.imported, init: g.init ?? "" }));
        break;
      case "tables": rows = m.tables.map((t, i) => ({ name: String(i), index: i, type: t.elemType, min: t.limits.min, max: t.limits.max, imported: t.imported })); break;
      case "memories": rows = m.memories.map((t, i) => ({ name: String(i), index: i, min: t.limits.min, max: t.limits.max, shared: t.limits.shared, memory64: t.limits.memory64, imported: t.imported })); break;
      case "types": rows = m.types.map((t, i) => ({ name: String(i), index: i, sig: t ? funcTypeString(t) : "(struct/array)" })); break;
      case "data": rows = m.data.map((d) => ({ name: String(d.index), index: d.index, mode: d.mode, offset: d.offset, size: d.size })); break;
      case "customs": rows = m.customSections.map((c) => ({ name: c.name, size: c.size })); break;
    }
    if (a.filter && a.filter.text) rows = rows.filter((r) => test(String(r.name)) || (r.sig && test(String(r.sig))) || (r.field && test(String(r.field))) || (r.module && test(String(r.module))));
    const limit = clampLimit(a.limit);
    return { total: rows.length, rows: rows.slice(a.offset | 0, (a.offset | 0) + limit) };
  }
  op_mod_rename(a: { index: number; name: string }) {
    if (a.name) this.rec.userNames.set(a.index, a.name); else this.rec.userNames.delete(a.index);
    return true;
  }
  op_mod_names(a: { names: Record<string, string> }) {
    for (const [k, v] of Object.entries(a.names ?? {})) this.rec.userNames.set(Number(k), v);
    return true;
  }

  private cstringAt(addr: number): string | null {
    if (!this.memory) return null;
    const mem = new Uint8Array(this.memory.buffer);
    if (addr < 0x100 || addr >= mem.length) return null;
    let e = addr;
    while (e < mem.length && e - addr < 64 && mem[e]! >= 0x20 && mem[e]! < 0x7f) e++;
    if (e - addr < 4 || (e < mem.length && mem[e] !== 0 && e - addr < 64)) return null;
    return String.fromCharCode(...mem.subarray(addr, e)) + (e - addr >= 64 ? "…" : "");
  }
  op_mod_disasm(a: { index: number }) {
    const m = this.model();
    const idx = a.index | 0;
    const bi = idx - m.numImportedFuncs;
    if (idx < 0 || idx >= m.funcTypeIdx.length) throw new RangeError("no such function");
    if (bi < 0) {
      const imp = m.imports.filter((i) => i.kind === 0)[idx];
      return { index: idx, name: this.funcName(idx), imported: true, sig: funcTypeString(m.types[m.funcTypeIdx[idx]!]), lines: [], locals: [], import: imp ? `${imp.module}.${imp.field}` : "", text: "" };
    }
    const b = m.bodies[bi]!;
    const d = disassembleBody(m.bytes, b.start, b.end, { funcName: (i) => this.funcName(i) });
    for (const l of d.lines) {
      if (l.i32 !== undefined && !l.comment) {
        const s = this.cstringAt(l.i32);
        if (s) l.comment = JSON.stringify(s);
      }
    }
    return {
      index: idx, name: this.funcName(idx), imported: false, sig: funcTypeString(m.types[m.funcTypeIdx[idx]!]), size: b.end - b.start,
      locals: d.locals, error: d.error ?? null,
      patched: this.rec.rr?.patched.includes(idx) ?? false,
      lines: d.lines.map((l) => ({ off: l.off, indent: l.indent, text: l.text, comment: l.comment, target: l.target, bytes: hex(l.bytes) })),
      text: d.text,
    };
  }
  op_mod_xrefs(a: { kind: "func" | "addr"; value: number; range?: number }) {
    const A = this.rec.analysis;
    if (a.kind === "func") {
      const callers = (A.callers.get(a.value) ?? []).map((i) => ({ index: i, name: this.funcName(i) }));
      const callees = (A.callees.get(a.value) ?? []).map((i) => ({ index: i, name: this.funcName(i) }));
      return { callers, callees, indirectTarget: A.refFuncs.has(a.value) };
    }
    const range = Math.max(0, a.range ?? 0);
    const out = new Map<number, number[]>();
    for (let v = a.value - range; v <= a.value; v++) {
      for (const f of A.consts.get(v) ?? []) { const l = out.get(f) ?? []; l.push(v); out.set(f, l); }
    }
    return { refs: [...out].map(([i, vals]) => ({ index: i, name: this.funcName(i), values: vals })).slice(0, 2000) };
  }
  op_mod_searchCode(a: { filter: MatchSpec; limit?: number; budgetMs?: number }) {
    const m = this.model();
    const test = compileMatcher(a.filter);
    const limit = Math.min(a.limit ?? 500, 5000);
    const deadline = Date.now() + (a.budgetMs ?? 4000);
    const out: any[] = [];
    let scanned = 0;
    for (let i = 0; i < m.bodies.length && out.length < limit; i++) {
      if ((i & 31) === 0 && Date.now() > deadline) break;
      const b = m.bodies[i]!;
      const d = disassembleBody(m.bytes, b.start, b.end, { branchComments: false });
      scanned++;
      for (const l of d.lines) {
        if (test(l.text)) { out.push({ index: m.numImportedFuncs + i, name: this.funcName(m.numImportedFuncs + i), off: l.off, text: l.text }); if (out.length >= limit) break; }
      }
    }
    return { rows: out, scanned, total: m.bodies.length, complete: scanned === m.bodies.length };
  }
  async op_mod_validatePatch(a: { index: number; code: string; locals?: string | null }) {
    const m = this.model();
    const { rewriteModule } = await import("../wasm/rewrite");
    const rr = rewriteModule(m, { instrument: null, patches: [{ index: a.index, code: fromHex(a.code), locals: a.locals ? fromHex(a.locals) : null }] });
    try {
      // use the native compile so this validation never re-enters our own hook
      const native = (globalThis as any).__cetusNative;
      await (native?.compile ?? WebAssembly.compile)(rr.bytes as BufferSource);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  op_mod_funcHex(a: { index: number }) {
    const m = this.model();
    const b = m.bodies[a.index - m.numImportedFuncs];
    if (!b) throw new RangeError("no such function body");
    return { hex: hex(m.bytes.subarray(b.start, b.end)) };
  }
  op_mod_dataSegment(a: { index: number; len?: number }) {
    const m = this.model();
    const d = m.data[a.index];
    if (!d) throw new RangeError("no such data segment");
    return { hex: hex(m.bytes.subarray(d.dataStart, d.dataStart + Math.min(d.size, a.len ?? 4096))) };
  }
  op_mod_download() {
    const blob = new Blob([this.rec.orig as BlobPart], { type: "application/wasm" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = (this.url.split("/").pop() || "module").replace(/[^\w.-]+/g, "_");
    a.download = `${base}.${this.id}.wasm`;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return { size: this.rec.orig.length };
  }
}
