import { h, hex, hexByte, dataTable, toast, errMsg, link, iconBtn, clear } from "../ui";
import { rpc, reloadTarget, LineBp } from "../api";
import { poller } from "../poll";
import { Ctx } from "../ctx";
import { fromHex } from "../../wasm/leb";

export interface SiteInfo { id: number; func: number; fn?: string; off: number; found: boolean; name: string; kind: "store" | "load" | "generic"; size: number; valType: number; offset: number; localCodes: number[]; enabled: boolean; cond: string; pause: boolean; count: number }
interface HitRow { n: number; id: number; t: number; ea: number; value: string | null; old: string | null; frames: { fn: number; off: number; origOff: number | null; name: string }[]; locals: [number, string][] }

const TYPE_NAME: Record<number, string> = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64" };

/** Interpretations of a raw value: decimal, hex and (for 4/8-byte values) float. */
export function fmtBits(bits: string | null, valType: number, size: number): string {
  if (bits === null) return "—";
  const b = BigInt(bits);
  const width = valType === 0x7e || valType === 0x7c ? 64 : 32;
  if (valType === 0x7d) return `${+new DataView(new Uint32Array([Number(b)]).buffer).getFloat32(0, true).toPrecision(7)} (0x${b.toString(16)})`;
  if (valType === 0x7c) return `${new DataView(new BigUint64Array([b]).buffer).getFloat64(0, true)} (0x${b.toString(16)})`;
  const dec = size && size * 8 < width ? b : BigInt.asIntN(width, b);
  let s = `${dec} (0x${b.toString(16)})`;
  if (size === 4 || (!size && width === 32)) {
    const f = new DataView(new Uint32Array([Number(BigInt.asUintN(32, b))]).buffer).getFloat32(0, true);
    if (Number.isFinite(f) && Math.abs(f) > 1e-6 && Math.abs(f) < 1e9 && !Number.isInteger(f)) s += `  ≈ ${+f.toPrecision(6)}f`;
  }
  return s;
}

export interface LineBpPanel { el: HTMLElement; start(): void; stop(): void; refresh(): Promise<void> }

