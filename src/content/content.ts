/**
 * Isolated-world content script: relays between the page (main world) and the extension, and owns the
 * in-page script hotkeys (so they work while playing, with or without the workspace tab open).
 */
import { comboFromEvent } from "../shared/hotkey";
import { SCRIPTS_KEY, Script, normalizeStore, rowsForScript } from "../shared/scriptstore";

const FLAG = "__cetusContentLoaded";
if (!(window as any)[FLAG]) {
  (window as any)[FLAG] = true;

  const pageKey = () => location.host + location.pathname;
  let cfgJson: string | null = null;

  const pushConfig = () => { if (cfgJson) window.dispatchEvent(new CustomEvent("cetus:cfg", { detail: cfgJson })); };
  window.addEventListener("cetus:hello", pushConfig);
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(n) | 0));

  const loadConfig = () => {
    try {
      chrome.storage.local.get(["savedOptions", "savedPatches", "cetusPageData"], (r) => {
        const o = (r?.savedOptions ?? {}) as any;
        const patches = ((r?.savedPatches ?? []) as any[]).filter((p) => p && p.enabled && p.url === pageKey());
        cfgJson = JSON.stringify({
          enabled: o.enabled !== false,
          instrument: {
            slots: clamp(o.wpCount ?? 8, 0, 16),
            write: (o.enableWatchpoints ?? 7) & 6 ? true : false,
            read: (o.enableWatchpoints ?? 7) & 1 ? true : false,
            funcHooks: o.funcHooks !== false,
            funcSlots: clamp(o.funcSlots ?? 8, 0, 16),
          },
          patches, pauseOnHit: !!o.pauseOnHit, logLevel: o.logLevel ?? 0,
          sharedCtrl: Number.isInteger(o.sharedCtrl) && o.sharedCtrl >= 8 && (o.sharedCtrl & 7) === 0 ? o.sharedCtrl : 0x20,
          lineBps: ((r?.cetusPageData?.[pageKey()]?.lineBps ?? []) as any[]).filter((b) => Number.isInteger(b?.func) && Number.isInteger(b?.off)).map((b) => ({ func: b.func, off: b.off, enabled: b.enabled !== false, cond: b.cond || "", pause: !!b.pause })),
        });
        pushConfig();
      });
    } catch { /* extension context invalidated */ }
  };
  loadConfig();

  // ---------------------------------------------------------------- page bridge
  let rid = 1;
  function callPage(inst: number, op: string, args: unknown, timeoutMs = 60000): Promise<any> {
    return new Promise((resolve) => {
      const id = rid++;
      let done = false;
      const onRes = (e: Event) => {
        let r: any;
        try { r = JSON.parse((e as CustomEvent).detail); } catch { return; }
        if (r.rid !== id) return;
        done = true; window.removeEventListener("cetus:res", onRes); resolve(r);
      };
      window.addEventListener("cetus:res", onRes);
      window.dispatchEvent(new CustomEvent("cetus:req", { detail: JSON.stringify({ rid: id, inst, op, args }) }));
      setTimeout(() => { if (!done) { window.removeEventListener("cetus:res", onRes); resolve({ rid: id, ok: false, error: "page did not answer (is it busy?)" }); } }, timeoutMs);
    });
  }

  window.addEventListener("cetus:evt", (e) => {
    try {
      if (!chrome.runtime?.id) return;
      chrome.runtime.sendMessage({ cetus: "event", ...JSON.parse((e as CustomEvent).detail) }).catch(() => {});
    } catch { /* no listener / context invalidated */ }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.cetus === "announce") { void callPage(-1, "announce", null, 5000); return false; }
    if (msg && msg.cetus === "runSlot") { void runBySlot(Number(msg.slot)); return false; }
    if (!msg || msg.cetus !== "req") return false;
    void callPage(msg.inst, msg.op, msg.args).then(sendResponse);
    return true;
  });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.savedOptions || ch.savedPatches || ch.cetusPageData) loadConfig();
    if (ch[SCRIPTS_KEY]) void loadScripts();
  });

  // ---------------------------------------------------------------- script hotkeys
  let scripts: Script[] = [];
  const mine = (s: Script) => s.enabled && (s.scope === "*" || s.scope === pageKey());
  async function loadScripts() {
    try {
      const r = await chrome.storage.local.get(SCRIPTS_KEY);
      scripts = normalizeStore(r[SCRIPTS_KEY]).folders.flatMap((f) => f.scripts).filter(mine);
    } catch { scripts = []; }
  }
  void loadScripts();

  async function runScript(s: Script) {
    let bms: any[] = [];
    try { bms = ((await chrome.storage.local.get("cetusPageData")).cetusPageData?.[pageKey()]?.bookmarks ?? []) as any[]; } catch { /* ignore */ }
    const r = await callPage(-1, "script.run", { id: s.id, name: s.name, code: s.code, rows: rowsForScript(bms), silent: s.silent }, 15000);
    // frames without a WebAssembly instance answer with an error; that is expected and silent
    if (!r.ok && !/no WebAssembly instance/.test(r.error ?? "")) console.warn("[cetus] script failed:", r.error);
  }
  async function runBySlot(slot: number) {
    if (!scripts.length) await loadScripts();
    const s = scripts.find((x) => x.slot === slot);
    if (s) void runScript(s);
  }

  window.addEventListener("keydown", (e) => {
    if (!scripts.length || e.repeat) return;
    const combo = comboFromEvent(e);
    if (!combo) return;
    const s = scripts.find((x) => x.hotkey === combo);
    if (!s) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    void runScript(s);
  }, true);
}
export {};
