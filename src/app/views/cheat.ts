import { h, hex, dataTable, toast, errMsg, iconBtn, link, select, download, parseNum, modal, field, fmtBytes } from "../ui";
import { rpc, Bookmark } from "../api";
import { poller } from "../poll";
import { Ctx, View } from "../ctx";
import { VAL_TYPES, TYPE_INFO, ValType, dec, fmtVal } from "../../shared/codec";
import { parseAddressExpr, formatChain } from "../../shared/addrexpr";
import { rowIdentifier } from "../../page/script";

const ROW_TYPES: [string, string][] = [...VAL_TYPES.map((t) => [t, t] as [string, string]), ["str8", "text (utf-8)"], ["str16", "text (utf-16)"]];
const isText = (t: string) => t === "str8" || t === "str16";

type Chain = { base: number; offsets: number[] };
type PRow = Chain & { now: number | null; v: any };

export function fmtChain(c: Chain): string {
  let s = `[${hex(c.base, 4)}]`;
  for (let i = 0; i < c.offsets.length - 1; i++) s = `[${s}+0x${c.offsets[i]!.toString(16)}]`;
  return `${s}+0x${c.offsets[c.offsets.length - 1]!.toString(16)}`;
}
const chainKey = (c: Chain) => `${c.base}:${c.offsets.join(",")}`;