export function lineBpPanel(ctx: Ctx, opts: { func?: () => number | undefined; onChange?: () => void } = {}): LineBpPanel {
  let sites: SiteInfo[] = [];
  let hits: HitRow[] = [];
  let sel: HitRow | null = null;
  const banner = h("div", { class: "banner linebp-banner", style: { display: "none" } });
  const detail = h("div", { class: "panel scroll", style: { width: "400px", flex: "none" } });
  const fname = (fn: number) => sites.find((s) => s.func === fn)?.fn ?? ctx.data().names[fn] ?? `func_${fn}`;
  const bps = (): LineBp[] => ctx.data().lineBps.filter((b) => opts.func?.() === undefined || b.func === opts.func());
  const siteOf = (b: { func: number; off: number }) => sites.find((s) => s.func === b.func && s.off === b.off);
  const siteById = (id: number) => sites.find((s) => s.id === id);

  const bpTable = dataTable<LineBp>([
    { title: "On", width: "36px", render: (b) => { const c = h("input", { type: "checkbox", checked: b.enabled }); c.onchange = () => void setEnabled(b, c.checked); return c; } },
    { title: "Line", render: (b) => h("span", null, link(`${fname(b.func)} +0x${b.off.toString(16)}`, () => ctx.openCode(b.func, b.off), "open in the disassembler"), h("span", { class: "muted mono" }, "  " + (b.text ?? siteOf(b)?.name ?? ""))) },
    { title: "Condition", width: "250px", render: (b) => {
      const i = h("input", { type: "text", class: "mono", value: b.cond ?? "", placeholder: "ea == 0x7d0 && value > 100", spellcheck: false, title: "variables: ea (effective address), value, old, size.  Empty = every hit" });
      i.addEventListener("change", async () => { try { b.cond = i.value.trim(); await rpc("bp.config", { func: b.func, off: b.off, cond: b.cond }).catch((e) => { if (!/not compiled/.test(errMsg(e))) throw e; }); await ctx.saveData(); i.style.borderColor = ""; } catch (e) { i.style.borderColor = "var(--err)"; toast(errMsg(e), "error"); } });
      return i;
    } },
    { title: "⏸", width: "36px", render: (b) => { const c = h("input", { type: "checkbox", checked: !!b.pause, title: "run `debugger;` on every hit (open DevTools on the game tab first)" }); c.onchange = () => { b.pause = c.checked; void rpc("bp.config", { func: b.func, off: b.off, pause: c.checked }).catch(() => {}); void ctx.saveData(); }; return c; } },
    { title: "Hits", width: "70px", cls: "num", render: (b) => String(siteOf(b)?.count ?? 0) },
    { title: "Status", width: "120px", render: (b) => { const s = siteOf(b); return s ? (s.found ? h("span", { class: "badge ok" }, s.kind === "generic" ? "active" : s.kind) : h("span", { class: "badge err", title: "no instruction starts at this offset" }, "not found")) : h("span", { class: "badge warn", title: "compiled in when the page loads" }, "pending reload"); } },
    { title: "", width: "40px", render: (b) => iconBtn("✕", "remove", () => void remove(b), "danger") },
  ], { empty: "No line breakpoints here. In the Code view click the ● gutter next to an instruction." });

  async function setEnabled(b: LineBp, on: boolean) {
    b.enabled = on;
    try { await rpc("bp.config", { func: b.func, off: b.off, enabled: on }); } catch (e) { if (!/not compiled/.test(errMsg(e))) toast(errMsg(e), "error"); }
    await ctx.saveData(); opts.onChange?.();
  }
  async function remove(b: LineBp) {
    const d = ctx.data();
    d.lineBps = d.lineBps.filter((x) => x !== b);
    try { await rpc("bp.config", { func: b.func, off: b.off, enabled: false }); } catch { /* not compiled in */ }
    await ctx.saveData(); opts.onChange?.(); void refresh();
  }

  const hitTable = dataTable<HitRow>([
    { title: "#", width: "52px", cls: "num", render: (r) => r.n },
    { title: "Time", width: "96px", cls: "muted", render: (r) => new Date(r.t).toLocaleTimeString() + "." + String(r.t % 1000).padStart(3, "0") },
    { title: "Line", render: (r) => { const s = siteById(r.id); return s ? link(`${fname(s.func)} +0x${s.off.toString(16)}`, () => ctx.openCode(s.func, s.off)) : "?"; } },
    { title: "Kind", width: "64px", render: (r) => { const s = siteById(r.id); return h("span", { class: "badge " + (s?.kind === "store" ? "warn" : s?.kind === "load" ? "ok" : "") }, s?.kind === "generic" ? "exec" : s?.kind ?? ""); } },
    { title: "Address", width: "110px", render: (r) => { const s = siteById(r.id); return s && s.kind !== "generic" ? link(hex(r.ea), () => ctx.openMemory(r.ea), "show in memory view") : ""; } },
    { title: "Value (old → new)", render: (r) => { const s = siteById(r.id); if (!s || s.kind === "generic") return h("span", { class: "muted" }, "—"); return h("span", { class: "mono" }, s.kind === "store" ? `${fmtBits(r.old, s.valType, s.size)}  →  ${fmtBits(r.value, s.valType, s.size)}` : fmtBits(r.value, s.valType, s.size)); } },
    { title: "Called from", render: (r) => { const f = r.frames[1]; return f ? link(`${f.name} +0x${(f.origOff ?? f.off).toString(16)}`, () => ctx.openCode(f.fn, f.origOff ?? undefined)) : h("span", { class: "muted" }, "(host)"); } },
  ], { empty: "No hits yet. Enable a breakpoint and make the game execute that line.", onRow: (r) => void select(r), rowClass: (r) => (sel && sel.n === r.n ? "sel" : "") });
  hitTable.el.addEventListener("click", (e) => { const tr = (e.target as HTMLElement).closest("tbody tr") as HTMLElement | null; if (!tr) return; const i = Array.from(tr.parentElement!.children).indexOf(tr); if (hitTable.rows[i]) void select(hitTable.rows[i]!); });

  async function select(r: HitRow) {
    sel = r;
    const s = siteById(r.id);
    clear(detail);
    if (!s) return;
    detail.appendChild(h("h3", null, `Hit #${r.n} — ${s.name || "instruction"} @ ${fname(s.func)} +0x${s.off.toString(16)}`));
    if (s.kind !== "generic") {
      detail.appendChild(h("table", { class: "data inspector" }, h("tbody", null,
        h("tr", null, h("td", null, "address"), h("td", { class: "mono" }, `${hex(r.ea)}  (base + offset ${s.offset})`)),
        h("tr", null, h("td", null, "size"), h("td", null, `${s.size} byte(s), ${TYPE_NAME[s.valType] ?? ""} operand`)),
        s.kind === "store" ? h("tr", null, h("td", null, "old"), h("td", { class: "mono" }, fmtBits(r.old, s.valType, s.size))) : "",
        h("tr", null, h("td", null, s.kind === "store" ? "writes" : "reads"), h("td", { class: "mono" }, fmtBits(r.value, s.valType, s.size))))));
      detail.appendChild(h("div", { class: "row", style: { margin: "6px 0" } },
        h("button", { onclick: () => ctx.openMemory(r.ea) }, "Memory view"),
        h("button", { onclick: () => void ctx.addBookmark(r.ea, TYPE_NAME[s.valType] === "f32" ? "f32" : s.size === 8 ? "i64" : s.size === 2 ? "i16" : s.size === 1 ? "u8" : TYPE_NAME[s.valType] === "f64" ? "f64" : "i32") }, "＋ Cheat table"),
        h("button", { onclick: () => void rpc("watch.set", { addr: r.ea, size: [1, 2, 4, 8].includes(s.size) ? s.size : 4, flags: 2 }).then(() => toast("watching writes to this address — see Debugger", "ok")).catch((e) => toast(errMsg(e), "error")) }, "Find all writers")));
    }
    detail.appendChild(h("h3", null, "Call stack"));
    r.frames.forEach((f, i) => detail.appendChild(h("div", { class: "mono", style: { padding: "1px 0" } }, `${i}  `, link(f.name, () => ctx.openCode(f.fn, f.origOff ?? undefined)), h("span", { class: "muted" }, `  #${f.fn} +0x${(f.origOff ?? f.off).toString(16)}`))));
    if (r.locals.length) {
      detail.appendChild(h("h3", { style: { marginTop: "8px" } }, "Locals & params"));
      detail.appendChild(h("table", { class: "data" }, h("tbody", null, ...r.locals.map(([idx, bits]) => { const code = s.localCodes[idx] ?? 0; return h("tr", null, h("td", { class: "muted" }, `$${idx}`), h("td", { class: "muted" }, TYPE_NAME[code] ?? ""), h("td", { class: "mono" }, fmtBits(bits, code, 0))); }))));
    }
    if (s.kind !== "generic") {
      detail.appendChild(h("h3", { style: { marginTop: "8px" } }, "Heap around the address (now)"));
      const dump = h("div", { class: "mono", style: { fontSize: "11.5px", whiteSpace: "pre" } });
      detail.appendChild(dump);
      try {
        const base = Math.max(0, r.ea - (r.ea % 16) - 16);
        const bytes = fromHex((await rpc("read", { addr: base, len: 80 })).hex);
        for (let row = 0; row < 5; row++) {
          const line = h("div");
          line.appendChild(h("span", { class: "muted" }, hex(base + row * 16, 8) + "  "));
          for (let c = 0; c < 16; c++) {
            const a = base + row * 16 + c;
            const inside = a >= r.ea && a < r.ea + s.size;
            line.appendChild(h("span", { style: inside ? { background: "var(--accent2)", color: "#fff", borderRadius: "2px" } : {} }, bytes[row * 16 + c] === undefined ? "  " : hexByte(bytes[row * 16 + c]!)));
            line.appendChild(document.createTextNode(c === 7 ? "  " : " "));
          }
          dump.appendChild(line);
        }
      } catch (e) { dump.textContent = errMsg(e); }
    }
    hitTable.setRows(hitTable.rows);
  }

  async function refresh() {
    try {
      const f = opts.func?.();
      const r = await rpc("bp.poll", { func: f, limit: 150 }, undefined, true);
      sites = r.sites; hits = r.hits;
      bpTable.setRows(bps());
      hitTable.setRows(hits);
      const pending = ctx.data().lineBps.filter((b) => !siteOf(b));
      banner.style.display = pending.length ? "" : "none";
      banner.replaceChildren(`${pending.length} breakpoint(s) are compiled into the game when the page loads. `, h("button", { class: "primary", onclick: () => void reloadTarget() }, "Reload target tab"));
    } catch { /* target gone */ }
  }
  const poll = poller("pollDebugger", refresh);

  const el = h("div", { class: "stack fill", style: { gap: "6px", minHeight: "0" } },
    banner,
    h("div", { class: "table-wrap", style: { flex: "0 0 auto", maxHeight: "150px", minHeight: "70px" } }, bpTable.el),
    h("div", { class: "row" }, h("b", null, "Hits"), h("span", { class: "muted" }, "what the line did: address, old → new value, call stack, locals"), h("span", { class: "grow" }),
      h("button", { onclick: async () => { await rpc("bp.clear").catch(() => {}); sel = null; clear(detail); void refresh(); } }, "Clear hits")),
    h("div", { class: "cols" }, hitTable.el, detail));
  bpTable.el.style.border = "0";
  void refresh;

  return { el, start() { void refresh(); poll.start(); }, stop() { poll.stop(); }, refresh };
}
