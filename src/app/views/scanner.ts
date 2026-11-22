import { h, hex, pager, dataTable, toast, errMsg, link, iconBtn, download, rowsToCsv, select, field, parseNum } from "../ui";
import { rpc } from "../api";
import { poller } from "../poll";
import { Ctx, View } from "../ctx";
import { VAL_TYPES, ValType, dec, fmtVal } from "../../shared/codec";

const FIRST: [string, string][] = [
  ["eq", "Exact value"], ["ne", "Not equal"], ["gt", "Bigger than"], ["gte", "Bigger or equal"], ["lt", "Smaller than"], ["lte", "Smaller or equal"],
  ["between", "Between"], ["unknown", "Unknown initial value"],
];
const NEXT: [string, string][] = [
  ["eq", "Exact value"], ["changed", "Changed"], ["unchanged", "Unchanged"], ["increased", "Increased"], ["decreased", "Decreased"],
  ["increasedBy", "Increased by"], ["decreasedBy", "Decreased by"], ["gt", "Bigger than"], ["lt", "Smaller than"], ["ne", "Not equal"], ["between", "Between"],
];
const TYPE_LABEL: Record<string, string> = { i32: "i32 (4 byte int)", u32: "u32 (4 byte unsigned)", f32: "f32 (float)", i64: "i64 (8 byte int)", u64: "u64", f64: "f64 (double)", i16: "i16", u16: "u16", i8: "i8", u8: "u8 (byte)" };

