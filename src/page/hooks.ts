import { ModuleRec, PageConfig } from "./module-rec";
import { CetusInstance, Emit } from "./instance";
import { rewriteModule } from "../wasm/rewrite";

export interface Registry {
  instances: CetusInstance[];
}

function toU8(src: BufferSource): Uint8Array {
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  return new Uint8Array(src as ArrayBuffer);
}

export function installHooks(opts: {
  cfg: () => PageConfig;
  ready: () => Promise<void>;
  registry: Registry;
  emit: Emit;
  log: (msg: string) => void;
}): void {
  const W = WebAssembly as any;
  const N = {
    instantiate: W.instantiate.bind(W),
    compile: W.compile.bind(W),
    compileStreaming: W.compileStreaming?.bind(W),
    instantiateStreaming: W.instantiateStreaming?.bind(W),
    Module: W.Module as typeof WebAssembly.Module,
    Instance: W.Instance as typeof WebAssembly.Instance,
  };
  Object.defineProperty(window, "__cetusNative", { value: N, enumerable: false });
  const modRecs = new WeakMap<object, ModuleRec>();

  const prepare = (src: BufferSource): ModuleRec => {
    const t0 = performance.now();
    let rec: ModuleRec;
    try {
      rec = new ModuleRec(toU8(src), opts.cfg());
    } catch (e) {
      console.error("[cetus] module processing crashed; loading original", e);
      rec = new ModuleRec(new Uint8Array(0), { ...opts.cfg(), enabled: false });
      rec.out = toU8(src);
      rec.orig = rec.out;
    }
    if (isInstrumented(rec) && rec.model!.memories.some((m) => m.limits.shared)) void ensurePlain(rec); // threaded module: workers will need it
    opts.log(`module ${rec.orig.length} bytes processed in ${(performance.now() - t0).toFixed(0)} ms` + (rec.error ? ` (${rec.error})` : ""));
    return rec;
  };

  const makeInstance = (rec: ModuleRec, importObject: any): CetusInstance => {
    const inst = new CetusInstance(rec, opts.cfg(), opts.emit, location.host + location.pathname);
    if (rec.rr && rec.rr.K) importObject.__cetus = inst.imports;
    return inst;
  };
  // Cetus must never break the host page: every bookkeeping step is guarded.
  const finish = (inst: CetusInstance, instance: WebAssembly.Instance | null, importObject: any) => {
    try {
      inst.attach(instance, importObject);
      opts.registry.instances.push(inst);
      opts.emit("instance", inst.info());
      opts.log(`instance #${inst.id} ready` + (inst.memory ? `, memory ${(inst.memory.buffer.byteLength / 65536) | 0} pages` : ", NO MEMORY FOUND"));
    } catch (e) {
      console.error("[cetus] failed to register instance", e);
    }
  };
  const withTimeout = async () => {
    await Promise.race([opts.ready(), new Promise((r) => setTimeout(r, 400))]);
  };

  // Modules built by Cetus import "__cetus". If one reaches an instantiate call through a path we
  // did not intercept (IndexedDB cache, another realm), satisfy the import with no-ops so the page never breaks.
  const noop = { hit() {}, fhit() {}, bp() {}, bpl() {} };
  const ensureNoopImports = (mod: WebAssembly.Module, imports: any) => {
    try {
      if (imports && typeof imports === "object" && !imports.__cetus && N.Module.imports(mod).some((i) => i.module === "__cetus")) imports.__cetus = noop;
    } catch { /* not a module */ }
  };

  // Web Workers (e.g. Emscripten pthreads) receive the compiled Module via postMessage and instantiate it
  // themselves. Content scripts do not run in workers, so they must get a plain build without Cetus imports.
  // NOTE: Chrome refuses synchronous `new WebAssembly.Module()` above 8 MB on the main thread, so the plain
  // build is compiled asynchronously and the postMessage is deferred (in order) until it is ready.
  const isInstrumented = (rec: ModuleRec | undefined): rec is ModuleRec => !!rec && !!rec.rr && rec.rr.K > 0 && !!rec.model;
  const ensurePlain = (rec: ModuleRec): Promise<WebAssembly.Module | null> => {
    if (rec.plain) return Promise.resolve(rec.plain);
    if (!rec.plainP) {
      rec.plainP = (async () => {
        let bytes: Uint8Array = rec.orig;
        if (rec.patchList.length) {
          try { bytes = rewriteModule(rec.model!, { instrument: null, patches: rec.patchList }).bytes; } catch { bytes = rec.orig; }
        }
        try {
          rec.plain = await N.compile(bytes as BufferSource);
          opts.log(`worker-safe module ready (${bytes.length} bytes)`);
        } catch (e) {
          console.error("[cetus] could not build the worker-safe module; workers would receive the instrumented one", e);
          rec.plain = null;
        }
        return rec.plain;
      })();
    }
    return rec.plainP;
  };
  const collect = (v: any, out: Set<ModuleRec>, depth = 0): void => {
    if (v instanceof N.Module) { const r = modRecs.get(v); if (isInstrumented(r)) out.add(r); return; }
    if (depth > 4 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) collect(x, out, depth + 1); return; }
    if (Object.getPrototypeOf(v) !== Object.prototype) return;
    for (const k of Object.keys(v)) collect(v[k], out, depth + 1);
  };
  const substitute = (v: any, depth = 0): any => {
    if (v instanceof N.Module) { const r = modRecs.get(v); return isInstrumented(r) && r.plain ? r.plain : v; }
    if (depth > 4 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => { const y = substitute(x, depth + 1); if (y !== x) changed = true; return y; });
      return changed ? out : v;
    }
    if (Object.getPrototypeOf(v) !== Object.prototype) return v;
    let copy: any = null;
    for (const k of Object.keys(v)) {
      const y = substitute(v[k], depth + 1);
      if (y !== v[k]) { if (!copy) copy = { ...v }; copy[k] = y; }
    }
    return copy ?? v;
  };
  const queues = new WeakMap<object, Promise<void>>();
  for (const proto of [typeof Worker !== "undefined" ? Worker.prototype : null, typeof MessagePort !== "undefined" ? MessagePort.prototype : null]) {
    if (!proto) continue;
    const orig = proto.postMessage as (...a: unknown[]) => void;
    (proto as any).postMessage = function (this: object, msg: unknown, ...rest: unknown[]) {
      let need: Set<ModuleRec>;
      try { need = new Set(); collect(msg, need); } catch { need = new Set(); }
      const pendingQ = queues.get(this);
      const wait = [...need].filter((r) => !r.plain);
      if (!pendingQ && !wait.length) {
        let m = msg;
        try { m = substitute(msg); } catch { /* send as is */ }
        return orig.call(this, m, ...rest);
      }
      // defer, but keep message order for this target
      const p: Promise<void> = (pendingQ ?? Promise.resolve())
        .then(() => Promise.all(wait.map(ensurePlain)))
        .then(() => { let m = msg; try { m = substitute(msg); } catch { /* as is */ } orig.call(this, m, ...rest); })
        .catch((e) => { console.error("[cetus] deferred postMessage failed", e); try { orig.call(this, msg, ...rest); } catch { /* ignore */ } });
      queues.set(this, p);
      void p.finally(() => { if (queues.get(this) === p) queues.delete(this); });
    };
  }

  // ---- compile --------------------------------------------------------------
  W.compile = async function (src: BufferSource) {
    await withTimeout();
    const rec = prepare(src);
    const mod = await N.compile(rec.out);
    modRecs.set(mod, rec);
    return mod;
  };
  if (N.compileStreaming) {
    W.compileStreaming = async function (src: Response | Promise<Response>) {
      const res = await src;
      const buf = await res.arrayBuffer();
      await withTimeout();
      const rec = prepare(buf);
      const mod = await N.compile(rec.out);
      modRecs.set(mod, rec);
      return mod;
    };
  }

  // ---- instantiate ----------------------------------------------------------
  W.instantiate = async function (src: any, imports?: any) {
    imports = imports ?? {};
    if (src instanceof N.Module) {
      let rec = modRecs.get(src);
      if (!rec) { rec = new ModuleRec(new Uint8Array(0), { ...opts.cfg(), enabled: false }); ensureNoopImports(src, imports); }
      const inst = makeInstance(rec, imports);
      const instance = await N.instantiate(src, imports);
      finish(inst, instance, imports);
      return instance;
    }
    await withTimeout();
    const rec = prepare(src);
    const inst = makeInstance(rec, imports);
    const res = await N.instantiate(rec.out, imports);
    modRecs.set(res.module, rec);
    finish(inst, res.instance, imports);
    return res;
  };
  if (N.instantiateStreaming) {
    W.instantiateStreaming = async function (src: Response | Promise<Response>, imports?: any) {
      imports = imports ?? {};
      const res = await src;
      const buf = await res.arrayBuffer();
      await withTimeout();
      const rec = prepare(buf);
      const inst = makeInstance(rec, imports);
      const out = await N.instantiate(rec.out, imports);
      modRecs.set(out.module, rec);
      finish(inst, out.instance, imports);
      return out;
    };
  }

  // ---- constructors -----------------------------------------------------------
  W.Module = new Proxy(N.Module, {
    construct(target, args) {
      const rec = prepare(args[0]);
      const mod = new target(rec.out as BufferSource);
      modRecs.set(mod, rec);
      return mod;
    },
  });
  W.Instance = new Proxy(N.Instance, {
    construct(target, args) {
      const module = args[0];
      const imports = args[1] ?? {};
      args[1] = imports;
      let rec = modRecs.get(module);
      if (!rec) { rec = new ModuleRec(new Uint8Array(0), { ...opts.cfg(), enabled: false }); ensureNoopImports(module, imports); }
      const inst = makeInstance(rec, imports);
      const instance = new target(module, imports);
      finish(inst, instance, imports);
      return instance;
    },
  });
}
