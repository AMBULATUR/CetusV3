import { toast, errMsg, quietFor } from "./ui";

export interface InstInfo {
  id: number; url: string; created: number; memBytes: number; hasMemory: boolean; shared: boolean;
  funcs: number; imported: number; moduleBytes: number; instrumented: boolean;
  features: { write: boolean; read: boolean; funcHooks: boolean; slots: number; funcSlots: number };
  patched: number[]; error: string | null; notes: string[]; hasNames: boolean; slotsUsed: number;
}
export interface Target { key: string; tabId: number; frameId: number; inst: number; title: string; tabUrl: string; info: InstInfo }

type Listener = () => void;
const targets = new Map<string, Target>();
let current: Target | null = null;
const targetListeners = new Set<Listener>();
const eventListeners = new Set<(type: string, data: any, t: Target | undefined) => void>();
const tabTitles = new Map<number, { title: string; url: string }>();

const inExt = typeof chrome !== "undefined" && !!chrome.runtime?.id;
export const isDevtools = new URLSearchParams(location.search).has("devtools");

export const getTargets = () => [...targets.values()];
export const getCurrent = () => current;
export const onTargets = (fn: Listener) => { targetListeners.add(fn); return () => targetListeners.delete(fn); };
export const onEvent = (fn: (type: string, data: any, t: Target | undefined) => void) => { eventListeners.add(fn); return () => eventListeners.delete(fn); };
const fireTargets = () => targetListeners.forEach((f) => f());

export function setCurrent(key: string | null): void {
  current = key ? targets.get(key) ?? null : null;
  if (current) localStorage.setItem("cetus.lastTarget", `${current.tabId}:${current.frameId}`);
  fireTargets();
}

async function tabInfo(tabId: number) {
  try {
    const t = await chrome.tabs.get(tabId);
    tabTitles.set(tabId, { title: t.title ?? "", url: t.url ?? "" });
  } catch { /* closed */ }
  return tabTitles.get(tabId) ?? { title: "", url: "" };
}

async function upsert(tabId: number, frameId: number, info: InstInfo) {
  const key = `${tabId}:${frameId}:${info.id}`;
  const ti = await tabInfo(tabId);
  const t: Target = { key, tabId, frameId, inst: info.id, title: ti.title, tabUrl: ti.url, info };
  const old = targets.get(key);
  const had = !!old;
  const sig = (i: InstInfo) => [i.memBytes, i.funcs, i.instrumented, i.hasMemory, i.error, i.patched.length, i.features.write, i.features.read, i.features.funcHooks].join("|");
  const changed = !old || sig(old.info) !== sig(info) || old.title !== t.title;
  targets.set(key, t);
  if (current?.key === key) current = t;
  if (!current) {
    const last = localStorage.getItem("cetus.lastTarget");
    const pref = getTargets().find((x) => `${x.tabId}:${x.frameId}` === last);
    // never auto-select the workspace's own tab
    current = pref ?? t;
  }
  if (changed) fireTargets();
  void had;
}

function removeWhere(pred: (t: Target) => boolean) {
  let changed = false;
  quietFor(5000);
  for (const [k, t] of targets) if (pred(t)) { targets.delete(k); changed = true; if (current?.key === k) current = null; }
  if (changed) {
    if (!current) current = getTargets()[0] ?? null;
    fireTargets();
  }
}

export async function refreshTargets(): Promise<void> {
  if (!inExt) return;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id === undefined || !t.url || /^(chrome|chrome-extension|devtools|edge|about):/.test(t.url)) continue;
    tabTitles.set(t.id, { title: t.title ?? "", url: t.url });
    chrome.tabs.sendMessage(t.id, { cetus: "announce" }).catch(() => {});
  }
}

export function initApi(): void {
  if (!inExt) return;
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.cetus !== "event" || sender.tab?.id === undefined) return;
    const tabId = sender.tab.id;
    const frameId = sender.frameId ?? 0;
    if (msg.type === "instance") void upsert(tabId, frameId, msg.data as InstInfo);
    else if (msg.type === "quit") removeWhere((t) => t.tabId === tabId && t.frameId === frameId);
    else {
      const t = getTargets().find((x) => x.tabId === tabId && x.frameId === frameId && (msg.data?.inst === undefined || x.inst === msg.data.inst));
      eventListeners.forEach((f) => f(msg.type, msg.data, t));
    }
  });
  chrome.tabs.onRemoved.addListener((id) => removeWhere((t) => t.tabId === id));
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (change.status === "loading") removeWhere((t) => t.tabId === id);
    if (change.title) { const i = tabTitles.get(id); if (i) i.title = change.title; }
  });
  void refreshTargets();
  setInterval(() => { if (!document.hidden) void refreshTargets(); }, 10000);
}

let actions = 0;
/** true while a user-initiated request is in flight; pollers back off so they never queue ahead of it */
export const isBusy = (): boolean => actions > 0;

/** `poll = true` marks a background refresh (never blocks user actions) */
export async function rpc<T = any>(op: string, args?: unknown, t: Target | null = current, poll = false): Promise<T> {
  if (!poll) actions++;
  try {
    return await rpcInner<T>(op, args, t);
  } finally {
    if (!poll) actions--;
  }
}

