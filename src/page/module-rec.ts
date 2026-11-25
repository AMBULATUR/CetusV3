import { ModuleModel, parseModule } from "../wasm/module";
import { rewriteModule, RewriteResult, FunctionPatch, InstrumentConfig, BpRequest, CTRL } from "../wasm/rewrite";
import { fromHex, fromBase64 } from "../wasm/leb";
import { Analysis, analyze } from "../wasm/analysis";

export interface StoredFunctionPatch {
  index: number | string;
  /** v2: hex of instruction bytes */
  code?: string;
  /** v2: hex of locals vector (count + entries) */
  locals?: string;
  /** legacy: instruction bytes (array / object with numeric keys / base64 string) */
  bytes?: unknown;
}
export interface StoredPatch {
  name: string;
  url: string;
  enabled: boolean;
  functionPatches?: StoredFunctionPatch[];
  index?: number | string;
  bytes?: unknown;
}

export interface PageConfig {
  enabled: boolean;
  instrument: InstrumentConfig;
  patches: StoredPatch[];
  pauseOnHit: boolean;
  logLevel: number;
  /** line breakpoints saved for this page (compiled in at load time) */
  lineBps: { func: number; off: number; enabled: boolean; cond?: string; pause?: boolean }[];
  /** where threaded (shared-memory) modules keep their watch table; must be a free, 8-byte aligned address */
  sharedCtrl?: number;
}

export const DEFAULT_CONFIG: PageConfig = {
  enabled: true,
  instrument: { slots: 8, write: true, read: true, funcHooks: true, funcSlots: 8 },
  patches: [],
  pauseOnHit: false,
  logLevel: 0,
  lineBps: [],
};

function legacyBytes(b: unknown): Uint8Array {
  if (b instanceof Uint8Array) return b;
  if (Array.isArray(b)) return Uint8Array.from(b as number[]);
  if (typeof b === "string") {
    try { return fromBase64(b); } catch { return fromHex(b); }
  }
  if (b && typeof b === "object") return Uint8Array.from(Object.values(b as Record<string, number>));
  throw new Error("unrecognised patch byte format");
}

export function collectPatches(list: StoredPatch[]): FunctionPatch[] {
  const out: FunctionPatch[] = [];
  for (const p of list) {
    if (!p.enabled) continue;
    const fps = p.functionPatches ?? (p.index !== undefined ? [{ index: p.index, bytes: p.bytes }] : []);
    for (const fp of fps) {
      const index = Number(fp.index);
      if (!Number.isInteger(index) || index < 0) continue;
      const code = fp.code !== undefined ? fromHex(fp.code) : legacyBytes(fp.bytes);
      out.push({ index, code, locals: fp.locals ? fromHex(fp.locals) : null });
    }
  }
  return out;
}

let nextModuleId = 1;

export class ModuleRec {
  id = nextModuleId++;
  model: ModuleModel | null = null;
  orig: Uint8Array;
  out: Uint8Array;
  rr: RewriteResult | null = null;
  error: string | null = null;
  notes: string[] = [];
  private _analysis: Analysis | null = null;
  userNames = new Map<number, string>();
  /** patches this record was built with (the worker-safe plain build re-applies them) */
  patchList: FunctionPatch[] = [];
  /**
   * Module handed to Web Workers. For threaded builds this is the import-free "worker-safe" instrumented
   * module (watchpoints armed in shared memory fire inside workers); otherwise the plain original.
   */
  plain: WebAssembly.Module | null = null;
  /** what `plain` is: "instrumented" (ring-buffer build) or "plain" */
  plainKind: "instrumented" | "plain" | null = null;
  instrument: InstrumentConfig | null = null;
  sharedCtrl: number = CTRL.DEFAULT_ADDR;
  /** pending async compile of the plain build (sync compile is capped at 8 MB on the main thread) */
  plainP: Promise<WebAssembly.Module | null> | null = null;

