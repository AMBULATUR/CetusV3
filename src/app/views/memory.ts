import { h, hex, hexByte, parseNum, toast, errMsg, select, field, copyText, iconBtn, clear } from "../ui";
import { rpc } from "../api";
import { poller } from "../poll";
import { Ctx, View } from "../ctx";
import { fromHex, hex as hexStr } from "../../wasm/leb";
import { TYPE_INFO, ValType, readVal, writeVal, parseVal, fmtVal, bytesToBits, VAL_TYPES, dec } from "../../shared/codec";

function evalAddr(s: string): number {
  const t = s.replace(/\s+/g, "");
  if (!t) throw new Error("empty address");
  let total = 0;
  const re = /([+-]?)(0x[0-9a-f]+|\d+)/gi;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(t))) { total += (m[1] === "-" ? -1 : 1) * parseNum(m[2]!); consumed += m[0].length; }
  if (consumed !== t.length) throw new Error(`cannot evaluate "${s}"`);
  return total;
}

export function memoryView(ctx: Ctx): View {
  let base = 0;
  let cols = 16;
  let viewSize = 512;
  let bytes: Uint8Array = new Uint8Array(0);
  let changedAt = new Float64Array(0);
  let selA = 0, selB = 0;
  let memBytes = 0;
  let big = false;
  let busy = false;

  const addrIn = h("input", { type: "text", class: "mono", value: "0x00000000", style: { width: "130px" }, title: "address or expression, e.g. 0x1000+0x20" });
  const sizeSel = select<string>([["256", "256 B"], ["512", "512 B"], ["1024", "1 KiB"], ["2048", "2 KiB"], ["4096", "4 KiB"], ["16384", "16 KiB"]], "512", (v) => { viewSize = Number(v); void refresh(true); });
  const colSel = select<string>([["8", "8 cols"], ["16", "16 cols"], ["32", "32 cols"]], "16", (v) => { cols = Number(v); base -= base % cols; void refresh(true); });
  const auto = h("input", { type: "checkbox", checked: true });
  const endian = h("input", { type: "checkbox" });
  const grid = h("div", { class: "hexview", tabindex: 0 });
  const memInfo = h("span", { class: "muted" });
  const inspector = h("tbody");
  const inspHead = h("div", { class: "muted mono" });
  const tableHost = h("div", { class: "fill" });
  const tabHex = h("button", { class: "active" }, "Hex view");
  const tabTbl = h("button", null, "Table view");
  const hexPane = h("div", { class: "cols" });
  const tblPane = h("div", { class: "fill", style: { display: "none" } });

  const sel = () => [Math.min(selA, selB), Math.max(selA, selB)] as const;

  async function refresh(force = false) {
    if (busy || !ctx.target()) return;
    busy = true;
    try {
      const r = await rpc("read", { addr: base, len: viewSize + 16 }, undefined, !force);
      memBytes = r.memBytes;
      const nb = fromHex(r.hex);
      if (force || nb.length !== bytes.length) changedAt = new Float64Array(nb.length);
      else {
        const now = performance.now();
        for (let i = 0; i < nb.length; i++) if (nb[i] !== bytes[i]) changedAt[i] = now;
      }
      bytes = nb;
      memInfo.textContent = `memory: ${memBytes.toLocaleString()} bytes (${(memBytes / 65536) | 0} pages) · max addr ${hex(memBytes - 1)}`;
      draw();
      drawInspector();
    } catch (e) {
      if (force) toast(errMsg(e), "error");
    }
    busy = false;
  }

  function draw() {
    const bm = new Set(ctx.data().bookmarks.map((b) => b.addr));
    const [s0, s1] = sel();
    const now = performance.now();
    const rows = Math.ceil(viewSize / cols);
    const frag = document.createDocumentFragment();
    for (let r = 0; r < rows; r++) {
      const ra = base + r * cols;
      const bytesEl = h("span", { class: "bytes" });
      const asc = h("span", { class: "asc" });
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (i >= viewSize || i >= bytes.length) break;
        const a = ra + c;
        const v = bytes[i]!;
        let cls = "b";
        if (c % 8 === 7 && c !== cols - 1) cls += " g";
        if (a >= s0 && a <= s1) cls += a === selA ? " sel" : " rng";
        if (v === 0) cls += " z";
        if (now - changedAt[i]! < 1500) cls += " chg";
        if (bm.has(a)) cls += " bm";
        bytesEl.appendChild(h("span", { class: cls, dataset: { a: String(a) } }, hexByte(v)));
        const ch = v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : "·";
        asc.appendChild(h("span", { class: a >= s0 && a <= s1 ? "sel" : "", dataset: { a: String(a) } }, ch));
      }
      frag.appendChild(h("div", { class: "hexrow" }, h("span", { class: "addr", dataset: { row: String(ra) }, title: "click to copy" }, hex(ra)), bytesEl, asc));
    }
    clear(grid);
    grid.appendChild(frag);
  }

  grid.addEventListener("mousedown", (e) => {
    const t = (e.target as HTMLElement).closest("[data-a]") as HTMLElement | null;
    if (t) {
      const a = Number(t.dataset.a);
      if (e.shiftKey) selB = a; else { selA = a; selB = a; }
      draw(); drawInspector();
      grid.focus();
    }
    const ad = (e.target as HTMLElement).closest("[data-row]") as HTMLElement | null;
    if (ad) void copyText(hex(Number(ad.dataset.row)));
  });
  grid.addEventListener("dblclick", (e) => {
    const t = (e.target as HTMLElement).closest(".b") as HTMLElement | null;
    if (!t) return;
    const a = Number(t.dataset.a);
    const cur = bytes[a - base]!;
    const inp = h("input", { type: "text", class: "mono", value: hexByte(cur), style: { width: "2.6ch", padding: "0", textAlign: "center" } });
    t.replaceChildren(inp);
    inp.focus(); inp.select();
    const done = async (save: boolean) => {
      if (save) { try { await rpc("writeBytes", { addr: a, hex: inp.value.padStart(2, "0").slice(-2) }); } catch (er) { toast(errMsg(er), "error"); } }
      void refresh(true);
    };
    inp.addEventListener("keydown", (k) => { if (k.key === "Enter") void done(true); else if (k.key === "Escape") void done(false); k.stopPropagation(); });
    inp.addEventListener("blur", () => void done(false));
  });
  grid.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    let a = selA;
    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -cols : e.key === "ArrowDown" ? cols : 0;
    if (e.key === "PageDown") { goto(base + viewSize); e.preventDefault(); return; }
    if (e.key === "PageUp") { goto(base - viewSize); e.preventDefault(); return; }
    if (!step) return;
    e.preventDefault();
    a = Math.max(0, Math.min(Math.max(0, memBytes - 1), a + step));
    if (e.shiftKey) selB = a; else { selA = a; selB = a; }
    if (a < base || a >= base + viewSize) { base = Math.max(0, a - (a % cols) - (step < 0 ? viewSize - cols : 0)); base -= base % cols; void refresh(true); }
    else { draw(); drawInspector(); }
  });

  function goto(a: number, select = true) {
    a = Math.max(0, Math.floor(a));
    base = a - (a % cols);
    if (select) { selA = a; selB = a; }
    addrIn.value = hex(a);
    void refresh(true);
  }

  // ------------------------------------------------------------ inspector ---
  const slice = (n: number): Uint8Array | null => {
    const o = selA - base;
    if (o < 0 || o + n > bytes.length) return null;
    const s = bytes.slice(o, o + n);
    return big ? s.reverse() : s;
  };
  function drawInspector() {
    clear(inspector);
    const [s0, s1] = sel();
    inspHead.textContent = `${hex(selA)}  ·  ${s1 - s0 + 1} byte(s) selected  ·  ${big ? "big" : "little"}-endian`;
    const types: ValType[] = ["u8", "i8", "u16", "i16", "u32", "i32", "u64", "i64", "f32", "f64"];
    for (const t of types) {
      const n = TYPE_INFO[t].size;
      const b = slice(n);
      const row = h("tr", null, h("td", null, t));
      if (!b) { row.appendChild(h("td", { class: "muted" }, "—")); inspector.appendChild(row); continue; }
      const dv = new DataView(b.buffer, b.byteOffset, n);
      const v = readVal(dv, 0, t);
      const inp = h("input", { type: "text", class: "mono", value: fmtVal(t, v), spellcheck: false, style: { width: "100%" } });
      inp.addEventListener("keydown", async (e) => {
        if (e.key !== "Enter") return;
        try {
          const nv = parseVal(t, inp.value);
          const tmp = new DataView(new ArrayBuffer(8));
          writeVal(tmp, 0, t, nv);
          let out = new Uint8Array(tmp.buffer, 0, n).slice();
          if (big) out = out.reverse();
          await rpc("writeBytes", { addr: selA, hex: hexStr(out) });
          toast("written", "ok", 900);
          void refresh(false);
        } catch (er) { toast(errMsg(er), "error"); }
      });
      row.appendChild(h("td", null, inp));
      if (t === "u32") {
        const p = Number(v);
        if (p >= 0x100 && p < memBytes) row.appendChild(h("td", null, iconBtn("→", `follow pointer ${hex(p)}`, () => goto(p))));
      }
      inspector.appendChild(row);
    }
    const raw = bytes.slice(Math.max(0, s0 - base), Math.max(0, Math.min(bytes.length, s1 - base + 1, s0 - base + 32)));
    const ro = (label: string, value: string) => inspector.appendChild(h("tr", null, h("td", null, label), h("td", { class: "mono", style: { wordBreak: "break-all", whiteSpace: "normal" } }, value)));
    ro("hex", Array.from(raw).map(hexByte).join(" "));
    ro("bin", bytesToBits(raw.slice(0, 4), false));
    ro("ascii", Array.from(raw).map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ".")).join(""));
    try { ro("utf-8", new TextDecoder("utf-8", { fatal: false }).decode(raw).replace(/[\x00-\x1f]/g, "·")); } catch { /* ignore */ }
    ro("utf-16", new TextDecoder("utf-16le").decode(raw.slice(0, raw.length & ~1)).replace(/[\x00-\x1f]/g, "·"));
    const w = slice(4);
    if (w) {
      const p = new DataView(w.buffer, w.byteOffset, 4).getUint32(0, true);
      if (p >= 0x100 && p + 8 < memBytes) {
        void rpc("read", { addr: p, len: 40 }).then((r) => {
          const bb = fromHex(r.hex);
          let s = "";
          for (const c of bb) { if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c); else break; }
          if (s.length >= 3) ro("→ ptr", `${hex(p)} "${s}"`);
        }).catch(() => {});
      }
    }
  }

  const addType = select<string>(VAL_TYPES.map((t) => [t, t] as [string, string]), "i32");
  const watchSize = select<string>([["1", "1 byte"], ["2", "2 bytes"], ["4", "4 bytes"], ["8", "8 bytes"]], "4");
  const watch = async (flags: number) => {
    try { await rpc("watch.set", { addr: selA, size: Number(watchSize.value), flags }); toast("Watchpoint set — see Debugger", "ok"); ctx.go("debugger"); } catch (e) { toast(errMsg(e), "error"); }
  };
  const inspector2 = h("div", { class: "panel scroll", style: { width: "330px", flex: "none" } },
    h("h3", null, "Data inspector"), inspHead,
    h("table", { class: "data inspector" }, inspector),
    h("div", { class: "row", style: { marginTop: "8px" } }, h("label", { class: "chk" }, endian, "big-endian")),
    h("h3", { style: { marginTop: "10px" } }, "Actions"),
    h("div", { class: "row" }, addType, h("button", { onclick: () => void ctx.addBookmark(selA, addType.value) }, "＋ Cheat table")),
    h("div", { class: "row", style: { marginTop: "6px" } }, watchSize, h("button", { onclick: () => void watch(2) }, "Find writes"), h("button", { onclick: () => void watch(1) }, "Find reads")),
    h("div", { class: "row", style: { marginTop: "6px" } },
      h("button", { onclick: async () => { try { const r = await rpc("mod.xrefs", { kind: "addr", value: selA, range: 0 }); if (!r.refs.length) toast("No code loads this constant", "info"); else ctx.go("functions", { filterFuncs: r.refs.map((x: any) => x.index), label: `functions referencing ${hex(selA)}` }); } catch (e) { toast(errMsg(e), "error"); } } }, "Code refs"),
      h("button", { onclick: () => void copyText(hex(selA)) }, "Copy addr"),
      h("button", { onclick: () => { const [a, b] = sel(); void copyText(Array.from(bytes.slice(a - base, b - base + 1)).map(hexByte).join(" ")); } }, "Copy hex")));
  endian.addEventListener("change", () => { big = endian.checked; drawInspector(); });

  // ------------------------------------------------------------ table view --
  function buildTable() {
    clear(tblPane);
    const start = h("input", { type: "text", class: "mono", value: hex(selA), style: { width: "110px" } });
    const stride = h("input", { type: "number", value: 4, min: 1, style: { width: "70px" } });
    const count = h("input", { type: "number", value: 32, min: 1, max: 500, style: { width: "70px" } });
    const checks = (["u8", "i16", "i32", "u32", "f32", "i64", "f64"] as const).map((t) => ({ t, cb: h("input", { type: "checkbox", checked: ["i32", "f32", "u32"].includes(t) }) }));
    const head = h("tr"); const body = h("tbody");
    const draw2 = async () => {
      try {
        const s = evalAddr(start.value); const st = Math.max(1, Number(stride.value)); const n = Math.min(500, Number(count.value));
        const active = checks.filter((c) => c.cb.checked).map((c) => c.t);
        const items: { addr: number; type: string }[] = [];
        for (let i = 0; i < n; i++) for (const t of active) items.push({ addr: s + i * st, type: t });
        const vals: any[] = await rpc("readValues", { items });
        clear(head); clear(body);
        head.append(h("th", null, "address"), h("th", null, "+off"), ...active.map((t) => h("th", null, t)));
        for (let i = 0; i < n; i++) {
          const tr = h("tr", null, h("td", null, h("a", { class: "link", href: "#", onclick: (e: Event) => { e.preventDefault(); goto(s + i * st); setTab("hex"); } }, hex(s + i * st))), h("td", { class: "muted" }, "+" + (i * st).toString(16)));
          active.forEach((t, k) => { const v = vals[i * active.length + k]; tr.appendChild(h("td", null, v === null ? "—" : fmtVal(t as ValType, dec(t as ValType, v)))); });
          body.appendChild(tr);
        }
      } catch (e) { toast(errMsg(e), "error"); }
    };
    tblPane.append(
      h("div", { class: "row" }, field("Start", start), field("Stride (bytes)", stride), field("Rows", count),
        ...checks.map((c) => h("label", { class: "chk" }, c.cb, c.t)), h("button", { class: "primary", onclick: () => void draw2() }, "Show")),
      h("div", { class: "table-wrap" }, h("table", { class: "data" }, h("thead", null, head), body)));
    void draw2();
  }

  const setTab = (t: "hex" | "tbl") => {
    tabHex.classList.toggle("active", t === "hex"); tabTbl.classList.toggle("active", t === "tbl");
    hexPane.style.display = t === "hex" ? "" : "none"; tblPane.style.display = t === "tbl" ? "flex" : "none";
    if (t === "tbl") buildTable();
  };
  tabHex.onclick = () => setTab("hex"); tabTbl.onclick = () => setTab("tbl");

  const go = () => { try { goto(evalAddr(addrIn.value)); } catch (e) { toast(errMsg(e), "error"); } };
  addrIn.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  void tableHost;
  hexPane.append(h("div", { class: "fill" }, grid), inspector2);
  tblPane.classList.add("stack");

  const poll = poller("pollMemory", async () => { if (auto.checked && tblPane.style.display === "none") await refresh(false); });
  const el = h("div", { class: "view" },
    h("div", { class: "row" }, addrIn, h("button", { onclick: go }, "Go"),
      iconBtn("◀", "previous page (PgUp)", () => goto(base - viewSize, false)), iconBtn("▶", "next page (PgDn)", () => goto(base + viewSize, false)),
      sizeSel, colSel, h("label", { class: "chk" }, auto, "auto-refresh"), h("button", { onclick: () => void refresh(true) }, "↻"), memInfo),
    h("div", { class: "tabs" }, tabHex, tabTbl), hexPane, tblPane);

  return {
    el,
    show(p) {
      if (p?.addr !== undefined) goto(p.addr); else void refresh(true);
      poll.start();
    },
    hide() { poll.stop(); },
    retarget() { bytes = new Uint8Array(0); clear(grid); },
  };
}