export function cheatView(ctx: Ctx): View {
  const res = new Map<string, { a: number; v: string | null }>();
  let editing = false;
  const sizeOf = (b: Bookmark) => (isText(b.type) ? Math.max(1, b.len ?? 1) : TYPE_INFO[b.type as ValType]?.size ?? 4);
  const eff = (b: Bookmark): number => (b.ptr ? res.get(b.id)?.a ?? -1 : b.addr);
  const wflags = (b: Bookmark) => (b.watchW ? 2 : 0) | (b.watchR ? 1 : 0);
  const fail = (undo: () => void, e: unknown) => { undo(); toast(errMsg(e), "error"); render(); };

  // ---- selection (click, shift = range, ctrl = toggle, drag) -------------------------
  const sel = new Set<string>();
  let anchor = -1;
  let dragging = false;
  const selInfo = h("span", { class: "muted" });
  const trs = () => Array.from(table.el.querySelectorAll("tbody tr")) as HTMLElement[];
  function applySel() {
    const rows = table.rows;
    trs().forEach((tr, i) => tr.classList.toggle("sel", !!rows[i] && sel.has(rows[i]!.id)));
    selInfo.textContent = sel.size ? `${sel.size} selected` : "";
  }
  const selected = () => ctx.data().bookmarks.filter((b) => sel.has(b.id));
  function selectRange(a: number, b: number, additive: boolean) {
    if (!additive) sel.clear();
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) if (table.rows[i]) sel.add(table.rows[i]!.id);
    applySel();
  }

  const table = dataTable<Bookmark>([
    { title: "Freeze", width: "104px", render: (b) => {
      const cb = h("input", { type: "checkbox", checked: b.freeze, disabled: isText(b.type), title: isText(b.type) ? "text rows cannot be frozen (use a script with a loop)" : "keep this value locked (applies to all selected rows if this row is selected)" });
      cb.addEventListener("change", () => {
        const group = sel.has(b.id) && sel.size > 1 ? selected() : [b];
        if (group.length > 1) void freezeMany(group, cb.checked, true); else setFreeze(b, cb.checked);
      });
      const mode = select<string>([["hard", "hard"], ["timer", "timer"]], b.freezeMode ?? "hard", (v) => { b.freezeMode = v as any; void ctx.saveData(); if (b.freeze) setFreeze(b, true, true); });
      mode.title = "hard = reverts instantly inside the store instruction (needs instrumentation; limited slots, falls back to timer when full)\ntimer = JS loop, unlimited";
      mode.style.width = "64px"; mode.style.padding = "0 2px";
      return h("span", { class: "row", style: { flexWrap: "nowrap", gap: "3px" } }, cb, mode);
    } },
    { title: "Description", render: (b) => { const i = h("input", { type: "text", value: b.desc, placeholder: "description (= name in scripts)", spellcheck: false, title: b.desc ? "script name: " + (rowIdentifier(b.desc) || "(none)") : "give the row a description to use it in scripts" }); i.addEventListener("change", () => { b.desc = i.value; i.title = b.desc ? "script name: " + (rowIdentifier(b.desc) || "(none)") : ""; void ctx.saveData(); }); return i; } },
    { title: "Address", width: "230px", render: (b) => {
      const a = eff(b);
      if (!b.ptr) { const l = link(hex(b.addr), () => ctx.openMemory(b.addr), "show in memory view (double-click to edit the address)"); l.addEventListener("dblclick", (e) => { e.preventDefault(); openAddModal(b); }); return l; }
      return h("span", { title: fmtChain(b.ptr) + "  (double-click to edit)", ondblclick: () => openAddModal(b) }, a >= 0 ? link(hex(a), () => ctx.openMemory(a), "show in memory view") : h("span", { class: "warn" }, "unresolved"), h("span", { class: "muted" }, "  ⛓ " + fmtChain(b.ptr)));
    } },
    { title: "Type", width: "150px", render: (b) => {
      const sel = select<string>(ROW_TYPES, b.type, (v) => { const wasText = isText(b.type); b.type = v; if (isText(v) && !b.len) b.len = 32; if (b.freeze && isText(v)) { b.freeze = false; void rpc("cheat.release", { addr: eff(b), size: sizeOf(b) }).catch(() => {}); } void ctx.saveData(); if (wasText !== isText(v)) render(); void poll.now(); });
      if (!isText(b.type)) return sel;
      const len = h("input", { type: "number", min: 2, value: b.len ?? 32, style: { width: "56px" }, title: "maximum size in bytes (with the terminator). Writing more is refused so neighbouring memory is not overwritten." });
      len.addEventListener("change", () => { b.len = Math.max(2, Number(len.value) | 0); void ctx.saveData(); });
      return h("span", { class: "row", style: { flexWrap: "nowrap", gap: "3px" } }, sel, len);
    } },
    { title: "Value", width: "190px", render: (b) => {
      const i = h("input", { type: "text", value: res.get(b.id)?.v ?? "", spellcheck: false });
      i.addEventListener("focus", () => (editing = true)); i.addEventListener("blur", () => (editing = false));
      i.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const addr = eff(b);
        if (addr < 0) return void toast("address is unresolved", "error");
        if (isText(b.type)) { rpc("writeStr", { addr, text: i.value, enc: b.type === "str16" ? "utf16" : "utf8", cap: b.len }).then(() => toast("written", "ok", 700)).catch((er) => toast(errMsg(er), "error")); return; }
        const p = b.freeze ? rpc("cheat.freeze", { addr, type: b.type, mode: b.freezeMode ?? "hard", value: i.value, watchFlags: wflags(b) }).then((r: any) => { b.freezeValue = r.value; }) : rpc("write", { addr, type: b.type, value: i.value });
        p.then(() => { toast("written", "ok", 700); void ctx.saveData(); }).catch((er) => toast(errMsg(er), "error"));
      });
      i.dataset.bid = b.id;
      return i;
    } },
    { title: "Watch", width: "92px", render: (b) => h("span", { class: "row", style: { gap: "2px", flexWrap: "nowrap" } },
      h("button", { class: "icon " + (b.watchW ? "on" : ""), title: "break on write — find what writes to this address", onclick: () => toggleWatch(b, "W") }, "W"),
      h("button", { class: "icon " + (b.watchR ? "on" : ""), title: "break on read — find what reads this address", onclick: () => toggleWatch(b, "R") }, "R")) },
    { title: "", width: "96px", render: (b) => h("span", { class: "row", style: { gap: "2px", flexWrap: "nowrap" } },
      iconBtn("⌖", "show in memory view", () => { const a = eff(b); if (a >= 0) ctx.openMemory(a); }),
      iconBtn("⛓", b.ptr ? "pointer path — saved candidates / rescan / unlink" : "find a pointer path (offset finder) so this address survives restarts", () => openPointerModal(b), b.ptr || b.ptrCandidates?.length ? "on" : ""),
      iconBtn("✕", "remove", () => remove(b), "danger")) },
  ], { empty: "Cheat table is empty — add addresses from Scanner, Strings or Memory view (＋)" });
  table.el.tabIndex = 0;
  table.el.style.outline = "none";

  table.el.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement;
    const tr = t.closest("tbody tr") as HTMLElement | null;
    if (!tr || t.closest("input,select,button,a,textarea")) return;
    const idx = trs().indexOf(tr);
    if (idx < 0) return;
    e.preventDefault();
    table.el.focus();
    if (e.shiftKey && anchor >= 0) selectRange(anchor, idx, e.ctrlKey || e.metaKey);
    else if (e.ctrlKey || e.metaKey) { const id = table.rows[idx]!.id; if (sel.has(id)) sel.delete(id); else sel.add(id); anchor = idx; applySel(); }
    else { sel.clear(); anchor = idx; selectRange(idx, idx, false); }
    dragging = true;
  });
  table.el.addEventListener("mouseover", (e) => {
    if (!dragging || !(e.buttons & 1)) return;
    const tr = (e.target as HTMLElement).closest("tbody tr") as HTMLElement | null;
    if (tr && anchor >= 0) selectRange(anchor, trs().indexOf(tr), false);
  });
  window.addEventListener("mouseup", () => { dragging = false; });
  table.el.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest("input,select,textarea")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); selectRange(0, table.rows.length - 1, false); }
    else if (e.key === " ") { e.preventDefault(); const l = selected(); if (l.length) void freezeMany(l, !l.every((b) => b.freeze), true); }
    else if (e.key === "Delete") { e.preventDefault(); removeMany(selected()); }
    else if (e.key === "Escape") { sel.clear(); applySel(); }
  });

  // ---- actions: optimistic UI + a single round trip each ------------------------------
  function setFreeze(b: Bookmark, on: boolean, refreeze = false) {
    const addr = eff(b);
    const prev = { f: b.freeze, v: b.freezeValue };
    if (on && addr < 0) { b.freeze = false; toast("address is unresolved", "error"); render(); return; }
    b.freeze = on;
    if (!on) delete b.freezeValue;
    void ctx.saveData();
    const p = on
      ? (refreeze ? rpc("cheat.release", { addr, size: sizeOf(b) }).catch(() => {}) : Promise.resolve()).then(() => rpc("cheat.freeze", { addr, type: b.type, mode: b.freezeMode ?? "hard", ...(b.freezeValue !== undefined && refreeze ? { value: b.freezeValue } : {}), watchFlags: wflags(b) }))
          .then((r: any) => { b.freezeValue = r.value; if (r.mode !== (b.freezeMode ?? "hard")) toast("hard slots unavailable/full — using the timer mode", "info"); void ctx.saveData(); })
      : rpc("cheat.release", { addr, size: sizeOf(b), keepFlags: wflags(b) });
    p.catch((e) => fail(() => { b.freeze = prev.f; if (prev.v === undefined) delete b.freezeValue; else b.freezeValue = prev.v; }, e));
  }

  async function freezeMany(list: Bookmark[], on: boolean, includeFrozen = false) {
    const todo = on ? list.filter((b) => (includeFrozen || !b.freeze) && eff(b) >= 0) : list.filter((b) => b.freeze || includeFrozen);
    if (!todo.length) { render(); return; }
    const prev = todo.map((b) => ({ b, f: b.freeze, v: b.freezeValue }));
    todo.forEach((b) => { b.freeze = on; if (!on) delete b.freezeValue; });
    render();
    try {
      if (on) {
        const out: any[] = await rpc("cheat.freezeMany", { items: todo.map((b) => ({ addr: eff(b), type: b.type, mode: b.freezeMode ?? "hard", watchFlags: wflags(b) })) });
        let bad = 0, timer = 0, first = "";
        out.forEach((x, i) => {
          const b = todo[i]!;
          if (x.error) { bad++; first ||= x.error; b.freeze = false; delete b.freezeValue; }
          else { b.freezeValue = x.value; if (x.mode === "timer" && (b.freezeMode ?? "hard") === "hard") timer++; }
        });
        toast(`${todo.length - bad} frozen` + (timer ? ` (${timer} via timer: hard slots full)` : "") + (bad ? `, ${bad} failed: ${first}` : ""), bad ? "error" : "ok", 3500);
      } else {
        await rpc("cheat.releaseMany", { items: todo.map((b) => ({ addr: eff(b), size: sizeOf(b), keepFlags: wflags(b) })) });
      }
    } catch (e) {
      prev.forEach((p) => { p.b.freeze = p.f; if (p.v === undefined) delete p.b.freezeValue; else p.b.freezeValue = p.v; });
      toast(errMsg(e), "error");
    }
    void ctx.saveData(); render();
  }

  function toggleWatch(b: Bookmark, w: "R" | "W") {
    if (w === "W") b.watchW = !b.watchW; else b.watchR = !b.watchR;
    render();
    const addr = eff(b);
    const flags = wflags(b) | (b.freeze && (b.freezeMode ?? "hard") === "hard" ? 4 : 0);
    rpc("watch.set", { addr, size: sizeOf(b), flags })
      .then(() => { if (wflags(b)) toast("Watching — hits appear in Debugger", "ok", 1500); void ctx.saveData(); })
      .catch((e) => fail(() => { if (w === "W") b.watchW = !b.watchW; else b.watchR = !b.watchR; }, e));
  }
  function removeMany(list: Bookmark[]) {
    if (!list.length) return;
    const rel = list.filter((b) => eff(b) >= 0 && (b.freeze || b.watchR || b.watchW)).map((b) => ({ addr: eff(b), size: sizeOf(b) }));
    const ids = new Set(list.map((b) => b.id));
    const d = ctx.data();
    d.bookmarks = d.bookmarks.filter((x) => !ids.has(x.id));
    ids.forEach((id) => { res.delete(id); sel.delete(id); });
    render();
    void ctx.saveData();
    if (rel.length) rpc("cheat.releaseMany", { items: rel }).catch(() => {});
  }
  const remove = (b: Bookmark) => removeMany([b]);

  // ---- live values ----------------------------------------------------------------------
  const poll = poller("pollCheat", async () => {
    const bms = ctx.data().bookmarks;
    if (!bms.length || editing) return;
    const out: { a: number; v: any }[] = await rpc("cheat.poll", { items: bms.map((b) => ({ ...(b.ptr ? { ptr: b.ptr } : { addr: b.addr }), type: b.type, ...(b.len ? { len: b.len } : {}) })) }, undefined, true);
    bms.forEach((b, i) => {
      const o = out[i];
      if (!o) return;
      const old = res.get(b.id);
      const s = o.v === null ? "??" : isText(b.type) ? String(o.v) : fmtVal(b.type as ValType, dec(b.type as ValType, o.v));
      res.set(b.id, { a: o.a, v: s });
      const inp = table.el.querySelector(`input[data-bid="${b.id}"]`) as HTMLInputElement | null;
      if (inp && document.activeElement !== inp) inp.value = s;
      if (b.ptr && old && old.a !== o.a) {
        if (b.freeze && o.a >= 0) { void rpc("cheat.release", { addr: old.a, size: sizeOf(b) }).catch(() => {}).then(() => rpc("cheat.freeze", { addr: o.a, type: b.type, mode: b.freezeMode ?? "hard", ...(b.freezeValue !== undefined ? { value: b.freezeValue } : {}), watchFlags: wflags(b) })).catch(() => {}); }
        render();
      } else if (b.ptr && !old) render();
    });
  });
  function render() { table.setRows(ctx.data().bookmarks); applySel(); void poll.now(); }

  // ---- pointer-path finder ("offset finder") ------------------------------------------------
  function openPointerModal(b: Bookmark) {
    const target = eff(b);
    const type = b.type;
    const fmt = (v: any) => (v === null || v === undefined ? "—" : fmtVal(type as ValType, dec(type as ValType, v)));
    const sp = b.ptrParams;
    const body = h("div", { class: "stack", style: { minWidth: "820px", gap: "8px" } });
    const hexIn = (v: number, w = "90px") => h("input", { type: "text", class: "mono", value: "0x" + v.toString(16), style: { width: w } });
    const maxOff = hexIn(sp?.maxOff ?? 0x400);
    const levels = select<string>([["1", "1 (direct)"], ["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"]], String(sp?.levels ?? 3));
    const lo = hexIn(sp?.staticLo ?? 0x100, "100px");
    const hi = hexIn(sp?.staticHi ?? 0x400000, "100px");
    const breadth = select<string>([["20000", "breadth 20k"], ["100000", "breadth 100k"], ["400000", "breadth 400k"]], String(sp?.maxFrontier ?? 20000));
    breadth.title = "how many intermediate pointers to keep per level (higher = finds more, slower, more memory)";
    const cap = select<string>([["5000", "keep 5k paths"], ["20000", "keep 20k paths"], ["50000", "keep 50k paths"]], String(sp?.maxResults ?? 5000));
    const status = h("span", { class: "muted" });
    let range: any = null;
    const rangeInfo = h("div", { class: "muted" });
    const preset = select<string>([["", "range presets…"], ["det", "detected static end"], ["p4", "detected + 4 MiB"], ["p64", "detected + 64 MiB"], ["all", "whole memory (slow, noisy)"]], "", (v) => {
      if (!range || !v) return;
      const end = range.end || 0x400000;
      const hiV = v === "det" ? range.hi : v === "p4" ? end + 4 * 1048576 : v === "p64" ? end + 64 * 1048576 : range.memLen;
      hi.value = hex(Math.min(hiV, range.memLen), 4);
      preset.value = "";
    });
    const bar = h("progress", { max: 1, value: 0, style: { width: "140px" } });
    const scanBtn = h("button", { class: "primary" }, "Scan this address");
    const cancelBtn = h("button", { style: { display: "none" } }, "Stop");
    const realAddr = h("input", { type: "text", class: "mono", value: target >= 0 ? hex(target) : "", style: { width: "110px" }, title: "where the value really is in THIS run" });
    const tabSaved = h("button", null, "Saved candidates");
    const tabScan = h("button", null, "Last scan results");
    const note = h("div");
    let mode: "saved" | "scan" = b.ptrCandidates?.length ? "saved" : "scan";
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tableRows: PRow[] = [];
    const real = () => { try { return parseNum(realAddr.value); } catch { return -1; } };

    const resTable = dataTable<PRow>([
      { title: "Path", render: (r) => h("span", { class: "mono" }, fmtChain(r)) },
      { title: "Depth", render: (r) => r.offsets.length, cls: "num", width: "54px" },
      { title: "Resolves to (now)", render: (r) => (r.now === null ? h("span", { class: "muted" }, "—") : r.now === real() ? h("span", { class: "ok" }, "✓ " + hex(r.now)) : hex(r.now)), width: "150px" },
      { title: "Value there", render: (r) => h("span", { class: "mono" }, fmt(r.v)), width: "120px" },
      { title: "", width: "56px", render: (r) => h("button", { onclick: () => use(r) }, "Use") },
    ], { empty: "Nothing here yet — press “Scan this address”" });
    resTable.el.style.maxHeight = "320px";

    const showTab = (m: "saved" | "scan") => { mode = m; tabSaved.classList.toggle("active", m === "saved"); tabScan.classList.toggle("active", m === "scan"); void refreshTable(); };
    tabSaved.onclick = () => showTab("saved"); tabScan.onclick = () => showTab("scan");
    async function refreshTable() {
      try {
        let rows: PRow[] = [];
        if (mode === "saved") {
          const list = b.ptrCandidates ?? [];
          const ev: { now: number | null; v: any }[] = list.length ? await rpc("ptr.eval", { chains: list, type }) : [];
          rows = list.map((c, i) => ({ ...c, now: ev[i]!.now, v: ev[i]!.v }));
          const r0 = real();
          const score = (r: PRow) => (r.now === r0 ? 0 : r.now !== null ? 1 : 2);
          rows.sort((x, y) => score(x) - score(y));
          const ok = rows.filter((r) => r.now === r0).length, valid = rows.filter((r) => r.now !== null).length;
          status.textContent = list.length ? `${list.length} saved · ${ok} lead to ${hex(Math.max(0, r0))} now · ${valid} resolve to something valid` : "no saved candidates yet — scan, then “Keep results”";
          tabSaved.textContent = `Saved candidates (${list.length})`;
        } else {
          const r = await rpc("ptr.results", { offset: 0, limit: 400, type });
          rows = r.rows;
        }
        tableRows = rows;
        resTable.setRows(rows.slice(0, 400));
      } catch (e) { status.textContent = errMsg(e); }
    }

    const use = (r: Chain) => {
      b.ptr = { base: r.base, offsets: [...r.offsets] };
      void ctx.saveData(); render(); toast("Saved pointer path: " + fmtChain(r), "ok", 4000); close();
    };
    const keep = async () => {
      const r = await rpc("ptr.results", { offset: 0, limit: 5000 });
      if (!r.rows.length) return toast("no scan results to keep", "info");
      b.ptrCandidates = r.rows.map((x: any) => ({ base: x.base, offsets: x.offsets }));
      void ctx.saveData(); toast(`Kept ${b.ptrCandidates!.length} candidate paths on this entry`, "ok"); showTab("saved");
    };
    const params = () => ({ maxOff: parseNum(maxOff.value), levels: Number(levels.value), staticLo: parseNum(lo.value), staticHi: parseNum(hi.value), maxFrontier: Number(breadth.value), maxResults: Number(cap.value) });

    async function runScan(addr: number): Promise<{ capped: boolean; error: string | null }> {
      const p = params();
      b.ptrParams = p; void ctx.saveData();
      scanBtn.disabled = true; cancelBtn.style.display = "";
      await rpc("ptr.start", { target: addr, ...p });
      let s: any;
      for (;;) {
        s = await rpc("ptr.status");
        bar.value = s.progress;
        status.textContent = s.error ? `error: ${s.error}` : `level ${s.level} · ${s.results.toLocaleString()} path(s)${s.capped ? " · capped" : ""}${s.running ? "" : " · done"}`;
        if (!s.running || closed) break;
        if (mode === "scan") await refreshTable();
        await new Promise((r) => setTimeout(r, 400));
      }
      scanBtn.disabled = false; cancelBtn.style.display = "none";
      return { capped: s.capped, error: s.error };
    }
    scanBtn.onclick = async () => {
      if (target < 0) return toast("address is unresolved", "error");
      try {
        note.replaceChildren();
        showTab("scan");
        await runScan(target);
        await refreshTable();
        const n = (await rpc("ptr.status")).results;
        if (n === 0) note.replaceChildren(h("div", { class: "banner" }, "No static path found. Try “detected + 4 MiB” for the range, a larger max offset (e.g. 0x1000), more levels, or a higher breadth."));
      } catch (e) { toast(errMsg(e), "error"); scanBtn.disabled = false; cancelBtn.style.display = "none"; }
    };
    cancelBtn.onclick = () => void rpc("ptr.cancel");

    // --- after a restart: compare a fresh scan of this run with the saved candidates ---
    const compareBtn = h("button", { title: "scan THIS run for the address above and compare with the saved candidates" }, "Rescan this run & compare");
    compareBtn.onclick = async () => {
      const addr = real();
      if (addr < 0) return toast("type the address of the value in this run first", "error");
      const saved = b.ptrCandidates ?? [];
      if (!saved.length) return toast("no saved candidates to compare with", "info");
      try {
        note.replaceChildren();
        showTab("scan");
        const out = await runScan(addr);
        const all: Chain[] = [];
        for (let off = 0; ; off += 5000) { const r = await rpc("ptr.results", { offset: off, limit: 5000 }); all.push(...r.rows); if (all.length >= r.total || !r.rows.length) break; }
        const keys = new Set(saved.map(chainKey));
        const common = all.filter((c) => keys.has(chainKey(c)));
        const savedBases = new Set(saved.map((c) => c.base));
        const sameBase = all.filter((c) => savedBases.has(c.base) && !keys.has(chainKey(c)));
        if (common.length) {
          note.replaceChildren(h("div", { class: "banner info" }, `${common.length} path(s) are identical in both runs — those are stable. `, h("button", { class: "primary", onclick: () => { b.ptrCandidates = common; b.ptr = common[0]!; void ctx.saveData(); render(); toast(`Using the best of ${common.length} stable paths`, "ok"); close(); } }, "Keep these & use the shortest")));
        } else if (sameBase.length) {
          note.replaceChildren(h("div", { class: "banner" }, `No identical path, but ${new Set(sameBase.map((c) => c.base)).size} static cell(s) lead to your value in BOTH runs with different offsets (for example ${fmtChain(sameBase[0]!)}). The root is right but the object layout differs between runs — pick the matching value again (same kind of object) or raise Max offset / levels.`));
        } else {
          note.replaceChildren(h("div", { class: "banner err" }, `No overlap at all between the ${saved.length} saved paths and the ${all.length} found now${out.capped ? " (the scan was capped — raise breadth)" : ""}. The first scan's paths were rooted in memory that is not static, or this run's value is a different object. Use “detected static end” (or +4 MiB) for the range, scan again in each run and compare.`));
        }
        await refreshTable();
      } catch (e) { toast(errMsg(e), "error"); }
    };

    (async () => {
      try {
        const r = await rpc("ptr.staticRange");
        range = r;
        if (!sp) { lo.value = hex(r.lo, 4); hi.value = hex(r.hi, 4); }
        rangeInfo.textContent = `Static range ${r.detected ? "detected from" : ""} ${r.source}. Memory is ${fmtBytes(r.memLen)}.` + (sp ? ` Using the settings of the last scan (${hex(sp.staticLo, 4)}–${hex(sp.staticHi, 4)}); the detected end is ${hex(r.hi, 4)}.` : "");
        rangeInfo.className = r.detected ? "muted" : "warn";
      } catch { /* ignore */ }
      showTab(mode);
    })();
    realAddr.addEventListener("input", () => resTable.setRows(tableRows.slice(0, 400)));

    body.append(
      h("div", { class: "muted" }, "Heap addresses change every run. This finds chains that start in static memory and lead to the target, so the entry can be re-resolved after a restart. Candidates and their settings are saved on the entry."),
      h("div", { class: "row" }, field("Target now", h("span", { class: "mono" }, target >= 0 ? hex(target) : "unresolved")), field("Max offset", maxOff), field("Levels", levels), field("Static range from", lo), field("to", hi), preset),
      h("div", { class: "row" }, breadth, cap, scanBtn, cancelBtn, bar),
      rangeInfo,
      h("div", { class: "row", style: { borderTop: "1px solid var(--line)", paddingTop: "8px" } }, h("b", null, "After a restart:"), field("Real address of the value now", realAddr), compareBtn, h("span", { class: "muted" }, "(find the value with the Scanner first)")),
      note,
      h("div", { class: "tabs" }, tabSaved, tabScan, h("span", { class: "grow" }), status),
      resTable.el);
    const close = modal(`Pointer path for ${b.desc || hex(b.addr)}`, body, [
      ...(b.ptr ? [{ label: "Unlink (use fixed address)", onClick: () => { const a = eff(b); if (a >= 0) b.addr = a; delete b.ptr; void ctx.saveData(); render(); } }] : []),
      { label: "Keep scan results as candidates (up to 5000)", onClick: () => { void keep(); return false; } },
      { label: "Close", primary: true, onClick: () => { closed = true; clearTimeout(timer); void rpc("ptr.cancel").catch(() => {}); } },
    ]);
  }

  /** Add a row or edit an existing one: accepts 0x1234, 0x1000+0x20 and pointer paths like [[[[0x4a2220]+0x34]+0x24]+0xd8]+0x18 */
  function openAddModal(existing?: Bookmark) {
    const a = h("input", { type: "text", class: "mono", placeholder: "0x… or [[0x4a2220]+0x34]+0x18", style: { width: "100%" }, value: existing ? (existing.ptr ? formatChain(existing.ptr) : hex(existing.addr)) : "" });
    const t = select<string>(ROW_TYPES, existing?.type ?? "i32");
    const d = h("input", { type: "text", placeholder: "description (becomes the name in scripts)", value: existing?.desc ?? "" });
    const len = h("input", { type: "number", min: 2, placeholder: "auto", style: { width: "90px" }, value: existing?.len ?? "", title: "text rows: max bytes incl. terminator (empty = current length + 1)" });
    const preview = h("div", { class: "muted", style: { minHeight: "1.4em" } });
    let parsed: ReturnType<typeof parseAddressExpr> | null = null;
    const upd = async () => {
      try {
        parsed = parseAddressExpr(a.value);
        if (parsed.kind === "addr") preview.textContent = `fixed address ${hex(parsed.addr)}`;
        else {
          preview.textContent = `pointer path with ${parsed.chain.offsets.length} read(s) — resolving…`;
          const r = await rpc<any[]>("cheat.poll", { items: [{ ptr: parsed.chain, type: isText(t.value) ? "str8" : t.value }] });
          preview.textContent = r[0]!.a >= 0 ? `pointer path → ${hex(r[0]!.a)} now` + (r[0]!.v !== null ? ` · value ${isText(t.value) ? JSON.stringify(r[0]!.v) : r[0]!.v}` : "") : "pointer path (does not resolve right now — fine if the game is not in that state)";
        }
        preview.className = "muted";
      } catch (e) { parsed = null; preview.textContent = errMsg(e); preview.className = "err"; }
    };
    a.addEventListener("input", () => { void upd(); }); t.addEventListener("change", () => { void upd(); });
    void upd();
    modal(existing ? "Edit address" : "Add address", h("div", { class: "stack", style: { minWidth: "520px" } },
      field("Address or pointer path", a), preview, h("div", { class: "row" }, field("Type", t), field("Text length (bytes)", len)), field("Description", d)), [
      { label: "Cancel", onClick: () => {} },
      { label: existing ? "Save" : "Add", primary: true, onClick: async () => {
        await upd();
        if (!parsed) { toast("fix the address first", "error"); return false; }
        const target = existing ?? ({ id: Math.random().toString(36).slice(2), addr: 0, type: "i32", desc: "", freeze: false, freezeMode: "hard" } as Bookmark);
        if (existing && existing.freeze) { void rpc("cheat.release", { addr: eff(existing), size: sizeOf(existing) }).catch(() => {}); existing.freeze = false; delete existing.freezeValue; }
        target.type = t.value; target.desc = d.value.trim();
        if (parsed.kind === "addr") { target.addr = parsed.addr; delete target.ptr; } else { target.ptr = { base: parsed.chain.base, offsets: parsed.chain.offsets }; delete target.ptrCandidates; res.delete(target.id); }
        if (isText(t.value)) {
          let cap = Number(len.value) | 0;
          if (!cap) { try { const r: any[] = await rpc("cheat.poll", { items: [{ ...(parsed.kind === "ptr" ? { ptr: parsed.chain } : { addr: parsed.addr }), type: t.value, len: 4096 }] }); cap = Math.max(2, String(r[0]?.v ?? "").length * (t.value === "str16" ? 2 : 1) + (t.value === "str16" ? 2 : 1)); } catch { cap = 32; } }
          target.len = cap;
        } else delete target.len;
        if (!existing) ctx.data().bookmarks.push(target);
        await ctx.saveData(); render();
        toast(existing ? "Address updated" : `Added ${parsed.kind === "ptr" ? "pointer path" : hex(parsed.addr)}`, "ok", 1600);
      } },
    ]);
  }
  const addManual = () => openAddModal();
  const save = () => download("cheat-table.json", JSON.stringify({ cetus: 2, bookmarks: ctx.data().bookmarks.map((b) => ({ ...b, freeze: false })) }, null, 1), "application/json");
  const load = () => {
    const f = h("input", { type: "file", accept: ".json" });
    f.onchange = async () => {
      try {
        const j = JSON.parse(await f.files![0]!.text());
        const list = (j.bookmarks ?? []) as Bookmark[];
        const d = ctx.data();
        for (const b of list) d.bookmarks.push({ ...b, id: Math.random().toString(36).slice(2), freeze: false });
        await ctx.saveData(); render(); toast(`Loaded ${list.length} entries`, "ok");
      } catch (e) { toast(errMsg(e), "error"); }
    };
    f.click();
  };
  const selectAll = () => selectRange(0, table.rows.length - 1, false);

  const el = h("div", { class: "view" },
    h("div", { class: "row" }, h("button", { onclick: addManual }, "＋ Add address"), h("button", { onclick: save }, "Save table"), h("button", { onclick: load }, "Load table"),
      h("button", { class: "icon", title: "refresh values now", onclick: () => void poll.now() }, "↻"),
      h("span", { style: { width: "10px" } }),
      h("button", { onclick: selectAll, title: "Ctrl+A" }, "Select all"),
      h("button", { class: "primary", onclick: () => { const l = selected(); if (!l.length) return toast("select rows first (click, Shift+click, Ctrl+click or drag)", "info"); void freezeMany(l, true); }, title: "freeze every selected row (Space toggles)" }, "❄ Freeze selected"),
      h("button", { onclick: () => { const l = selected(); if (!l.length) return toast("select rows first", "info"); void freezeMany(l, false); } }, "Unfreeze selected"),
      h("button", { class: "danger", onclick: () => { const l = selected(); if (!l.length) return toast("select rows first", "info"); removeMany(l); }, title: "Delete" }, "Remove selected"), selInfo,
      h("button", { class: "danger", style: { marginLeft: "auto" }, onclick: () => removeMany([...ctx.data().bookmarks]) }, "Clear all")),
    h("div", { class: "muted" }, "Select rows: click · Shift+click range · Ctrl+click toggle · drag · Ctrl+A.  Space = freeze/unfreeze selection · Delete = remove. Ticking Freeze on a selected row applies to the whole selection."),
    table.el);

  return {
    el,
    show() { render(); poll.start(); },
    hide() { poll.stop(); },
    retarget() { res.clear(); sel.clear(); render(); },
  };
}
