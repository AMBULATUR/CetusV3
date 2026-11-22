import { h, hex, pager, dataTable, toast, errMsg, link, iconBtn, select, filterBar, promptText, parseNum, field, copyText } from "../ui";
import { rpc } from "../api";
import { Ctx, View } from "../ctx";

interface FRow { index: number; name: string; kind: string; size: number; exports: string[]; sig: string; calls: number; callers?: number; callees?: number }

export function functionsView(ctx: Ctx): View {
  let forced: number[] | null = null;
  const banner = h("div", { class: "banner info", style: { display: "none" } });
  const f = filterBar(() => { pg.reset(); void load(); }, "function name, export, index…", "contains");
  const kind = select<string>([["all", "all functions"], ["defined", "defined in module"], ["import", "imports"], ["export", "exported"]], "all", () => { pg.reset(); void load(); });
  const sort = select<string>([["index", "sort: index"], ["size", "sort: size"], ["name", "sort: name"], ["calls", "sort: trace calls"], ["callers", "sort: #callers"], ["callees", "sort: #callees"]], "index", () => { pg.reset(); void load(); });
  const desc = h("input", { type: "checkbox" });
  const calledOnly = h("input", { type: "checkbox" });
  const minSize = h("input", { type: "number", min: 0, placeholder: "min bytes", style: { width: "90px" } });
  for (const x of [desc, calledOnly, minSize]) x.addEventListener("change", () => { pg.reset(); void load(); });
  const pg = pager(() => void load(), [50, 100, 250, 500, 1000, 5000], 100);
  const bps = new Set<number>();

  const table = dataTable<FRow>([
    { title: "#", render: (r) => link(String(r.index), () => ctx.openCode(r.index), "disassemble"), cls: "num", width: "64px" },
    { title: "Name", render: (r) => h("span", null, link(r.name, () => ctx.openCode(r.index)), r.exports.length ? h("span", { class: "muted" }, `  ⇢ ${r.exports.join(", ")}`) : "") },
    { title: "Signature", render: (r) => r.sig, cls: "muted" },
    { title: "Size", render: (r) => (r.kind === "import" ? "import" : r.size), cls: "num", width: "70px" },
    { title: "Callers", render: (r) => (r.callers ?? ""), cls: "num", width: "64px" },
    { title: "Trace", render: (r) => (r.calls ? r.calls.toLocaleString() : ""), cls: "num", width: "80px" },
    { title: "", width: "150px", render: (r) => h("span", { class: "row", style: { gap: "2px", flexWrap: "nowrap" } },
      iconBtn("≣", "disassemble / edit", () => ctx.openCode(r.index)),
      iconBtn("●", "breakpoint on entry — logs who calls it", () => void toggleBp(r), bps.has(r.index) ? "on" : ""),
      iconBtn("✎", "rename", () => void rename(r)),
      iconBtn("⛓", "callers / callees", () => ctx.openCode(r.index, undefined))) },
  ], { empty: "No functions match" });

  async function toggleBp(r: FRow) {
    try {
      if (bps.has(r.index)) { await rpc("fbp.clear", { index: r.index }); bps.delete(r.index); }
      else { await rpc("fbp.set", { index: r.index }); bps.add(r.index); toast(`Breakpoint on ${r.name} — hits show in Debugger`, "ok"); }
      void load();
    } catch (e) { toast(errMsg(e), "error"); }
  }
  async function rename(r: FRow) {
    const n = await promptText("Rename function", `Name for function #${r.index} (empty = reset)`, r.name);
    if (n === null) return;
    await rpc("mod.rename", { index: r.index, name: n });
    const d = ctx.data();
    if (n) d.names[r.index] = n; else delete d.names[r.index];
    await ctx.saveData();
    void load();
  }

  async function load() {
    try {
      if (forced) {
        // synthesise a result from an explicit index list (xrefs)
        const rows: FRow[] = [];
        for (const i of forced.slice(pg.offset, pg.offset + pg.size)) {
          const r = await rpc("mod.funcs", { filter: { mode: "exact", text: String(i) }, offset: 0, limit: 5 });
          const hit = r.rows.find((x: FRow) => x.index === i);
          if (hit) rows.push(hit);
        }
        pg.setTotal(forced.length); table.setRows(rows); return;
      }
      const r = await rpc("mod.funcs", {
        filter: f.get(), kind: kind.value, sort: sort.value, desc: desc.checked, offset: pg.offset, limit: pg.size,
        calledOnly: calledOnly.checked, minSize: Number(minSize.value) || 0,
      });
      pg.setTotal(r.total); table.setRows(r.rows);
    } catch (e) { toast(errMsg(e), "error"); }
  }

  // ---- code search --------------------------------------------------------
  const cf = filterBar(() => {}, "instruction text, e.g.  i32.const 2000   or   call 55   or   f32.mul", "contains");
  const csOut = dataTable<{ index: number; name: string; off: number; text: string }>([
    { title: "Function", render: (r) => link(`${r.name} (#${r.index})`, () => ctx.openCode(r.index, r.off)) },
    { title: "Offset", render: (r) => "+0x" + r.off.toString(16), cls: "muted", width: "80px" },
    { title: "Instruction", render: (r) => r.text },
  ], { empty: "Search all function bodies for an instruction pattern" });
  const csStatus = h("span", { class: "muted" });
  const runSearch = async () => {
    csStatus.textContent = "searching…";
    await new Promise((r) => setTimeout(r, 15));
    try {
      const r = await rpc("mod.searchCode", { filter: cf.get(), limit: 1000, budgetMs: 6000 });
      csOut.setRows(r.rows);
      csStatus.textContent = `${r.rows.length} hit(s) · scanned ${r.scanned.toLocaleString()} / ${r.total.toLocaleString()} functions${r.complete ? "" : " (time budget hit — narrow the pattern)"}`;
    } catch (e) { csStatus.textContent = ""; toast(errMsg(e), "error"); }
  };
  const constIn = h("input", { type: "text", class: "mono", placeholder: "constant / address", style: { width: "140px" } });
  const constRange = h("input", { type: "number", min: 0, value: 0, style: { width: "70px" }, title: "also match constants up to N bytes below (field offsets)" });
  const findConst = async () => {
    try {
      const r = await rpc("mod.xrefs", { kind: "addr", value: parseNum(constIn.value), range: Number(constRange.value) || 0 });
      forced = r.refs.map((x: any) => x.index);
      show(`${forced!.length} function(s) load the constant ${constIn.value}`);
    } catch (e) { toast(errMsg(e), "error"); }
  };
  const show = (label?: string) => {
    banner.style.display = forced ? "" : "none";
    banner.replaceChildren(label ?? "", h("button", { onclick: () => { forced = null; show(); pg.reset(); void load(); } }, "show all functions"));
    pg.reset(); void load();
  };

  const el = h("div", { class: "view" },
    banner,
    h("div", { class: "row" }, f.el, kind, sort, h("label", { class: "chk" }, desc, "desc"), h("label", { class: "chk", title: "only functions executed during the last trace (Debugger → Trace)" }, calledOnly, "traced only"), minSize),
    h("div", { class: "row" }, pg.el, h("span", { class: "grow" }), field("Find constant", h("div", { class: "row" }, constIn, constRange, h("button", { onclick: () => void findConst() }, "Find code")))),
    table.el,
    h("div", { class: "panel", style: { flex: "none", maxHeight: "34%", display: "flex", flexDirection: "column", gap: "6px", overflow: "hidden" } },
      h("h3", null, "Code search (all function bodies)"),
      h("div", { class: "row" }, cf.el, h("button", { class: "primary", onclick: () => void runSearch() }, "Search"), csStatus), csOut.el));
  void copyText; void hex;

  return {
    el,
    show(p) {
      if (p?.filterFuncs) { forced = p.filterFuncs; show(p.label); } else void load();
      void (async () => { const l = await rpc("fbp.list").catch(() => []); bps.clear(); for (const b of l) bps.add(b.index); })();
    },
    retarget() { forced = null; banner.style.display = "none"; table.setRows([]); pg.setTotal(0); },
  };
}
