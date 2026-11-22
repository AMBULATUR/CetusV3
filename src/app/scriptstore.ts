import { SCRIPTS_KEY, ScriptStore, Script, defaultStore, normalizeStore, rowsForScript } from "../shared/scriptstore";
import { rpc } from "./api";
import { Ctx } from "./ctx";
import { parseScript } from "../page/script";

let cache: ScriptStore | null = null;
const listeners = new Set<() => void>();

export async function loadScripts(): Promise<ScriptStore> {
  const r = await chrome.storage.local.get(SCRIPTS_KEY);
  if (!r[SCRIPTS_KEY]) { cache = defaultStore(); await chrome.storage.local.set({ [SCRIPTS_KEY]: cache }); }
  else cache = normalizeStore(r[SCRIPTS_KEY]);
  return cache;
}
export async function saveScripts(s: ScriptStore): Promise<void> {
  cache = s;
  await chrome.storage.local.set({ [SCRIPTS_KEY]: s });
}
export const cachedScripts = (): ScriptStore | null => cache;
export const onScriptsChanged = (f: () => void) => { listeners.add(f); return () => listeners.delete(f); };
if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((ch) => { if (ch[SCRIPTS_KEY]) { cache = normalizeStore(ch[SCRIPTS_KEY].newValue); listeners.forEach((f) => f()); } });
  void loadScripts();
}

/** Run (or, if already running, stop) a script on the selected target. Syntax is checked locally first. */
export async function runScriptOnTarget(s: Script, ctx: Ctx): Promise<{ started?: boolean; stopped?: boolean }> {
  parseScript(s.code); // throws ScriptError with a line number
  return rpc("script.run", { id: s.id, name: s.name, code: s.code, rows: rowsForScript(ctx.data().bookmarks), silent: s.silent });
}
