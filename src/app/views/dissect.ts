/**
 * Struct Dissect: Cheat-Engine style structure viewer.
 *  - 4-byte aligned fields that hold a heap pointer expand inline (recursively) into nested structs
 *  - field types are guessed (ptr [vtable] / f32 / string / i32) and can be overridden per row
 *  - values are polled live, changed bytes are highlighted
 *  - extra instances become extra columns: equal values green, different values red
 *  - any row (also deeply nested) can be sent to the cheat table with its full pointer path
 *  - the layout can be exported as a C struct or a JS/TS offsets object
 */
import { h, hex, toast, errMsg, select, iconBtn, modal, copyText, clear, parseNum } from "../ui";
import { rpc, DissectSaved } from "../api";
import { Ctx } from "../ctx";
import { fromHex } from "../../wasm/leb";
import { readVal, fmtVal, ValType, TYPE_INFO } from "../../shared/codec";
import { parseAddressExpr, formatChain } from "../../shared/addrexpr";
import {
  Field, FieldType, FIELD_TYPES, Env, Block, Root, layoutBlock, retype, isHeapPtr, printableRun, buildPath, exportC, exportJs, ident,
} from "../../shared/dissect";

interface Inst { expr: string; root: Root | null; addr: number }
interface BState {
  key: string;
  /** offsets of the pointer fields followed from the root to get here */
  steps: number[];
  size: number;
  fields: Field[];
  /** per instance: resolved address (-1 = null / invalid) */
  addrs: number[];
  bytes: (Uint8Array | null)[];
  changedAt: Float64Array[];
  needLayout: boolean;
}

const hx = (n: number, w = 2) => "0x" + n.toString(16).padStart(w, "0");
const keyOf = (parent: string, off: number) => `${parent}>${off.toString(16)}`;

