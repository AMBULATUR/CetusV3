import { h, hex, pager, dataTable, toast, errMsg, link, iconBtn, download, rowsToCsv, select, field, filterBar, copyText, parseNum } from "../ui";
import { rpc } from "../api";
import { Ctx, View } from "../ctx";

interface Row { addr: number; len: number; bytes: number; enc: string; text: string; cut: boolean }

export function stringsView(ctx: Ctx): View {
  const cbAscii = h("input", { type: "checkbox", checked: true });
  const cbUtf8 = h("input", { type: "checkbox", checked: false, title: "also finds non-ASCII text (Cyrillic, CJK, accents…)" });
  const cbUtf16 = h("input", { type: "checkbox", checked: true });
  const cbWide = h("input", { type: "checkbox", title: "accept any printable UTF-16 character, not only ASCII range (noisier)" });
  const minLen = h("input", { type: "number", value: 4, min: 1, style: { width: "64px" } });
  const lower = h("input", { type: "text", class: "mono", value: "0", style: { width: "90px" } });
  const upper = h("input", { type: "text", class: "mono", value: "0", style: { width: "90px" } });
  const scanBtn = h("button", { class: "primary" }, "Scan memory");
  const status = h("span", { class: "muted" }, "Not scanned yet");
  const f = filterBar(() => { pg.reset(); void load(); }, "search strings…");
  const lenMin = h("input", { type: "number", min: 0, placeholder: "min", style: { width: "64px" } });
  const lenMax = h("input", { type: "number", min: 0, placeholder: "max", style: { width: "64px" } });
  const encF = select<string>([["", "any encoding"], ["ascii", "ascii"], ["utf8", "utf-8"], ["utf16", "utf-16"]], "");
  const sort = select<string>([["addr", "sort: address"], ["len", "sort: length"], ["alpha", "sort: A→Z"]], "addr");
  const desc = h("input", { type: "checkbox" });
  let matched = 0;
  let scanned = false;
  for (const x of [lenMin, lenMax, encF, sort, desc]) x.addEventListener("change", () => { pg.reset(); void load(); });

  const pg = pager(() => void load(), [50, 100, 250, 500, 1000], 100);
  const query = (offset: number, limit: number) => ({
    filter: f.get(), encs: encF.value ? [encF.value] : [], lenMin: Number(lenMin.value) || 0, lenMax: Number(lenMax.value) || 0,
    sort: sort.value, desc: desc.checked, offset, limit,
  });
  const table = dataTable<Row>([
    { title: "Address", render: (r) => link(hex(r.addr), () => ctx.openMemory(r.addr), "show in memory view"), width: "100px" },
    { title: "Len", render: (r) => r.len, cls: "num", width: "56px" },
    { title: "Enc", render: (r) => r.enc, cls: "muted", width: "54px" },
    { title: "String", render: (r) => h("span", { title: r.text }, r.text + (r.cut ? " …" : "")), cls: "wrap" },
    { title: "", width: "170px", render: (r) => h("span", { class: "row", style: { gap: "2px", flexWrap: "nowrap" } },
      iconBtn("⌖", "show in memory view", () => ctx.openMemory(r.addr)),
      iconBtn("＋", "add to cheat table", () => void ctx.addBookmark(r.addr, "u8", r.text.slice(0, 30))),
      iconBtn("ƒ", "code that references this address", () => void xrefs(r.addr)),
      iconBtn("⎘", "copy string", () => void copyText(r.text)),
      iconBtn("W", "find what writes here", () => void rpc("watch.set", { addr: r.addr, size: 1, flags: 2 }).then(() => { toast("watching writes — see Debugger", "ok"); ctx.go("debugger"); }).catch((e) => toast(errMsg(e), "error")))) },
  ], { empty: "Scan memory, then search — results are paged so thousands of strings are fine" });

  const xrefs = async (addr: number) => {
    try {
      const r = await rpc("mod.xrefs", { kind: "addr", value: addr, range: 0 });
      if (!r.refs.length) { toast(`No function loads the constant ${addr} directly (the string may be addressed via a base+offset)`, "info"); return; }
      ctx.go("functions", { filterFuncs: r.refs.map((x: any) => x.index), label: `functions referencing ${hex(addr)}` });
    } catch (e) { toast(errMsg(e), "error"); }
  };

  async function load() {
    if (!scanned) return;
    try {
      const r = await rpc("strings.query", query(pg.offset, pg.size));
      matched = r.matched;
      pg.setTotal(r.matched);
      table.setRows(r.rows);
      status.textContent = `${r.matched.toLocaleString()} match${r.matched === 1 ? "" : "es"} of ${r.total.toLocaleString()} strings${r.truncated ? " (scan limit reached)" : ""}`;
    } catch (e) { toast(errMsg(e), "error"); }
  }

  scanBtn.onclick = async () => {
    const encodings = [cbAscii.checked && !cbUtf8.checked ? "ascii" : "", cbUtf8.checked ? "utf8" : "", cbUtf16.checked ? "utf16" : ""].filter(Boolean);
    if (!encodings.length) return toast("pick at least one encoding", "error");
    scanBtn.disabled = true; status.textContent = "Scanning memory…";
    await new Promise((r) => setTimeout(r, 20));
    try {
      const r = await rpc("strings.scan", { encodings, minLen: Number(minLen.value) || 4, lower: parseNum(lower.value || "0"), upper: parseNum(upper.value || "0"), wide: cbWide.checked });
      scanned = true; pg.reset(); await load();
      if (r.truncated) toast("Stopped at 3,000,000 strings — raise the minimum length", "info");
    } catch (e) { toast(errMsg(e), "error"); status.textContent = "scan failed"; }
    scanBtn.disabled = false;
  };

  const exportAll = async (fmt: "txt" | "csv" | "json" | "tsv") => {
    if (!scanned || !matched) return toast("nothing to export", "info");
    const all: Row[] = [];
    for (let off = 0; off < matched; off += 5000) {
      const r = await rpc("strings.query", query(off, 5000));
      all.push(...r.rows);
      status.textContent = `Exporting ${all.length.toLocaleString()} / ${matched.toLocaleString()}…`;
      await new Promise((r2) => setTimeout(r2, 0));
    }
    if (fmt === "txt") download("strings.txt", all.map((r) => r.text).join("\n"));
    else if (fmt === "tsv") download("strings.tsv", all.map((r) => `${hex(r.addr)}\t${r.text.replace(/[\t\r\n]+/g, " ")}`).join("\n"));
    else if (fmt === "csv") download("strings.csv", rowsToCsv([["address", "length", "encoding", "string"], ...all.map((r) => [hex(r.addr), r.len, r.enc, r.text])]), "text/csv");
    else download("strings.json", JSON.stringify(all.map((r) => ({ address: r.addr, hex: hex(r.addr), length: r.len, encoding: r.enc, text: r.text })), null, 1), "application/json");
    status.textContent = `exported ${all.length.toLocaleString()} strings`;
    toast(`Exported ${all.length.toLocaleString()} strings`, "ok");
  };
  const exp = select<string>([["", "Export all matches…"], ["txt", "TXT (strings only)"], ["tsv", "TSV (address, string)"], ["csv", "CSV"], ["json", "JSON"]], "");
  exp.addEventListener("change", () => { const v = exp.value; exp.value = ""; if (v) void exportAll(v as any); });

  const el = h("div", { class: "view" },
    h("div", { class: "panel" }, h("div", { class: "row" },
      h("label", { class: "chk" }, cbAscii, "ASCII"), h("label", { class: "chk" }, cbUtf8, "UTF-8"), h("label", { class: "chk" }, cbUtf16, "UTF-16"), h("label", { class: "chk" }, cbWide, "wide"),
      field("Min length", minLen), field("From", lower), field("To", upper), scanBtn, status)),
    h("div", { class: "row" }, f.el, lenMin, lenMax, encF, sort, h("label", { class: "chk" }, desc, "desc"), exp),
    pg.el, table.el);
  return { el, retarget() { scanned = false; table.setRows([]); pg.setTotal(0); status.textContent = "Not scanned yet"; } };
}