async function rpcInner<T>(op: string, args: unknown, t: Target | null): Promise<T> {
  if (!t) throw new Error("no target selected — open a page that uses WebAssembly and reload it");
  let r: any;
  try {
    r = await chrome.tabs.sendMessage(t.tabId, { cetus: "req", inst: t.inst, op, args }, { frameId: t.frameId });
  } catch (e) {
    console.warn("[cetus] rpc failed", op, String((e as Error)?.message ?? e));
    // only drop the target if the tab/frame is really gone; a slow or busy page keeps its target
    const msg = String((e as Error)?.message ?? e);
    if (/Receiving end does not exist|No tab with id|Could not establish connection/.test(msg)) removeWhere((x) => x.key === t.key);
    throw new Error(/closed before a response/.test(msg) ? "the page did not answer this request (it may be busy or navigating)" : "lost connection to the page (reloaded or closed). Pick the target again.");
  }
  if (!r) throw new Error("no response from page");
  if (!r.ok) {
    if (/no longer exists/.test(r.error)) removeWhere((x) => x.key === t.key);
    throw new Error(r.error);
  }
  return r.result as T;
}

export async function reloadTarget(): Promise<void> {
  if (!current) return;
  await chrome.tabs.reload(current.tabId);
  toast("Reloading target tab…");
}

// ------------------------------------------------------------ persistence ---
export const pageKey = (t: Target | null = current): string => {
  if (!t) return "";
  try { const u = new URL(t.info.url.startsWith("http") ? t.info.url : "http://" + t.info.url); return u.host + u.pathname; } catch { return t.info.url; }
};

export interface Bookmark {
  id: string; addr: number; type: string; desc: string;
  freeze: boolean; freezeMode: "timer" | "hard"; freezeValue?: string;
  watchR?: boolean; watchW?: boolean;
  /** text rows (str8 / str16): maximum size in bytes including the terminator */
  len?: number;
  /** pointer path: address = [[base]+o1]+o2… resolved live, so it survives game restarts */
  ptr?: { base: number; offsets: number[] };
  /** other chains found by the pointer scan, kept so they can be narrowed after a restart */
  ptrCandidates?: { base: number; offsets: number[] }[];
  /** settings of the scan that produced the candidates (so a later scan can use the same ones) */
  ptrParams?: { maxOff: number; levels: number; staticLo: number; staticHi: number; maxFrontier: number; maxResults: number };
}
export interface LineBp { func: number; off: number; enabled: boolean; cond?: string; pause?: boolean; text?: string }
export interface PageData { bookmarks: Bookmark[]; names: Record<string, string>; breakpoints: number[]; baseline?: number[] | undefined; lineBps: LineBp[] }

const DATA_KEY = "cetusPageData";
export async function loadPageData(key = pageKey()): Promise<PageData> {
  const all = ((await chrome.storage.local.get(DATA_KEY))[DATA_KEY] ?? {}) as Record<string, PageData>;
  const d = (all[key] ?? { bookmarks: [], names: {}, breakpoints: [], lineBps: [] }) as Partial<PageData>;
  return { bookmarks: d.bookmarks ?? [], names: d.names ?? {}, breakpoints: d.breakpoints ?? [], baseline: d.baseline, lineBps: d.lineBps ?? [] };
}
export async function savePageData(d: PageData, key = pageKey()): Promise<void> {
  const all = ((await chrome.storage.local.get(DATA_KEY))[DATA_KEY] ?? {}) as Record<string, PageData>;
  all[key] = d;
  await chrome.storage.local.set({ [DATA_KEY]: all });
}

export interface SavedPatch { name: string; url: string; enabled: boolean; created: number; functionPatches: { index: number; code: string; locals?: string; note?: string }[] }
export async function loadPatches(): Promise<SavedPatch[]> {
  return ((await chrome.storage.local.get("savedPatches")).savedPatches ?? []) as SavedPatch[];
}
export async function savePatches(p: SavedPatch[]): Promise<void> {
  await chrome.storage.local.set({ savedPatches: p });
}

export interface Options {
  enabled: boolean; openMode: "tab" | "window"; wpCount: number; enableWatchpoints: number;
  funcHooks: boolean; funcSlots: number; pauseOnHit: boolean; logLevel: number;
}
export const DEFAULT_OPTIONS: Options = { enabled: true, openMode: "tab", wpCount: 8, enableWatchpoints: 7, funcHooks: true, funcSlots: 8, pauseOnHit: false, logLevel: 0 };
export async function loadOptions(): Promise<Options> {
  const o = ((await chrome.storage.local.get("savedOptions")).savedOptions ?? {}) as Partial<Options>;
  return { ...DEFAULT_OPTIONS, ...o };
}
export async function saveOptions(o: Options): Promise<void> {
  await chrome.storage.local.set({ savedOptions: o });
}

export function safe<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch((e) => { toast(errMsg(e), "error"); return undefined; });
}

// ------------------------------------------------------------ live updates ---
export interface UiSettings {
  /** master switch for all background refreshing */
  live: boolean;
  /** refresh intervals in ms; 0 = off (use the ↻ buttons) */
  pollCheat: number; pollMemory: number; pollScanner: number; pollDebugger: number;
  /** stop refreshing while the workspace tab is not visible */
  pauseHidden: boolean;
}
export const DEFAULT_UI: UiSettings = { live: true, pollCheat: 500, pollMemory: 500, pollScanner: 1000, pollDebugger: 1500, pauseHidden: true };
let ui: UiSettings = { ...DEFAULT_UI };
const uiListeners = new Set<() => void>();
export const getUi = (): UiSettings => ui;
export const onUi = (fn: () => void) => { uiListeners.add(fn); return () => uiListeners.delete(fn); };
export async function loadUi(): Promise<UiSettings> {
  const r = ((await chrome.storage.local.get("cetusUi")).cetusUi ?? {}) as Partial<UiSettings>;
  ui = { ...DEFAULT_UI, ...r };
  return ui;
}
export async function saveUi(patch: Partial<UiSettings>): Promise<void> {
  ui = { ...ui, ...patch };
  uiListeners.forEach((f) => f());
  await chrome.storage.local.set({ cetusUi: ui });
}
if (inExt) void loadUi().then(() => uiListeners.forEach((f) => f()));