export function dissectPane(ctx: Ctx, openHex: (addr: number) => void) {
  const insts: Inst[] = [];
  let size = 0x80;
  const expanded = new Set<string>();
  const blocks = new Map<string, BState>();
  const userFields = new Map<string, Field[]>();
  let memBytes = 0;
  let vt: { lo: number; hi: number } | null = null;
  let probeMap = new Map<number, number>();
  let busy = false;
  let active = false;

  // ---------------------------------------------------------------- toolbar
  const baseIn = h("input", { type: "text", class: "mono", style: { width: "260px" }, placeholder: "0x14000  or  [0x4a2220]+0x10  or  [$g12]", title: "address or pointer path of the struct. Enter a STATIC root (cell or $gN) so paths sent to the cheat table survive restarts." });
  const sizeSel = select<string>([["0x40", "0x40 bytes"], ["0x80", "0x80 bytes"], ["0x100", "0x100 bytes"], ["0x200", "0x200 bytes"], ["0x400", "0x400 bytes"], ["0x800", "0x800 bytes"]], "0x80", (v) => { size = parseNum(v); for (const b of blocks.values()) { b.size = size; b.needLayout = true; } saveSession(); void refresh(); });
  const cmpIn = h("input", { type: "text", class: "mono", style: { width: "200px" }, placeholder: "compare with… (address / path)" });
  const live = h("input", { type: "checkbox", checked: true });
  const info = h("span", { class: "muted" });
  const head = h("tr");
  const body = h("tbody");
  const wrap = h("div", { class: "table-wrap fill" }, h("table", { class: "data dis" }, h("thead", null, head), body));

  const addInst = (expr: string) => {
    const e = expr.trim();
    if (!e) return;
    parseAddressExpr(e); // throws on bad syntax
    if (insts.length >= 8) throw new Error("at most 8 instances");
    insts.push({ expr: e, root: null, addr: -1 });
  };
  const dissectBtn = h("button", { class: "primary", onclick: () => { try { start(baseIn.value); } catch (e) { toast(errMsg(e), "error"); } } }, "Dissect");
  const cmpBtn = h("button", { onclick: () => {
    try {
      if (!insts.length) throw new Error("dissect a base address first");
      addInst(cmpIn.value); cmpIn.value = ""; for (const b of blocks.values()) { b.bytes.length = 0; b.addrs.length = 0; b.changedAt.length = 0; }
      saveSession(); void refresh();
    } catch (e) { toast(errMsg(e), "error"); }
  } }, "＋ Compare");
  baseIn.addEventListener("keydown", (e) => { if (e.key === "Enter") dissectBtn.click(); });
  cmpIn.addEventListener("keydown", (e) => { if (e.key === "Enter") cmpBtn.click(); });

  // ---------------------------------------------------------------- state
  function start(expr: string, keepExpanded = false) {
    insts.length = 0;
    addInst(expr);
    baseIn.value = expr.trim();
    blocks.clear();
    if (!keepExpanded) { expanded.clear(); userFields.clear(); }
    saveSession();
    void refresh(true);
  }

  const rootSpec = (): Root | null => insts[0]?.root ?? null;

  const restore = (s: DissectSaved) => {
    insts.length = 0;
    for (const e of s.exprs) { try { addInst(e); } catch { /* skip bad */ } }
    size = s.size || 0x80;
    sizeSel.value = "0x" + size.toString(16);
    expanded.clear(); for (const k of s.expanded) expanded.add(k);
    userFields.clear();
    for (const [k, fs] of Object.entries(s.fields)) userFields.set(k, fs.map((f) => ({ ...f, type: f.type as FieldType })));
    baseIn.value = insts[0]?.expr ?? "";
    blocks.clear();
  };
  function saveSession() {
    if (!insts.length) return;
    const fields: DissectSaved["fields"] = {};
    for (const [k, fs] of userFields) if (fs.length) fields[k] = fs.map((f) => ({ off: f.off, type: f.type, size: f.size, name: f.name, desc: f.desc, user: true }));
    ctx.data().dissect = { exprs: insts.map((i) => i.expr), size, expanded: [...expanded], fields };
    void ctx.saveData();
  }

  const blockOf = (key: string, steps: number[]): BState => {
    let b = blocks.get(key);
    if (!b) { b = { key, steps, size, fields: [], addrs: [], bytes: [], changedAt: [], needLayout: true }; blocks.set(key, b); }
    return b;
  };

  /** blocks that are visible right now (root + expanded pointers that exist in the layout), parents first */
  function visible(): BState[] {
    const out: BState[] = [];
    const walk = (b: BState) => {
      out.push(b);
      for (const f of b.fields) {
        if (f.type !== "ptr") continue;
        const k = keyOf(b.key, f.off);
        if (expanded.has(k)) walk(blockOf(k, [...b.steps, f.off]));
      }
    };
    if (!insts.length) return out;
    const r = blockOf("r", []);
    if (!r.fields.length) out.push(r); else walk(r);
    return out;
  }

  // ---------------------------------------------------------------- refresh
  async function resolveRoots() {
    const toPoll: { i: number; chain: Root & { kind: "ptr" } }[] = [];
    insts.forEach((inst, i) => {
      const r = parseAddressExpr(inst.expr);
      inst.root = r;
      if (r.kind === "addr") inst.addr = r.addr; else toPoll.push({ i, chain: r });
    });
    if (toPoll.length) {
      const res: { a: number }[] = await rpc("cheat.poll", { items: toPoll.map((t) => ({ ptr: t.chain.chain, type: "u32" })) }, undefined, true);
      toPoll.forEach((t, k) => { insts[t.i]!.addr = res[k]?.a ?? -1; });
    }
  }

  async function refresh(force = false) {
    if (busy || !insts.length || !ctx.target()) return;
    busy = true;
    try {
      await resolveRoots();
      // iterate: a block becomes visible only once its parent has a layout; at most `depth` passes
      for (let pass = 0; pass < 8; pass++) {
        const vis = visible();
        const items: { addr: number; steps: number[]; len: number; probe: boolean }[] = [];
        const refs: { b: BState; i: number }[] = [];
        for (const b of vis) insts.forEach((inst, i) => {
          items.push({ addr: inst.addr, steps: b.steps, len: b.size, probe: i === 0 && b.needLayout });
          refs.push({ b, i });
        });
        const r = await rpc("dissect.read", { items }, undefined, !force);
        memBytes = r.memBytes; vt = r.vtRange;
        const now = performance.now();
        let newBlocks = false;
        r.items.forEach((it: any, k: number) => {
          const { b, i } = refs[k]!;
          const nb = it.hex ? fromHex(it.hex) : null;
          const old = b.bytes[i] ?? null;
          if (nb && old && old.length === nb.length && b.addrs[i] === it.a) {
            const ch = b.changedAt[i] ?? (b.changedAt[i] = new Float64Array(nb.length));
            for (let x = 0; x < nb.length; x++) if (nb[x] !== old[x]) ch[x] = now;
          } else b.changedAt[i] = new Float64Array(nb?.length ?? 0);
          b.bytes[i] = nb; b.addrs[i] = it.a;
          if (i === 0 && it.vt) { const n32 = new DataView(nb!.buffer, nb!.byteOffset, nb!.byteLength); probeMap = new Map(); it.vt.forEach((first: number | null, w: number) => { if (first !== null) probeMap.set(n32.getUint32(w * 4, true), first); }); }
          if (i === 0 && b.needLayout && nb) {
            b.size = nb.length;
            b.fields = layoutBlock(nb, nb.length, env(), userFields.get(b.key) ?? []);
            b.needLayout = false;
            newBlocks = true;
          }
        });
        if (!newBlocks) break; // nothing new became visible
      }
      render();
    } catch (e) { if (force) toast(errMsg(e), "error"); }
    busy = false;
  }
  const env = (): Env => ({ memSize: memBytes, vt, readU32: (a) => probeMap.get(a) ?? null });

  // ---------------------------------------------------------------- value formatting / editing
  function fieldText(f: Field, bytes: Uint8Array): string {
    if (f.off + f.size > bytes.length) return "—";
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (f.type === "string") {
      let n = 0; while (n < f.size && bytes[f.off + n] !== 0) n++;
      return JSON.stringify(new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(f.off, f.off + n)));
    }
    if (f.type === "ptr") return hx(dv.getUint32(f.off, true), 8);
    const v = readVal(dv, f.off, f.type as ValType);
    if (f.type === "i32" || f.type === "u32") return `${fmtVal(f.type, v)}  (${hx(dv.getUint32(f.off, true), 8)})`;
    return fmtVal(f.type as ValType, v);
  }
  const rawSlice = (f: Field, bytes: Uint8Array | null): string | null => (bytes && f.off + f.size <= bytes.length ? Array.from(bytes.subarray(f.off, f.off + f.size)).join(",") : null);

  async function writeField(b: BState, f: Field, i: number, text: string) {
    const a = b.addrs[i]!;
    if (a < 0) return;
    if (f.type === "string") await rpc("writeStr", { addr: a + f.off, text, enc: "utf8", cap: f.size });
    else await rpc("write", { addr: a + f.off, type: f.type === "ptr" ? "u32" : f.type, value: text.trim() });
    void refresh(true);
  }
  function editValue(td: HTMLElement, b: BState, f: Field, i: number) {
    const bytes = b.bytes[i];
    if (!bytes) return;
    const cur = fieldText(f, bytes);
    const inp = h("input", { type: "text", class: "mono", value: f.type === "string" ? (JSON.parse(cur) as string) : cur.split(" ")[0]!, style: { width: "100%" } });
    td.replaceChildren(inp);
    inp.focus(); inp.select();
    let done = false;
    const fin = (save: boolean) => { if (done) return; done = true; if (save) void writeField(b, f, i, inp.value).catch((e) => toast(errMsg(e), "error")); else render(); };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") fin(true); else if (e.key === "Escape") fin(false); e.stopPropagation(); });
    inp.addEventListener("blur", () => fin(false));
  }

  // ---------------------------------------------------------------- cheat table
  function sendToCheat(b: BState, f: Field) {
    const root = rootSpec();
    if (!root) return;
    const p = buildPath(root, [...b.steps, f.off]);
    const type = f.type === "ptr" ? "u32" : f.type === "string" ? "str8" : f.type;
    const desc = f.name === "field_" + f.off.toString(16).padStart(2, "0") ? `${insts[0]!.expr} +${hx(f.off)}` : f.name;
    if (p.kind === "addr") void ctx.addBookmark(p.addr, type, desc);
    else void ctx.addPathBookmark(p.chain, type, desc, f.type === "string" ? f.size : undefined);
  }

  // ---------------------------------------------------------------- render
  function render() {
    // do not tear the table down while the user is typing in it
    const ae = document.activeElement;
    if (ae && ae instanceof HTMLInputElement && body.contains(ae)) return;
    clear(head); clear(body);
    head.append(h("th", { style: { width: "110px" } }, "offset"), h("th", { style: { width: "150px" } }, "name"), h("th", { style: { width: "80px" } }, "type"));
    insts.forEach((inst, i) => head.append(h("th", { title: inst.expr }, i === 0 ? `value @ ${hex(inst.addr)}` : `${inst.expr} @ ${inst.addr >= 0 ? hex(inst.addr) : "—"} `, i > 0 ? iconBtn("×", "remove this instance", () => { insts.splice(i, 1); for (const b of blocks.values()) { b.bytes.length = 0; b.addrs.length = 0; b.changedAt.length = 0; } saveSession(); void refresh(true); }) : "")));
    head.append(h("th", null, "description"), h("th", { style: { width: "90px" } }, ""));
    const vis = visible();
    if (!insts.length) { body.appendChild(h("tr", null, h("td", { colspan: 6, class: "muted" }, "Enter an address or pointer path above and press Dissect. Pointer fields can be expanded with ＋."))); info.textContent = ""; return; }
    const root = blocks.get("r");
    if (!root || !root.fields.length) {
      body.appendChild(h("tr", { class: "invalid" }, h("td", { colspan: 6 }, insts[0]!.addr < 0 ? "root does not resolve right now" : "reading…")));
      return;
    }
    const now = performance.now();
    const rows: HTMLElement[] = [];
    const emit = (b: BState, depth: number) => {
      if (b.addrs[0]! < 0) { rows.push(h("tr", { class: "invalid" }, h("td", { colspan: 5 + insts.length - 1, style: { paddingLeft: depth * 18 + 8 + "px" } }, "null or invalid pointer"))); return; }
      for (const f of b.fields) {
        const k = keyOf(b.key, f.off);
        const canExpand = f.type === "ptr" && insts.some((_, i) => { const by = b.bytes[i]; return by && f.off + 4 <= by.length && isHeapPtr(new DataView(by.buffer, by.byteOffset).getUint32(f.off, true), memBytes); });
        const exp = canExpand
          ? h("span", { class: "exp", title: expanded.has(k) ? "collapse" : "expand the struct this pointer points to", onclick: () => { if (expanded.has(k)) expanded.delete(k); else expanded.add(k); saveSession(); render(); void refresh(true); } }, expanded.has(k) ? "−" : "＋")
          : h("span", { class: "exp" }, "");
        const nm = h("input", { type: "text", class: "nm", value: f.name, spellcheck: false, title: "rename" });
        nm.addEventListener("change", () => setUser(b, f, { name: nm.value.trim() || f.name }));
        const ty = select<string>(FIELD_TYPES.map((t) => [t, t] as [string, string]), f.type, (v) => changeType(b, f, v as FieldType));
        const tds: HTMLElement[] = [];
        const raws = insts.map((_, i) => rawSlice(f, b.bytes[i] ?? null));
        const comparable = insts.length > 1 && raws.every((r) => r !== null);
        const allEq = comparable && raws.every((r) => r === raws[0]);
        insts.forEach((_, i) => {
          const by = b.bytes[i];
          let cls = "val mono";
          if (by) { const ch = b.changedAt[i]; for (let x = f.off; x < f.off + f.size && ch; x++) if (now - (ch[x] ?? 0) < 1500 && (ch[x] ?? 0) > 0) { cls += " chg"; break; } }
          if (comparable) cls += allEq ? " cmp-eq" : f.type === "ptr" ? "" : " cmp-ne"; // heap addresses naturally differ between instances
          const td = h("td", { class: cls, title: "double-click to edit" }, by ? fieldText(f, by) : "—");
          if (i === 0 && f.vtable) td.appendChild(h("span", { class: "vt", title: "[value] points into static .rodata/.data" }, "vtable"));
          td.addEventListener("dblclick", () => editValue(td, b, f, i));
          tds.push(td);
        });
        const desc = h("input", { type: "text", class: "nm", value: f.desc, placeholder: "…", spellcheck: false });
        desc.addEventListener("change", () => setUser(b, f, { desc: desc.value }));
        const addr0 = b.addrs[0]! + f.off;
        rows.push(h("tr", null,
          h("td", { class: "mono", style: { paddingLeft: depth * 18 + 4 + "px" }, title: `${hex(addr0)}  ·  path ${pathText(b, f)}` }, exp, "+" + hx(f.off)),
          h("td", { class: "name" }, nm), h("td", null, ty), ...tds, h("td", null, desc),
          h("td", null, iconBtn("→", "show in hex view", () => openHex(addr0)), iconBtn("☰", "Send to Cheat Table (full pointer path)", () => sendToCheat(b, f)))));
        if (expanded.has(k) && canExpand) { const c = blocks.get(k); if (c && c.fields.length) emit(c, depth + 1); else rows.push(h("tr", { class: "invalid" }, h("td", { colspan: 5 + insts.length - 1, style: { paddingLeft: (depth + 1) * 18 + 8 + "px" } }, "reading…"))); }
      }
    };
    emit(root, 0);
    body.append(...rows);
    info.textContent = `${vis.length} struct block(s) · ${insts.length} instance(s) · memory ${memBytes.toLocaleString()} B · vtable range ${vt ? hex(vt.lo) + "–" + hex(vt.hi) : "unknown"}`;
  }

  function pathText(b: BState, f: Field): string {
    const root = rootSpec();
    if (!root) return "";
    const p = buildPath(root, [...b.steps, f.off]);
    return p.kind === "addr" ? hex(p.addr) : formatChain(p.chain);
  }

  function setUser(b: BState, f: Field, patch: Partial<Field>) {
    Object.assign(f, patch, { user: true });
    userFields.set(b.key, b.fields.filter((x) => x.user).map((x) => ({ ...x })));
    saveSession();
  }
  function changeType(b: BState, f: Field, t: FieldType) {
    const by = b.bytes[0];
    if (!by) return;
    const strLen = Math.max(4, printableRun(by, f.off, 64) + 1, f.type === "string" ? f.size : 16);
    b.fields = retype(b.fields, f.off, t, by, by.length, env(), strLen);
    userFields.set(b.key, b.fields.filter((x) => x.user).map((x) => ({ ...x })));
    // children below a field that is no longer a pointer disappear
    if (t !== "ptr") for (const k of [...expanded]) if (k === keyOf(b.key, f.off) || k.startsWith(keyOf(b.key, f.off) + ">")) expanded.delete(k);
    saveSession(); render(); void refresh(true);
  }

  // ---------------------------------------------------------------- export
  function toBlock(b: BState, name: string): Block {
    const children = new Map<number, Block>();
    for (const f of b.fields) {
      const c = blocks.get(keyOf(b.key, f.off));
      if (f.type === "ptr" && expanded.has(keyOf(b.key, f.off)) && c && c.fields.length) children.set(f.off, toBlock(c, "Child_" + ident(f.name, "field_" + f.off.toString(16))));
    }
    return { name, size: b.size, fields: b.fields, children };
  }
  function openExport() {
    const r = blocks.get("r");
    if (!r || !r.fields.length) return toast("dissect something first", "info");
    const name = "Struct_" + (insts[0]!.addr >= 0 ? insts[0]!.addr.toString(16) : "root");
    const tree = toBlock(r, name);
    const out = h("textarea", { class: "mono", readOnly: true, style: { width: "720px", height: "380px" }, spellcheck: false });
    const set = (kind: "c" | "js") => { out.value = kind === "c" ? exportC(tree) : exportJs(tree); };
    set("c");
    const kind = select<string>([["c", "C struct"], ["js", "JS / TS offsets object"]], "c", (v) => set(v as "c" | "js"));
    modal("Export dissected layout", h("div", { class: "stack" }, h("div", { class: "row" }, kind), out), [
      { label: "Copy", primary: true, onClick: () => { void copyText(out.value); toast("copied", "ok", 900); return false; } },
      { label: "Close", onClick: () => {} },
    ]);
  }

  const reguess = h("button", { title: "forget guessed types and guess again (renamed / retyped fields are kept)", onclick: () => { for (const b of blocks.values()) b.needLayout = true; void refresh(true); } }, "Re-guess types");
  const el = h("div", { class: "stack fill", style: { display: "none" } },
    h("div", { class: "row" }, baseIn, dissectBtn, sizeSel, h("label", { class: "chk" }, live, "live"), reguess, h("button", { onclick: openExport }, "Export…")),
    h("div", { class: "row" }, cmpIn, cmpBtn, info),
    wrap);

  return {
    el,
    /** dissect an address (from the hex view, a cheat-table row, …) */
    open(addr: number) { start(hex(addr)); },
    onShow() {
      active = true;
      const s = ctx.data().dissect;
      if (!insts.length && s) { restore(s); void refresh(true); } else { render(); void refresh(true); }
    },
    onHide() { active = false; },
    isActive: () => active,
    /** called by the Memory view's poller */
    async tick() { if (live.checked) await refresh(false); },
    reset() { insts.length = 0; blocks.clear(); expanded.clear(); userFields.clear(); render(); },
  };
}
