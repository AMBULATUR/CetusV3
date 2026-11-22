import { h, hex, dataTable, toast, errMsg, link, iconBtn, select, field, parseNum, clear } from "../ui";
import { rpc } from "../api";
import { lineBpPanel } from "./linebp";
import { poller } from "../poll";
import { Ctx, View } from "../ctx";

interface Hit { id: number; kind: "read" | "write" | "func"; slot: number; addr: number; count: number; first: number; last: number; frames: { fn: number; off: number; origOff: number | null; name: string }[]; fn: number; off: number | null }

export function debuggerView(ctx: Ctx): View {
  let lastEvt = 0;
  let selected: Hit | null = null;
  let hits: Hit[] = [];
  let features: any = null;
  const status = h("div", { class: "banner", style: { display: "none" } });

  // --- watchpoints
  const wpTable = dataTable<any>([
    { title: "Slot", render: (r) => r.slot, width: "50px" },
    { title: "Address", render: (r) => link(hex(r.addr), () => ctx.openMemory(r.addr)) },
    { title: "Size", render: (r) => r.size, width: "50px" },
    { title: "Mode", render: (r) => [r.flags & 1 ? "read" : "", r.flags & 2 ? "write" : "", r.flags & 4 ? "freeze" : ""].filter(Boolean).join(" + ") },
    { title: "", width: "40px", render: (r) => iconBtn("✕", "remove", async () => { await rpc("watch.clear", { slot: r.slot }); void load(); }, "danger") },
  ], { empty: "No memory watchpoints" });
  const wAddr = h("input", { type: "text", class: "mono", placeholder: "address", style: { width: "110px" } });
  const wSize = select<string>([["1", "1 B"], ["2", "2 B"], ["4", "4 B"], ["8", "8 B"]], "4");
  const wR = h("input", { type: "checkbox" }); const wW = h("input", { type: "checkbox", checked: true });
  const addWatch = async () => {
    try { await rpc("watch.set", { addr: parseNum(wAddr.value), size: Number(wSize.value), flags: (wR.checked ? 1 : 0) | (wW.checked ? 2 : 0) }); void load(true); } catch (e) { toast(errMsg(e), "error"); }
  };

  // --- function breakpoints
  const fbTable = dataTable<any>([
    { title: "Function", render: (r) => link(`${r.name} (#${r.index})`, () => ctx.openCode(r.index)) },
    { title: "Hits", render: (r) => r.count.toLocaleString(), cls: "num", width: "70px" },
    { title: "", width: "40px", render: (r) => iconBtn("✕", "remove", async () => { await rpc("fbp.clear", { index: r.index }); void load(); }, "danger") },
  ], { empty: "No function breakpoints" });
  const fIn = h("input", { type: "text", class: "mono", placeholder: "function # or name", style: { width: "150px" } });
  const addFbp = async () => {
    try {
      let idx: number;
      const t = fIn.value.trim();
      if (/^\d+$/.test(t)) idx = Number(t);
      else { const r = await rpc("mod.funcs", { filter: { mode: "contains", text: t }, offset: 0, limit: 5 }); if (!r.rows.length) throw new Error("no such function"); idx = (r.rows.find((x: any) => x.name === t) ?? r.rows[0]).index; }
      await rpc("fbp.set", { index: idx }); void load();
    } catch (e) { toast(errMsg(e), "error"); }
  };

  // --- trace
  const traceState = h("span", { class: "muted" });
  const traceTable = dataTable<any>([
    { title: "Function", render: (r) => link(`${r.name} (#${r.index})`, () => ctx.openCode(r.index)) },
    { title: "Calls", render: (r) => r.calls.toLocaleString(), cls: "num", width: "90px" },
    { title: "", width: "70px", render: (r) => (baseline.has(r.index) ? h("span", { class: "muted" }, "baseline") : h("span", { class: "badge ok" }, "new")) },
    { title: "", width: "40px", render: (r) => iconBtn("●", "breakpoint", async () => { try { await rpc("fbp.set", { index: r.index }); void load(true); } catch (e) { toast(errMsg(e), "error"); } }) },
  ], { empty: "Start a trace, do something in the app, stop — executed functions are listed here" });
  let baseline = new Set<number>();
  const hideBase = h("input", { type: "checkbox", checked: true });
  let tracing = false;
  const traceBtn = h("button", { class: "primary" }, "● Start trace");
  traceBtn.onclick = async () => {
    try {
      if (!tracing) { await rpc("trace.start"); tracing = true; } else { await rpc("trace.stop"); tracing = false; }
      void load(true);
    } catch (e) { toast(errMsg(e), "error"); }
  };
  async function calledList() {
    const r = await rpc("mod.funcs", { calledOnly: true, sort: "calls", desc: true, offset: 0, limit: 5000 });
    return r.rows as any[];
  }
  const markBase = async () => { baseline = new Set((await calledList()).map((x) => x.index)); const d = ctx.data(); d.baseline = [...baseline]; await ctx.saveData(); toast(`Baseline = ${baseline.size} functions`, "ok"); void load(true); };

  // --- hits
  const hitTable = dataTable<Hit>([
    { title: "Kind", width: "60px", render: (r) => h("span", { class: "badge " + (r.kind === "write" ? "warn" : r.kind === "read" ? "ok" : "") }, r.kind) },
    { title: "Target", render: (r) => (r.kind === "func" ? link(r.frames[0]?.name ?? "?", () => ctx.openCode(r.fn)) : link(hex(r.addr), () => ctx.openMemory(r.addr))) },
    { title: "Executed by", render: (r) => { const f = r.kind === "func" ? r.frames[1] : r.frames[0]; return f ? link(`${f.name} +0x${(f.origOff ?? f.off).toString(16)}`, () => ctx.openCode(f.fn, f.origOff ?? undefined), "open in disassembler") : "(host / JS)"; } },
    { title: "Count", render: (r) => r.count.toLocaleString(), cls: "num", width: "80px" },
    { title: "Last", render: (r) => ago(r.last), cls: "muted", width: "70px" },
    { title: "", width: "40px", render: (r) => iconBtn("⋮", "show call stack", () => { selected = r; drawStack(); }) },
  ], { empty: "No hits yet. Set a watchpoint / breakpoint, then interact with the app." , onRow: (r) => { selected = r; drawStack(); } });
  const stackBox = h("div", { class: "panel scroll", style: { width: "340px", flex: "none" } }, h("div", { class: "muted" }, "Select a hit (double-click or ⋮) to see the call stack."));
  const ago = (t: number) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? s.toFixed(0) + "s ago" : (s / 60).toFixed(0) + "m ago"; };
  function drawStack() {
    clear(stackBox);
    if (!selected) { stackBox.appendChild(h("div", { class: "muted" }, "Select a hit (double-click a row or ⋮) to see the full call stack.")); return; }
    stackBox.appendChild(h("h3", null, `Call stack — ${selected.kind} ${selected.kind === "func" ? "" : hex(selected.addr)}`));
    selected.frames.forEach((f, i) => stackBox.appendChild(h("div", { class: "mono", style: { padding: "2px 0" } }, `${i}  `, link(f.name, () => ctx.openCode(f.fn, f.origOff ?? undefined)), h("span", { class: "muted" }, `  #${f.fn} +0x${(f.origOff ?? f.off).toString(16)}`))));
    if (!selected.frames.length) stackBox.appendChild(h("div", { class: "muted" }, "no wasm frames captured (rate limited)"));
  }

  /** one lightweight round trip; the (heavier) trace list is only fetched while tracing or on demand */
  async function load(forceTrace = false, background = false) {
    try {
      const r = await rpc("dbg.poll", { trace: tracing || forceTrace }, undefined, background);
      wpTable.setRows(r.watch); fbTable.setRows(r.fbp); hits = r.hits; hitTable.setRows(r.hits);
      tracing = r.trace.tracing; traceBtn.textContent = tracing ? "■ Stop trace" : "● Start trace";
      traceState.textContent = tracing ? `tracing… ${r.trace.called} distinct functions so far` : `${r.trace.called} distinct functions executed`;
      if (r.called) traceTable.setRows(r.called.filter((x: any) => !(hideBase.checked && baseline.has(x.index))));
      if (selected) { const same = r.hits.find((x: Hit) => x.id === selected!.id); if (same) { selected = same; } }
      const info = ctx.target()?.info;
      features = info?.features;
      const warn: string[] = [];
      if (info && !info.instrumented) warn.push("This module is NOT instrumented" + (info.error ? ` (${info.error})` : "") + " — watchpoints and breakpoints are unavailable. See Tools → diagnostics.");
      else if (features) {
        if (!features.read) warn.push("read watch is off in Settings");
        if (!features.write) warn.push("write watch / hard freeze is off in Settings");
        if (!features.funcHooks) warn.push("function hooks are off in Settings");
      }
      status.style.display = warn.length ? "" : "none";
      status.textContent = warn.join(" · ");
    } catch (e) { /* target may be gone */ }
  }
  const poll = poller("pollDebugger", () => load(false, true));

  const lineBp = lineBpPanel(ctx);
  const tabMem = h("button", { class: "active" }, "Watchpoints · functions · trace");
  const tabLine = h("button", null, "Line breakpoints");
  const mainWrap = h("div", { class: "fill", style: { gap: "8px" } },
    h("div", { class: "cols", style: { flex: "0 0 36%" } },
      h("div", { class: "panel fill" }, h("h3", null, "Memory watchpoints"), h("div", { class: "row" }, wAddr, wSize, h("label", { class: "chk" }, wR, "read"), h("label", { class: "chk" }, wW, "write"), h("button", { onclick: () => void addWatch() }, "Add")), wpTable.el),
      h("div", { class: "panel fill" }, h("h3", null, "Function breakpoints"), h("div", { class: "row" }, fIn, h("button", { onclick: () => void addFbp() }, "Add")), fbTable.el),
      h("div", { class: "panel fill", style: { flex: "1.4" } }, h("h3", null, "Call trace (what runs when I do X?)"), h("div", { class: "row" }, traceBtn, h("button", { onclick: async () => { await rpc("trace.clear"); void load(true); } }, "Clear counters"), h("button", { onclick: () => void markBase() }, "Set baseline"), h("label", { class: "chk" }, hideBase, "hide baseline"), traceState), traceTable.el)),
    h("div", { class: "row" }, h("b", null, "Hits"), h("span", { class: "muted" }, "who accessed it — grouped by calling code"), h("span", { class: "grow" }), h("button", { onclick: async () => { await rpc("hits.clear"); selected = null; drawStack(); void load(); } }, "Clear hits")),
    h("div", { class: "cols" }, hitTable.el, stackBox));
  const lineWrap = h("div", { class: "fill", style: { display: "none" } }, lineBp.el);
  const showTab = (t: "main" | "line") => {
    tabMem.classList.toggle("active", t === "main"); tabLine.classList.toggle("active", t === "line");
    mainWrap.style.display = t === "main" ? "" : "none"; lineWrap.style.display = t === "line" ? "" : "none";
    if (t === "line") lineBp.start(); else lineBp.stop();
  };
  tabMem.onclick = () => showTab("main"); tabLine.onclick = () => showTab("line");
  const el = h("div", { class: "view" }, status, h("div", { class: "tabs" }, tabMem, tabLine), mainWrap, lineWrap);
  void field;

  return {
    el,
    show(p) { baseline = new Set(ctx.data().baseline ?? []); void load(true); poll.start(); if (p?.tab === "line" || lineWrap.style.display !== "none") showTab("line"); },
    hide() { poll.stop(); lineBp.stop(); },
    onEvent(type) { if (type === "hits" && Date.now() - lastEvt > 800) { lastEvt = Date.now(); void poll.now(); } },
    retarget() { selected = null; hits = []; hitTable.setRows([]); wpTable.setRows([]); fbTable.setRows([]); traceTable.setRows([]); drawStack(); },
  };
}
