import { h, toast, errMsg, fmtBytes } from "./ui";
import { initApi, getTargets, getCurrent, setCurrent, onTargets, onEvent, refreshTargets, reloadTarget, loadPageData, savePageData, pageKey, rpc, PageData, Bookmark, isDevtools, Target, getUi, saveUi, onUi } from "./api";
import { Ctx, View } from "./ctx";
import { scannerView } from "./views/scanner";
import { stringsView } from "./views/strings";
import { memoryView } from "./views/memory";
import { cheatView } from "./views/cheat";
import { functionsView } from "./views/functions";
import { moduleView } from "./views/module";
import { codeView } from "./views/code";
import { debuggerView } from "./views/debugger";
import { toolsView } from "./views/tools";
import { scriptsView } from "./views/scripts";
import { cachedScripts, runScriptOnTarget } from "./scriptstore";
import { comboFromEvent } from "../shared/hotkey";

declare const chrome: any;
let data: PageData = { bookmarks: [], names: {}, breakpoints: [], lineBps: [] };
let currentView = "scanner";
const views = new Map<string, View>();

const ctx: Ctx = {
  go: (v, p) => showView(v, p),
  openMemory: (addr) => showView("memory", { addr }),
  openCode: (func, off) => showView("code", { func, off }),
  async addBookmark(addr, type = "i32", desc = "") {
    if (data.bookmarks.some((b) => b.addr === addr && b.type === type)) return toast("already in the cheat table", "info", 1500);
    const b: Bookmark = { id: Math.random().toString(36).slice(2), addr, type, desc, freeze: false, freezeMode: "hard" };
    data.bookmarks.push(b);
    await ctx.saveData();
    toast(`Added 0x${addr.toString(16)} to cheat table`, "ok", 1400);
    if (currentView === "cheat") views.get("cheat")?.show?.();
  },
  async addPathBookmark(chain, type = "i32", desc = "", len) {
    const key = (c: { base: number; offsets: number[]; global?: number }) => `${c.global !== undefined ? "g" + c.global : c.base}:${c.offsets.join(",")}`;
    if (data.bookmarks.some((b) => b.ptr && key(b.ptr) === key(chain) && b.type === type)) return toast("already in the cheat table", "info", 1500);
    const b: Bookmark = { id: Math.random().toString(36).slice(2), addr: 0, type, desc, freeze: false, freezeMode: "hard", ptr: { base: chain.base, offsets: [...chain.offsets], ...(chain.global !== undefined ? { global: chain.global } : {}) } };
    if (len) b.len = len;
    data.bookmarks.push(b);
    await ctx.saveData();
    toast("Added pointer path to cheat table", "ok", 1600);
    if (currentView === "cheat") views.get("cheat")?.show?.();
  },
  data: () => data,
  saveData: () => savePageData(data, pageKey(getCurrent())),
  target: () => getCurrent(),
};

const NAV: [string, string, string, () => View][] = [
  ["scanner", "⌕", "Scanner", () => scannerView(ctx)],
  ["strings", "”", "Strings", () => stringsView(ctx)],
  ["memory", "▦", "Memory", () => memoryView(ctx)],
  ["cheat", "☰", "Cheat table", () => cheatView(ctx)],
  ["scripts", "▶", "Scripts", () => scriptsView(ctx)],
  ["-", "", "", null as any],
  ["functions", "ƒ", "Functions", () => functionsView(ctx)],
  ["code", "≣", "Code", () => codeView(ctx)],
  ["module", "▤", "Module", () => moduleView(ctx)],
  ["debugger", "◉", "Debugger", () => debuggerView(ctx)],
  ["-", "", "", null as any],
  ["tools", "⚙", "Tools & Settings", () => toolsView(ctx)],
];

const app = document.getElementById("app")!;
const targetSel = h("select", { id: "target", title: "which page / WebAssembly instance to analyse" });
const nav = h("nav");
const main = h("main");
const statusL = h("span");
const statusR = h("span", { style: { marginLeft: "auto" } });
const liveBtn = h("button", { title: "pause / resume all automatic refreshing (intervals: Tools & Settings)", onclick: () => void saveUi({ live: !getUi().live }) });
const renderLive = () => { liveBtn.textContent = getUi().live ? "● Live" : "⏸ Paused"; liveBtn.className = getUi().live ? "on" : ""; };
onUi(renderLive); renderLive();
const badges = h("span", { class: "row", style: { gap: "6px" } });

app.append(
  h("header", null, h("span", { class: "logo" }, "CETUS"), targetSel,
    h("button", { class: "icon", title: "rescan tabs for WebAssembly instances", onclick: () => { void refreshTargets(); toast("Scanning tabs…", "info", 900); } }, "↻"),
    liveBtn,
    h("button", { title: "reload the target tab so Cetus can hook WebAssembly from the start", onclick: () => void reloadTarget() }, "Reload page"), badges),
  nav, main, h("footer", null, statusL, statusR));