  constructor(bytes: Uint8Array, cfg: PageConfig) {
    this.orig = bytes.slice();
    this.out = this.orig;
    if (!cfg.enabled) { this.notes.push("Cetus disabled by settings"); this.tryParse(); return; }
    let patches: FunctionPatch[] = [];
    try { patches = collectPatches(cfg.patches); } catch (e) { this.notes.push("patch error: " + (e as Error).message); }
    this.patchList = patches;
    this.instrument = cfg.instrument;
    this.sharedCtrl = cfg.sharedCtrl ?? CTRL.DEFAULT_ADDR;
    try {
      this.model = parseModule(this.orig);
      this.notes.push(...this.model.warnings);
    } catch (e) {
      this.error = "parse failed: " + (e as Error).message;
      return;
    }
    const bps: BpRequest[] = (cfg.lineBps ?? []).map((b) => ({ func: b.func, off: b.off, enabled: b.enabled }));
    const attempts: { label: string; cfg: InstrumentConfig | null; patches: FunctionPatch[]; bps: BpRequest[] }[] = [
      { label: "full instrumentation", cfg: cfg.instrument, patches, bps },
      { label: "without read hooks", cfg: { ...cfg.instrument, read: false }, patches, bps },
      { label: "without line breakpoints", cfg: cfg.instrument, patches, bps: [] },
      { label: "without instrumentation", cfg: null, patches, bps: [] },
      { label: "without patches", cfg: null, patches: [], bps: [] },
    ];
    for (const a of attempts) {
      try {
        const rr = rewriteModule(this.model, { instrument: a.cfg, patches: a.patches, bps: a.bps, shared: { ctrl: this.sharedCtrl } });
        if (!WebAssembly.validate(rr.bytes as BufferSource)) {
          let why = "validation failed";
          try { new WebAssembly.Module(rr.bytes as BufferSource); } catch (e) { why = (e as Error).message; }
          throw new Error(why);
        }
        this.rr = rr;
        this.out = rr.bytes;
        this.error = null;
        this.notes.push(...rr.warnings);
        if (a.label !== "full instrumentation") this.notes.push(`fell back to: ${a.label}`);
        return;
      } catch (e) {
        this.notes.push(`${a.label} failed: ${(e as Error).message}`);
        this.error = `${a.label} failed: ${(e as Error).message}`;
      }
    }
    this.out = this.orig;
    this.rr = null;
  }

  private tryParse(): void {
    try { this.model = parseModule(this.orig); } catch { /* ignore */ }
  }

  get analysis(): Analysis {
    if (!this._analysis) this._analysis = analyze(this.model!);
    return this._analysis;
  }

  get K(): number { return this.rr?.K ?? 0; }

  /**
   * Bytes for the module that Web Workers receive via postMessage. Workers run no Cetus code, so the module
   * must not import `__cetus`. If the main build keeps its watch table in shared memory we can still give
   * workers an instrumented build (hits go to the ring buffer); otherwise they get the plain module.
   */
  workerBytes(): { bytes: Uint8Array; instrumented: boolean } {
    if (this.model && this.rr?.shared && this.instrument) {
      try {
        const rr = rewriteModule(this.model, { instrument: { ...this.instrument, funcHooks: false }, patches: this.patchList, bps: this.rr.bp.reqs, shared: { ctrl: this.rr.shared.ctrl, ring: true } });
        if (rr.shared?.ring && rr.K === 0 && WebAssembly.validate(rr.bytes as BufferSource)) return { bytes: rr.bytes, instrumented: true };
        this.notes.push("worker-safe instrumented build was not produced; workers get the plain module");
      } catch (e) {
        this.notes.push("worker-safe build failed: " + (e as Error).message);
      }
    }
    let bytes: Uint8Array = this.orig;
    if (this.patchList.length && this.model) {
      try { bytes = rewriteModule(this.model, { instrument: null, patches: this.patchList }).bytes; } catch { bytes = this.orig; }
    }
    return { bytes, instrumented: false };
  }
}
