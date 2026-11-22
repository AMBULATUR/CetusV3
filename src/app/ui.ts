import { MatchSpec, MATCH_MODES, MatchMode } from "../shared/matcher";

type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Record<string, any> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "value") (el as any).value = v;
      else if (k === "checked" || k === "disabled" || k === "selected" || k === "readOnly" || k === "spellcheck") (el as any)[k] = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const hex = (n: number, pad = 8): string => "0x" + (n >>> 0).toString(16).padStart(pad, "0");
export const hexByte = (n: number): string => n.toString(16).padStart(2, "0");

export function parseNum(s: string): number {
  const t = s.trim().replace(/_/g, "");
  if (t === "") throw new Error("empty number");
  let v: number;
  if (/^-?0x[0-9a-f]+$/i.test(t)) v = t.startsWith("-") ? -parseInt(t.slice(3), 16) : parseInt(t, 16);
  else if (/^-?\d+$/.test(t)) v = parseInt(t, 10);
  else if (/^[0-9a-f]+h$/i.test(t)) v = parseInt(t.slice(0, -1), 16);
  else throw new Error(`"${s}" is not a number (use decimal or 0x…)`);
  return v;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KiB";
  return (n / 1048576).toFixed(1) + " MiB";
}

// ---------------------------------------------------------------- toasts ----
let lastLost = 0;
let quietUntil = 0;
/** suppress connection-loss toasts for a moment (the game page is reloading) */
export const quietFor = (ms: number): void => { quietUntil = Date.now() + ms; };
export function toast(msg: string, kind: "info" | "ok" | "error" = "info", ms = 3500): void {
  // transient while the game page reloads: the header / empty state already explain it
  if (kind === "error" && /^no target selected/.test(msg)) return;
  if (kind === "error" && /^lost connection to the page|did not answer this request/.test(msg)) { if (Date.now() < quietUntil || Date.now() - lastLost < 6000) return; lastLost = Date.now(); }
  let host = document.getElementById("toasts");
  if (!host) {
    host = h("div", { id: "toasts" });
    document.body.appendChild(host);
  }
  const t = h("div", { class: "toast " + kind }, msg);
  host.appendChild(t);
  setTimeout(() => t.remove(), kind === "error" ? Math.max(ms, 6000) : ms);
}

export const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);
export async function guard<T>(p: Promise<T> | (() => Promise<T>), onErr?: () => void): Promise<T | undefined> {
  try {
    return await (typeof p === "function" ? p() : p);
  } catch (e) {
    toast(errMsg(e), "error");
    onErr?.();
    return undefined;
  }
}

export function modal(title: string, body: Node, buttons: { label: string; primary?: boolean; onClick: () => boolean | void | Promise<boolean | void> }[]): () => void {
  const back = h("div", { class: "modal-back" });
  const close = () => back.remove();
  const foot = h("div", { class: "modal-foot" });
  for (const b of buttons) {
    foot.appendChild(
      h("button", { class: b.primary ? "primary" : "", onclick: async () => { if ((await b.onClick()) !== false) close(); } }, b.label),
    );
  }
  back.appendChild(h("div", { class: "modal" }, h("div", { class: "modal-head" }, title, h("button", { class: "icon", onclick: close }, "✕")), h("div", { class: "modal-body" }, body), foot));
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  const first = back.querySelector("input,textarea,select") as HTMLElement | null;
  first?.focus();
  return close;
}

export function promptText(title: string, label: string, value = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", value, style: { width: "100%" } });
    let done = false;
    const close = modal(title, h("label", { class: "stack" }, label, input), [
      { label: "Cancel", onClick: () => { if (!done) resolve(null); done = true; } },
      { label: "OK", primary: true, onClick: () => { done = true; resolve(input.value); } },
    ]);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { done = true; resolve(input.value); close(); } });
  });
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied", "ok", 1200);
  } catch {
    toast("Clipboard unavailable", "error");
  }
}