for (const [id, ico, label, make] of NAV) {
  if (id === "-") { nav.appendChild(h("div", { class: "sep" })); continue; }
  const v = make();
  v.el.id = "view-" + id;
  main.appendChild(v.el);
  views.set(id, v);
  nav.appendChild(h("button", { dataset: { view: id }, onclick: () => showView(id) }, h("span", { class: "ico" }, ico), label));
}
const empty = h("div", { class: "view", id: "view-empty" }, h("div", { class: "hero" },
  h("h2", null, "No WebAssembly page found yet"),
  h("p", null, "Open the page or game you want to analyse in another tab, then ", h("b", null, "reload it"), " — Cetus hooks WebAssembly while the page loads, so tabs that were already open before the extension was installed or reloaded need a refresh."),
  h("p", null, "Games embedded in an ", h("code", null, "<iframe>"), " are detected automatically and shown in the target list above. WebAssembly created inside Web Workers is not reachable by extensions."),
  h("p", { class: "muted" }, "Cetus never changes anything until you use it: modules are only rewritten to add (idle) watch hooks.")));
main.appendChild(empty);

function showView(id: string, params?: any) {
  if (!getCurrent() && id !== "tools") id = "empty";
  views.get(currentView)?.hide?.();
  currentView = id === "empty" ? currentView : id;
  main.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  nav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.view === currentView));
  if (id === "empty") { empty.classList.add("active"); return; }
  const v = views.get(id)!;
  v.el.classList.add("active");
  v.show?.(params);
  if (location.hash.slice(1) !== id) history.replaceState(null, "", "#" + id);
}

let lastKey = "";
let shownKey = "";
async function targetChanged() {
  const t = getCurrent();
  const all = getTargets();
  targetSel.replaceChildren(...(all.length ? all.map((x) => {
    const host = (() => { try { return new URL(x.tabUrl).host; } catch { return x.info.url; } })();
    return h("option", { value: x.key, selected: t?.key === x.key }, `${x.title.slice(0, 40) || host} — ${host}${x.frameId ? " (frame " + x.frameId + ")" : ""} · #${x.inst} · ${fmtBytes(x.info.memBytes)} · ${x.info.funcs} fns`);
  }) : [h("option", { value: "" }, "— no WebAssembly instance —")]));
  if (t) targetSel.value = t.key;
  renderBadges(t);
  statusL.textContent = t ? `${t.tabUrl}` : "waiting for a page that uses WebAssembly…";
  statusR.textContent = `${all.length} instance${all.length === 1 ? "" : "s"}`;
  const key = t ? t.key : "";
  if (key !== lastKey) {
    lastKey = key;
    data = t ? await loadPageData(pageKey(t)) : { bookmarks: [], names: {}, breakpoints: [], lineBps: [] };
    if (t && Object.keys(data.names).length) await rpc("mod.names", { names: data.names }).catch(() => {});
    for (const v of views.values()) v.retarget?.();
  }
  if (!t) showView("empty");
  else if (empty.classList.contains("active") || currentView === "") showView(currentView || "scanner");
  else if (key !== shownKey) views.get(currentView)?.show?.(); // only when the target actually changed
  shownKey = key;
}

function renderBadges(t: Target | null | undefined) {
  badges.replaceChildren();
  if (!t) return;
  const i = t.info;
  const b = (txt: string, cls: string, title: string) => badges.appendChild(h("span", { class: "badge " + cls, title }, txt));
  b(i.instrumented ? "instrumented" : "not instrumented", i.instrumented ? "ok" : "err", i.error ?? i.notes.join("\n") ?? "");
  if (i.instrumented) b(`W${i.features.write ? "✓" : "✗"} R${i.features.read ? "✓" : "✗"} F${i.features.funcHooks ? "✓" : "✗"}`, "", "write / read / function hooks");
  if (i.patched.length) b(`${i.patched.length} patched`, "warn", "functions replaced by saved patches");
  if (!i.hasMemory) b("no memory", "err", "no WebAssembly.Memory could be located");
}

targetSel.addEventListener("change", () => { setCurrent(targetSel.value || null); });
onTargets(() => void targetChanged());
onEvent((type, d, t) => { if (t && t.key === getCurrent()?.key) views.get(currentView)?.onEvent?.(type, d); });
// script hotkeys also work while the workspace itself has focus (the in-page ones live in the content script)
window.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t?.closest?.("input,textarea,select") && !(e.ctrlKey || e.altKey || e.metaKey)) return;
  const combo = comboFromEvent(e);
  const store = cachedScripts();
  if (!combo || !store || !getCurrent()) return;
  const key = pageKey(getCurrent());
  const s = store.folders.flatMap((f) => f.scripts).find((x) => x.enabled && x.hotkey === combo && (x.scope === "*" || x.scope === key));
  if (!s || (t?.id === "hotkey-rec")) return;
  if (currentView === "scripts" && (t as HTMLInputElement)?.placeholder?.startsWith("click & press")) return;
  e.preventDefault();
  runScriptOnTarget(s, ctx).catch((er) => toast(errMsg(er), "error"));
}, true);
window.addEventListener("hashchange", () => { const id = location.hash.slice(1); if (views.has(id)) showView(id); });
window.addEventListener("unhandledrejection", (e) => toast(errMsg(e.reason), "error"));

if (isDevtools) {
  const tab = chrome.devtools?.inspectedWindow?.tabId;
  if (tab !== undefined) onTargets(() => { const c = getCurrent(); if (!c || c.tabId !== tab) { const m = getTargets().find((x) => x.tabId === tab); if (m) setCurrent(m.key); } });
}
initApi();
const start = location.hash.slice(1);
currentView = views.has(start) ? start : "scanner";
void targetChanged().then(() => showView(currentView));
