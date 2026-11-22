import { normalizeCombo } from "./hotkey";

export interface Script {
  id: string;
  name: string;
  code: string;
  /** in-page hotkey, e.g. "Ctrl+Alt+2" (active while the game tab has focus) */
  hotkey: string;
  /** Chrome extension shortcut slot 1..4 (0 = none); the key is assigned in chrome://extensions/shortcuts */
  slot: 0 | 1 | 2 | 3 | 4;
  /** page key (host+path) the script belongs to, or "*" for every page */
  scope: string;
  enabled: boolean;
  /** no on-page toasts */
  silent: boolean;
}
export interface Folder { id: string; name: string; scripts: Script[] }
export interface ScriptStore { folders: Folder[] }

export const SCRIPTS_KEY = "cetusScripts";
export const uid = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const EXAMPLE_CODE = `// Cheat-table rows are variables: give a row a description (e.g. "Health") and use it by name.
// Assign numbers or text, compare, loop, wait. Press the hotkey again to stop a running loop.
Health = 999
Gold += 100
// TextFromAddress = "Text From Script"      // a text row (type str8 / str16)
// freeze(Health, 999)                        // keep it locked   (unfreeze(Health) releases)
// while (true) { Mana = 100; sleep(250) }    // keep refilling
log("done", Health)
`;

export function newScript(name: string, scope = "*", code = EXAMPLE_CODE): Script {
  return { id: uid(), name, code, hotkey: "", slot: 0, scope, enabled: true, silent: false };
}

export function defaultStore(): ScriptStore {
  return {
    folders: ["mockTesting", "UiTesting", "UserButtonTesting"].map((name, i) => ({
      id: uid(), name, scripts: i === 0 ? [newScript("Example")] : [],
    })),
  };
}

export function normalizeStore(x: unknown): ScriptStore {
  const s = x as Partial<ScriptStore> | undefined;
  if (!s || !Array.isArray(s.folders)) return defaultStore();
  return {
    folders: s.folders.map((f) => ({
      id: f.id || uid(), name: String(f.name ?? "folder"),
      scripts: (f.scripts ?? []).map((sc) => ({
        id: sc.id || uid(), name: String(sc.name ?? "script"), code: String(sc.code ?? ""), hotkey: normalizeCombo(String(sc.hotkey ?? "")),
        slot: ([1, 2, 3, 4].includes(Number(sc.slot)) ? Number(sc.slot) : 0) as Script["slot"], scope: String(sc.scope ?? "*"), enabled: sc.enabled !== false, silent: !!sc.silent,
      })),
    })),
  };
}

export function exportJson(store: ScriptStore, folderIds?: string[]): string {
  const folders = store.folders.filter((f) => !folderIds || folderIds.includes(f.id));
  return JSON.stringify({ cetusScripts: 1, folders }, null, 2);
}

/** Merge an exported file into the store. Same-named folders are merged; duplicate script names get a suffix. */
export function importJson(store: ScriptStore, text: string): { folders: number; scripts: number; clearedKeys: number } {
  const j = JSON.parse(text);
  const incoming = normalizeStore(j.cetusScripts ? j : { folders: Array.isArray(j) ? j : [j] });
  let scripts = 0, folders = 0, clearedKeys = 0;
  const all = () => store.folders.flatMap((f) => f.scripts);
  for (const f of incoming.folders) {
    let dest = store.folders.find((x) => x.name === f.name);
    if (!dest) { dest = { id: uid(), name: f.name, scripts: [] }; store.folders.push(dest); folders++; }
    for (const sc of f.scripts) {
      let name = sc.name, n = 2;
      while (dest.scripts.some((x) => x.name === name)) name = `${sc.name} (${n++})`;
      // never let an import silently steal a hotkey / Chrome slot that another script already uses
      const taken = (k: "hotkey" | "slot") => sc[k] && all().some((x) => x[k] === sc[k] && (x.scope === "*" || sc.scope === "*" || x.scope === sc.scope));
      const hotkey = taken("hotkey") ? (clearedKeys++, "") : sc.hotkey;
      const slot = taken("slot") ? (clearedKeys++, 0 as const) : sc.slot;
      dest.scripts.push({ ...sc, id: uid(), name, hotkey, slot });
      scripts++;
    }
  }
  return { folders, scripts, clearedKeys };
}

export interface BookmarkLike { desc: string; type: string; addr: number; ptr?: { base: number; offsets: number[] } | undefined; len?: number | undefined }
/** The rows a script can address: every cheat-table row that has a description. */
export function rowsForScript(bms: BookmarkLike[]) {
  return bms.filter((b) => b.desc && b.desc.trim()).map((b) => ({ label: b.desc.trim(), type: b.type, addr: b.addr, ...(b.ptr ? { ptr: b.ptr } : {}), ...(b.len !== undefined ? { len: b.len } : {}) }));
}
