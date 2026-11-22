import { h, hex, pager, dataTable, toast, errMsg, link, filterBar, Col, fmtBytes } from "../ui";
import { rpc } from "../api";
import { Ctx, View } from "../ctx";

type TableId = "imports" | "exports" | "globals" | "tables" | "memories" | "types" | "data" | "customs";

export function moduleView(ctx: Ctx): View {
  const tabs: [TableId | "summary", string][] = [["summary", "Summary"], ["imports", "Imports"], ["exports", "Exports"], ["globals", "Globals"], ["tables", "Tables"], ["memories", "Memories"], ["types", "Types"], ["data", "Data segments"], ["customs", "Custom sections"]];
  let cur: TableId | "summary" = "summary";
  const tabBar = h("div", { class: "tabs" });
  const f = filterBar(() => { pg.reset(); void load(); }, "name / module / field / signature…");
  const pg = pager(() => void load(), [50, 100, 250, 500, 1000], 100);
  const summary = h("div", { class: "scroll panel" });
  const host = h("div", { class: "fill" });
  const tableWrap = h("div", { class: "fill" });

  const fn = (i: number) => link(String(i), () => ctx.openCode(i));
  const cols: Record<TableId, Col<any>[]> = {
    imports: [{ title: "#", render: (r) => r.n, width: "56px" }, { title: "Kind", render: (r) => r.kind, width: "70px" }, { title: "Module", render: (r) => r.module }, { title: "Field", render: (r) => r.kind === "func" ? link(r.field, () => ctx.openCode(r.index)) : r.field }, { title: "Index", render: (r) => r.index, cls: "num" }, { title: "Type", render: (r) => r.type, cls: "muted" }],
    exports: [{ title: "Name", render: (r) => r.kind === "func" ? link(r.name, () => ctx.openCode(r.index)) : r.name }, { title: "Kind", render: (r) => r.kind, width: "70px" }, { title: "Index", render: (r) => r.index, cls: "num" }, { title: "Type", render: (r) => r.type, cls: "muted" }],
    globals: [{ title: "#", render: (r) => r.index }, { title: "Type", render: (r) => r.type }, { title: "Mutable", render: (r) => (r.mutable ? "yes" : "") }, { title: "Imported", render: (r) => (r.imported ? "yes" : "") }, { title: "Init", render: (r) => r.init, cls: "muted" }],
    tables: [{ title: "#", render: (r) => r.index }, { title: "Elem type", render: (r) => r.type }, { title: "Min", render: (r) => r.min }, { title: "Max", render: (r) => r.max ?? "" }, { title: "Imported", render: (r) => (r.imported ? "yes" : "") }],
    memories: [{ title: "#", render: (r) => r.index }, { title: "Min pages", render: (r) => r.min }, { title: "Max pages", render: (r) => r.max ?? "∞" }, { title: "Shared", render: (r) => (r.shared ? "yes" : "") }, { title: "64-bit", render: (r) => (r.memory64 ? "yes" : "") }, { title: "Imported", render: (r) => (r.imported ? "yes" : "") }],
    types: [{ title: "#", render: (r) => r.index, width: "70px" }, { title: "Signature", render: (r) => r.sig }],
    data: [{ title: "#", render: (r) => r.index }, { title: "Mode", render: (r) => r.mode }, { title: "Offset", render: (r) => (r.offset === null ? "" : link(hex(r.offset), () => ctx.openMemory(r.offset), "show in memory view")) }, { title: "Size", render: (r) => fmtBytes(r.size), cls: "num" }, { title: "Bytes", render: (r) => r.size, cls: "muted num" }],
    customs: [{ title: "Name", render: (r) => r.name }, { title: "Size", render: (r) => fmtBytes(r.size), cls: "num" }],
  };
  void fn;
  const tables = new Map<TableId, ReturnType<typeof dataTable<any>>>();

  const select2 = (id: TableId | "summary") => {
    cur = id;
    tabBar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.id === id));
    summary.style.display = id === "summary" ? "" : "none";
    tableWrap.style.display = id === "summary" ? "none" : "flex";
    if (id === "summary") return void loadSummary();
    let t = tables.get(id);
    if (!t) { t = dataTable(cols[id], { empty: "Nothing here" }); tables.set(id, t); }
    tableWrap.replaceChildren(t.el);
    pg.reset();
    void load();
  };
  for (const [id, label] of tabs) tabBar.appendChild(h("button", { dataset: { id }, onclick: () => select2(id) }, label));

  async function load() {
    if (cur === "summary") return;
    try {
      const r = await rpc("mod.table", { table: cur, filter: f.get(), offset: pg.offset, limit: pg.size });
      pg.setTotal(r.total);
      tables.get(cur)?.setRows(r.rows);
    } catch (e) { toast(errMsg(e), "error"); }
  }
  async function loadSummary() {
    try {
      const s = await rpc("mod.summary");
      const t = ctx.target()!.info;
      summary.replaceChildren(
        h("h3", null, "Module"),
        h("table", { class: "data" }, h("tbody", null,
          ...([["size", fmtBytes(t.moduleBytes)], ["functions", `${s.funcs.toLocaleString()} (${s.importedFuncs} imported)`], ["types", s.types], ["imports", s.imports], ["exports", s.exports], ["globals", s.globals], ["tables", s.tables], ["data segments", s.data],
            ["memories", s.memories.map((m: any) => `${m.min}–${m.max ?? "∞"} pages${m.shared ? " shared" : ""}${m.memory64 ? " 64-bit" : ""}`).join("; ")], ["start function", s.start ?? "—"], ["module name", s.moduleName ?? "—"], ["name section", s.hasNames ? "present (readable function names)" : "stripped"]] as [string, any][]).map(([k, v]) => h("tr", null, h("td", { class: "muted" }, k), h("td", null, String(v)))))),
        h("h3", { style: { marginTop: "12px" } }, "Sections"),
        h("table", { class: "data" }, h("tbody", null, ...s.sections.map((x: any) => h("tr", null, h("td", null, x.name), h("td", { class: "num" }, fmtBytes(x.size)))))),
        s.warnings.length ? h("div", { class: "banner err" }, "Parser warnings: " + s.warnings.join("; ")) : "");
    } catch (e) { toast(errMsg(e), "error"); }
  }
  void host;

  const el = h("div", { class: "view" }, tabBar, h("div", { class: "row" }, f.el, pg.el), summary, tableWrap);
  return { el, show() { select2(cur); }, retarget() { tables.clear(); } };
}