export function download(filename: string, data: string | Blob, mime = "text/plain"): void {
  const blob = typeof data === "string" ? new Blob([data], { type: mime + ";charset=utf-8" }) : data;
  const a = h("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------- filter ----
export interface FilterBar {
  el: HTMLElement;
  get(): MatchSpec;
  set(s: Partial<MatchSpec>): void;
  input: HTMLInputElement;
}

export function filterBar(onChange: () => void, placeholder = "filter…", initialMode: MatchMode = "contains"): FilterBar {
  const mode = h("select", { title: "match mode" }, ...MATCH_MODES.map((m) => h("option", { value: m.id }, m.label)));
  mode.value = initialMode;
  const text = h("input", { type: "search", placeholder, spellcheck: false, class: "grow" });
  const cs = h("input", { type: "checkbox", id: "cs" + Math.random().toString(36).slice(2) });
  const inv = h("input", { type: "checkbox", id: "iv" + Math.random().toString(36).slice(2) });
  const fire = debounce(onChange, 250);
  text.addEventListener("input", fire);
  text.addEventListener("keydown", (e) => { if (e.key === "Enter") onChange(); });
  mode.addEventListener("change", onChange);
  cs.addEventListener("change", onChange);
  inv.addEventListener("change", onChange);
  const el = h("div", { class: "row filter" }, mode, text, h("label", { class: "chk", title: "case sensitive" }, cs, "Aa"), h("label", { class: "chk", title: "invert (does NOT match)" }, inv, "not"));
  return {
    el, input: text,
    get: () => ({ mode: mode.value as MatchMode, text: text.value, caseSensitive: cs.checked, invert: inv.checked }),
    set: (s) => {
      if (s.mode) mode.value = s.mode;
      if (s.text !== undefined) text.value = s.text;
      if (s.caseSensitive !== undefined) cs.checked = s.caseSensitive;
      if (s.invert !== undefined) inv.checked = s.invert;
    },
  };
}

// ---------------------------------------------------------------- pager -----
export interface Pager {
  el: HTMLElement;
  offset: number;
  size: number;
  setTotal(n: number): void;
  reset(): void;
}

export function pager(onChange: (offset: number, size: number) => void, sizes = [50, 100, 250, 500, 1000, 5000], def = 100): Pager {
  const state = { offset: 0, size: def, total: 0 };
  const sel = h("select", { title: "rows per page" }, ...sizes.map((s) => h("option", { value: s, selected: s === def }, s + " / page")));
  const info = h("span", { class: "muted pager-info" });
  const pageIn = h("input", { type: "number", min: 1, value: 1, style: { width: "64px" }, title: "page" });
  const btn = (label: string, title: string, fn: () => void) => h("button", { class: "icon", title, onclick: fn }, label);
  const pages = () => Math.max(1, Math.ceil(state.total / state.size));
  const go = (off: number) => {
    const max = Math.max(0, (pages() - 1) * state.size);
    state.offset = Math.max(0, Math.min(max, off));
    render();
    onChange(state.offset, state.size);
  };
  const render = () => {
    pageIn.value = String(Math.floor(state.offset / state.size) + 1);
    const to = Math.min(state.total, state.offset + state.size);
    info.textContent = state.total ? `${(state.offset + 1).toLocaleString()}–${to.toLocaleString()} of ${state.total.toLocaleString()} · page / ${pages().toLocaleString()}` : "no rows";
  };
  sel.addEventListener("change", () => { state.size = Number(sel.value); go(0); });
  pageIn.addEventListener("change", () => go((Math.max(1, Number(pageIn.value) || 1) - 1) * state.size));
  const el = h("div", { class: "row pager" },
    btn("⏮", "first", () => go(0)), btn("◀", "previous", () => go(state.offset - state.size)),
    pageIn, btn("▶", "next", () => go(state.offset + state.size)), btn("⏭", "last", () => go(1e12)), sel, info);
  render();
  return {
    el,
    get offset() { return state.offset; },
    get size() { return state.size; },
    setTotal(n: number) { state.total = n; if (state.offset >= n) state.offset = Math.max(0, Math.floor((n - 1) / state.size) * state.size); render(); },
    reset() { state.offset = 0; render(); },
  };
}

// ---------------------------------------------------------------- table -----
export interface Col<R> {
  title: string;
  render: (row: R, i: number) => Node | string | number;
  cls?: string;
  width?: string;
}

export interface DataTable<R> {
  el: HTMLElement;
  setRows(rows: R[]): void;
  rows: R[];
}

export function dataTable<R>(cols: Col<R>[], opts: { empty?: string; onRow?: (row: R) => void; rowClass?: (row: R) => string } = {}): DataTable<R> {
  const thead = h("thead", null, h("tr", null, ...cols.map((c) => h("th", { class: c.cls ?? "", style: c.width ? { width: c.width } : undefined }, c.title))));
  const tbody = h("tbody");
  const empty = h("div", { class: "empty" }, opts.empty ?? "No rows");
  const wrap = h("div", { class: "table-wrap" }, h("table", { class: "data" }, thead, tbody), empty);
  const t: DataTable<R> = {
    el: wrap,
    rows: [],
    setRows(rows) {
      t.rows = rows;
      clear(tbody);
      const frag = document.createDocumentFragment();
      rows.forEach((r, i) => {
        const tr = h("tr", { class: opts.rowClass?.(r) ?? "" });
        for (const c of cols) tr.appendChild(h("td", { class: c.cls ?? "" }, c.render(r, i)));
        if (opts.onRow) tr.addEventListener("dblclick", () => opts.onRow!(r));
        frag.appendChild(tr);
      });
      tbody.appendChild(frag);
      empty.style.display = rows.length ? "none" : "";
    },
  };
  empty.style.display = "";
  return t;
}

export function link(text: string, fn: () => void, title?: string): HTMLElement {
  return h("a", { class: "link", href: "#", title, onclick: (e: Event) => { e.preventDefault(); fn(); } }, text);
}
export function iconBtn(label: string, title: string, fn: (e: MouseEvent) => void, cls = ""): HTMLButtonElement {
  return h("button", { class: "icon " + cls, title, onclick: fn }, label);
}

export function select<T extends string>(options: [T, string][], value: T, onChange?: (v: T) => void): HTMLSelectElement {
  const s = h("select", null, ...options.map(([v, l]) => h("option", { value: v }, l)));
  s.value = value;
  if (onChange) s.addEventListener("change", () => onChange(s.value as T));
  return s;
}

export function field(label: string, control: Node, hint?: string): HTMLElement {
  return h("label", { class: "field", title: hint }, h("span", null, label), control);
}

export function rowsToCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map((c) => { const s = String(c); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\r\n");
}