export function scannerView(ctx: Ctx): View {
  const typeSel = select<string>([...VAL_TYPES.map((t) => [t, TYPE_LABEL[t]!] as [string, string]), ["ascii", "Text (ASCII)"], ["utf16", "Text (UTF-16)"], ["bytes", "Bytes (hex, ?? wildcard)"]], "i32");
  const cmpSel = select<string>(FIRST, "eq");
  const v1 = h("input", { type: "text", class: "mono", placeholder: "value", spellcheck: false, style: { width: "180px" } });
  const v2 = h("input", { type: "text", class: "mono", placeholder: "to", spellcheck: false, style: { width: "120px", display: "none" } });
  const align = h("input", { type: "checkbox", checked: true });
  const rounded = h("input", { type: "checkbox", checked: true });
  const lower = h("input", { type: "text", class: "mono", value: "0", style: { width: "90px" } });
  const upper = h("input", { type: "text", class: "mono", value: "0", style: { width: "90px" }, title: "0 = end of memory" });
  const info = h("span", { class: "muted" }, "No scan yet");
  const firstBtn = h("button", { class: "primary" }, "First Scan");
  const nextBtn = h("button", { disabled: true }, "Next Scan");
  const resetBtn = h("button", null, "New Scan");
  let started = false;
  let pattern = false;
  let total = 0;
  let rows: { addr: number; value: any; prev: any }[] = [];
  let type: ValType = "i32";

  const isText = () => ["ascii", "utf16", "bytes"].includes(typeSel.value);
  const updateForm = () => {
    const text = isText();
    cmpSel.style.display = text ? "none" : "";
    v2.style.display = !text && cmpSel.value === "between" ? "" : "none";
    const noVal = !text && ["unknown", "changed", "unchanged", "increased", "decreased"].includes(cmpSel.value);
    v1.style.display = noVal ? "none" : "";
    v1.placeholder = typeSel.value === "bytes" ? "e.g. 8B 45 ?? 89" : text ? "text to find" : "value";
    typeSel.disabled = started && !pattern;
    nextBtn.disabled = !started || pattern || text;
    firstBtn.textContent = started ? "Re-scan from scratch" : "First Scan";
  };
  const setCmpList = () => {
    const cur = cmpSel.value;
    cmpSel.replaceChildren(...(started ? NEXT : FIRST).map(([v, l]) => h("option", { value: v }, l)));
    if ([...cmpSel.options].some((o) => o.value === cur)) cmpSel.value = cur;
    updateForm();
  };
  typeSel.addEventListener("change", updateForm);
  cmpSel.addEventListener("change", updateForm);

  const params = () => ({
    type: typeSel.value, cmp: cmpSel.value, value: v1.value, value2: v2.value, align: align.checked,
    lower: parseNum(lower.value || "0"), upper: parseNum(upper.value || "0"), rounded: rounded.checked,
  });
  const afterScan = (s: any) => {
    started = s.started; pattern = s.pattern; total = s.count; type = s.type;
    setCmpList();
    info.textContent = s.snapshot ? "Snapshot taken — change something in the app, then Next Scan" : `${s.count.toLocaleString()} result${s.count === 1 ? "" : "s"}${s.truncated ? " (truncated at the limit — refine the scan)" : ""}`;
    pg.setTotal(s.count);
    pg.reset();
    void load();
  };
  const run = async (fn: () => Promise<any>) => {
    const busy = [firstBtn, nextBtn, resetBtn];
    busy.forEach((b) => (b.disabled = true));
    info.textContent = "Scanning…";
    await new Promise((r) => setTimeout(r, 20));
    try { afterScan(await fn()); } catch (e) { toast(errMsg(e), "error"); info.textContent = "Scan failed"; }
    busy.forEach((b) => (b.disabled = false));
    updateForm();
  };
  firstBtn.onclick = () => {
    if (isText()) {
      const p = params();
      void run(() => rpc("scan.pattern", { kind: typeSel.value, text: v1.value, lower: p.lower, upper: p.upper }));
    } else void run(() => rpc("scan.first", params()));
  };
  nextBtn.onclick = () => void run(() => rpc("scan.next", params()));
  resetBtn.onclick = () => { void run(() => rpc("scan.reset")); v1.value = ""; };

  const pg = pager(() => void load());
  const table = dataTable<{ addr: number; value: any; prev: any }>([
    { title: "Address", render: (r) => link(hex(r.addr), () => ctx.openMemory(r.addr), "show in memory view") },
    { title: pattern ? "Bytes" : "Value", render: (r) => valueCell(r) },
    { title: "Previous", render: (r) => (r.prev === null ? "" : String(r.prev)), cls: "muted" },
    { title: "", render: (r) => h("span", { class: "row", style: { gap: "2px", flexWrap: "nowrap" } },
      iconBtn("＋", "add to cheat table", () => void ctx.addBookmark(r.addr, pattern ? "u8" : type)),
      iconBtn("⌖", "show in memory view", () => ctx.openMemory(r.addr)),
      iconBtn("W", "find what writes to this address", () => void watch(r.addr, 2)),
      iconBtn("R", "find what reads this address", () => void watch(r.addr, 1))), width: "130px" },
  ], { empty: "Run a scan to see results" });

  const watch = async (addr: number, flags: number) => {
    try {
      const size = pattern ? 1 : Math.min(8, Number(/\d+/.exec(type)?.[0] ?? 8) / 8);
      await rpc("watch.set", { addr, size: [1, 2, 4, 8].includes(size) ? size : 4, flags });
      toast(`Watching ${flags === 1 ? "reads" : "writes"} at ${hex(addr)} — see Debugger`, "ok");
      ctx.go("debugger");
    } catch (e) { toast(errMsg(e), "error"); }
  };

  function valueCell(r: { addr: number; value: any }): Node {
    if (pattern) return h("span", null, String(r.value));
    const inp = h("input", { type: "text", value: fmtVal(type, dec(type, r.value)), spellcheck: false });
    inp.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      try { await rpc("write", { addr: r.addr, type, value: inp.value }); toast("written", "ok", 900); } catch (er) { toast(errMsg(er), "error"); }
    });
    return inp;
  }

  async function load(live = false) {
    if (!started || (!total && !live)) { table.setRows([]); return; }
    try {
      const r = await rpc("scan.page", { offset: pg.offset, limit: pg.size }, undefined, live);
      if (live && document.activeElement && table.el.contains(document.activeElement)) return; // don't clobber edits
      rows = r.rows;
      table.setRows(rows);
    } catch (e) { if (!live) toast(errMsg(e), "error"); }
  }

  const exportAll = async (kind: "csv" | "txt") => {
    const out: (string | number)[][] = [["address", "value"]];
    for (let off = 0; off < total; off += 5000) {
      const r = await rpc("scan.export", { offset: off, limit: 5000 });
      for (const x of r.rows) out.push([hex(x.addr), x.value]);
      info.textContent = `Exporting ${Math.min(total, off + 5000).toLocaleString()} / ${total.toLocaleString()}…`;
    }
    download(`scan-results.${kind}`, kind === "csv" ? rowsToCsv(out) : out.slice(1).map((r) => r.join("\t")).join("\n"));
    info.textContent = `${total.toLocaleString()} results`;
    toast(`Exported ${total.toLocaleString()} results`, "ok");
  };
  const addPage = async () => { for (const r of rows.slice(0, 200)) await ctx.addBookmark(r.addr, pattern ? "u8" : type); toast(`Added ${Math.min(rows.length, 200)} addresses`, "ok"); };

  const el = h("div", { class: "view" },
    h("div", { class: "panel" },
      h("div", { class: "row" }, field("Value type", typeSel), field("Scan type", cmpSel), field("Value", h("div", { class: "row" }, v1, v2)),
        field("From", lower), field("To", upper),
        h("label", { class: "chk" }, align, "aligned"), h("label", { class: "chk", title: "float equality matches the number of decimals you typed" }, rounded, "rounded floats")),
      h("div", { class: "row", style: { marginTop: "8px" } }, firstBtn, nextBtn, resetBtn, info)),
    h("div", { class: "row" }, pg.el, h("span", { class: "grow" }),
      h("button", { onclick: () => void addPage(), title: "add first 200 rows of this page" }, "＋ page to cheat table"),
      h("button", { onclick: () => void exportAll("csv") }, "Export CSV"), h("button", { onclick: () => void exportAll("txt") }, "Export TXT")),
    table.el);
  updateForm();
  const poll = poller("pollScanner", () => load(true));

  return {
    el,
    show() { void load(); poll.start(); },
    hide() { poll.stop(); },
    retarget() { started = false; total = 0; pattern = false; setCmpList(); table.setRows([]); pg.setTotal(0); info.textContent = "No scan yet"; },
  };
}
