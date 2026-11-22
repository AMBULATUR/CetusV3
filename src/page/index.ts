/**
 * Main-world entry. Runs at document_start, before any page script, and wraps the
 * WebAssembly API so every module is analysed / instrumented / patched.
 *
 * Transport (to the isolated-world content script, which relays to the extension):
 *   cetus:cfg   content -> page   { ...PageConfig }
 *   cetus:hello page -> content   ask for config
 *   cetus:req   content -> page   { rid, inst, op, args }
 *   cetus:res   page -> content   { rid, ok, result | error }
 *   cetus:evt   page -> content   { type, data }
 */
import { DEFAULT_CONFIG, PageConfig } from "./module-rec";
import { installHooks, Registry } from "./hooks";

declare global {
  interface Window { __cetus?: unknown }
}

if (!(window as any).__cetus) {
  const cfg: PageConfig = { ...DEFAULT_CONFIG };
  let resolveReady: () => void;
  const readyP = new Promise<void>((r) => (resolveReady = r));
  const registry: Registry = { instances: [] };

  const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  const emit = (type: string, data: unknown) => {
    window.dispatchEvent(new CustomEvent("cetus:evt", { detail: json({ type, data }) }));
  };
  const log = (msg: string) => {
    if (cfg.logLevel > 0) console.log("%c CETUS ", "background:#0e7490;color:#fff;border-radius:3px", msg);
  };

  window.addEventListener("cetus:cfg", (e) => {
    try {
      Object.assign(cfg, JSON.parse((e as CustomEvent).detail));
      resolveReady();
    } catch (err) {
      console.error("[cetus] bad config", err);
    }
  });

  window.addEventListener("cetus:req", async (e) => {
    let rid = -1;
    try {
      const req = JSON.parse((e as CustomEvent).detail);
      rid = req.rid;
      let result: unknown;
      if (req.inst === -1) {
        if (req.op === "list") result = registry.instances.map((i) => i.info());
        else if (req.op === "script.run" || req.op === "script.stop") {
          // hotkey path: no explicit instance — use the one with memory (largest wins)
          const cands = registry.instances.filter((i) => i.memory);
          const pick = (req.args?.inst !== undefined ? cands.find((i) => i.id === req.args.inst) : null) ?? cands.sort((a, b) => b.memory!.buffer.byteLength - a.memory!.buffer.byteLength)[0];
          if (!pick) throw new Error("no WebAssembly instance in this frame");
          result = await pick.handle(req.op, req.args);
        }
        else if (req.op === "announce") { for (const i of registry.instances) emit("instance", i.info()); result = true; }
        else throw new Error("unknown global op " + req.op);
      } else {
        const inst = registry.instances.find((i) => i.id === req.inst);
        if (!inst) throw new Error("instance no longer exists (page reloaded?)");
        result = await inst.handle(req.op, req.args);
      }
      window.dispatchEvent(new CustomEvent("cetus:res", { detail: json({ rid, ok: true, result }) }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent("cetus:res", { detail: json({ rid, ok: false, error: String((err as Error)?.message ?? err) }) }));
    }
  });

  window.addEventListener("pagehide", () => emit("quit", { all: true }));

  Object.defineProperty(window, "__cetus", { value: { registry, cfg }, enumerable: false });
  installHooks({ cfg: () => cfg, ready: () => readyP, registry, emit, log });
  window.dispatchEvent(new CustomEvent("cetus:hello"));
}
export {};
