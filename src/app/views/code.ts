import { h, hex, toast, errMsg, link, iconBtn, promptText, copyText, modal, field, download, clear } from "../ui";
import { rpc, loadPatches, savePatches, pageKey, reloadTarget, SavedPatch } from "../api";
import { lineBpPanel } from "./linebp";
import { decompPane } from "./decompile";
import { Ctx, View } from "../ctx";
import { assemble } from "../../wasm/text";
import { formatListing, ListLine } from "../../shared/listing";
import { hex as hexStr } from "../../wasm/leb";

interface Line { off: number; indent: number; text: string; comment: string; target?: number; bytes: string }
interface Dis { index: number; name: string; imported: boolean; sig: string; size?: number; locals: string[]; error: string | null; patched?: boolean; lines: Line[]; text: string; import?: string }

const CTL = /^(br|br_if|br_table|call|call_indirect|return|return_call|if|else|loop|block|end|unreachable|try|catch|throw)/;
const MEM = /\.(load|store)|memory\.|atomic/;

export function codeView(ctx: Ctx): View {
  let cur: Dis | null = null;
  let history: number[] = [];
  let hpos = -1;
  let editing = false;
  let reopen: number | undefined; // the function that was open when the target changed (page reload)
  const title = h("div", { class: "grow" });
  const input = h("input", { type: "text", class: "mono", placeholder: "function # or name", style: { width: "220px" } });
  const listing = h("div", { class: "listing" });
  const withBytes = h("input", { type: "checkbox", checked: true });
  const header = () => (cur ? `${cur.name}  #${cur.index}  ${cur.sig}${cur.locals.length ? "\n.locals " + cur.locals.join(" ") : ""}` : "");
  /** whole function, or only `rows` (the selection) */
  const copyShown = (rows?: ListLine[]) => {
    if (!cur || cur.imported) return;
    const lines = rows ?? (cur.lines as ListLine[]);
    void copyText(formatListing(lines, { bytes: withBytes.checked, ...(rows ? {} : { header: header() }) }));
    toast(rows ? `copied ${rows.length} lines` : "copied", "ok", 1000);
  };
  // Ctrl+C over several rows: copy them as lines, not as one fragment per span (the cells are flex items, which
  // browsers copy as separate lines: offset / bytes / instruction / hint each on their own)
  listing.addEventListener("copy", (e) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const picked: ListLine[] = [];
    for (const r of listing.querySelectorAll<HTMLElement>(".lrow[data-off]")) if (sel.containsNode(r, true)) { const l = rowLine.get(r); if (l) picked.push(l); }
    if (picked.length < 2) return; // a partial selection inside one row: keep the default behaviour
    e.preventDefault();
    e.clipboardData?.setData("text/plain", formatListing(picked, { bytes: withBytes.checked }));
  });
  /** highlight the disassembly row of an instruction (selection coming from the pseudocode / IR, or a click here) */
  const markRow = (off: number | null, scroll = false) => {
    listing.querySelectorAll(".lrow.hl2").forEach((r) => r.classList.remove("hl2"));
    if (off === null) return;
    const r = listing.querySelector<HTMLElement>(`.lrow[data-off="${off}"]`);
    if (r) { r.classList.add("hl2"); if (scroll) r.scrollIntoView({ block: "center" }); }
  };
  const dc = decompPane(ctx, {
    onSelect: (off) => markRow(off, true),
    reopen: (f) => void open(f),
    refreshListing: () => { if (cur) void open(cur.index, undefined, false); },
    onRender: () => { /* the annotation database may have changed: refresh instruction comments of the listing */
      listing.querySelectorAll<HTMLElement>(".lrow[data-off]").forEach((r) => {
        r.querySelector(".cmt.user")?.remove();
        const t = dc.insComment(Number(r.dataset.off));
        if (t) r.appendChild(h("span", { class: "cmt user", title: "your comment" }, "// " + t));
      });
    },
  });
  let decompOn = false;
  const decompBtn = h("button", { title: "pseudocode, IR and symbol table of this function, synchronized with the disassembly" }, "Decompile");
  decompBtn.onclick = () => { decompOn = !decompOn; decompBtn.classList.toggle("active", decompOn); dc.el.style.display = decompOn ? "flex" : "none"; if (decompOn && cur && !cur.imported) void dc.load(cur.index, true); };
  const editor = h("textarea", { class: "editor", spellcheck: false, style: { display: "none" } });
  const callers = h("div", { class: "scroll", style: { maxHeight: "40%" } });
  const callees = h("div", { class: "scroll", style: { maxHeight: "40%" } });
  const msg = h("div", { style: { display: "none" } });
  const editBtn = h("button", null, "✎ Edit");
  const validateBtn = h("button", { style: { display: "none" } }, "Validate");
  const saveBtn = h("button", { class: "primary", style: { display: "none" } }, "Save as patch…");
  const cancelBtn = h("button", { style: { display: "none" } }, "Cancel edit");

  async function open(idx: number, off?: number, push = true) {
    try {
      const d: Dis = await rpc("mod.disasm", { index: idx });
      if (push) { history = history.slice(0, hpos + 1); history.push(idx); hpos = history.length - 1; }
      cur = d;
      setEdit(false);
      render(off);
      void loadXrefs(idx);
      void dc.load(idx); // also loads the project annotations, so instruction comments show up in the listing
    } catch (e) { toast(errMsg(e), "error"); }
  }

  function render(hl?: number) {
    if (!cur) return;
    const d = cur;
    title.replaceChildren(h("b", null, d.name), h("span", { class: "muted" }, `  #${d.index}  ${d.sig}  ${d.imported ? "· imported " + (d.import ?? "") : `· ${d.size} bytes`}`), d.patched ? h("span", { class: "badge warn", style: { marginLeft: "8px" } }, "patched") : "");
    clear(listing);
    if (d.imported) { listing.appendChild(h("div", { class: "empty" }, "Imported from the host environment — no wasm body.")); return; }
    if (d.locals.length) listing.appendChild(h("div", { class: "lrow" }, h("span", { class: "off" }), h("span", { class: "byt" }), h("span", { class: "ins muted" }, ".locals " + d.locals.map((t, i) => `${d.sig.split("(")[1]!.split(")")[0]!.split(",").filter(Boolean).length + i}:${t}`).join("  "))));
    let hlEl: HTMLElement | null = null;
    dots.clear();
    const frag = document.createDocumentFragment();
    for (const l of d.lines) {
      const mn = l.text.split(" ")[0]!;
      const rest = l.text.slice(mn.length);
      const cls = "lrow " + (CTL.test(mn) ? "ctl " : MEM.test(mn) ? "mem " : "") + (hl !== undefined && hl === l.off ? "hl" : "");
      const insEl = h("span", { class: "ins" }, "  ".repeat(l.indent), h("span", { class: "mn" }, mn), rest);
      const dot = h("span", { class: "bpdot", title: "click: toggle a line breakpoint on this instruction (captures address, value, stack, locals)" });
      dot.addEventListener("click", (e) => { e.stopPropagation(); void toggleBp(l.off, l.text); });
      dots.set(l.off, dot);
      const row = h("div", { class: cls, dataset: { off: String(l.off) } },
        dot, h("span", { class: "off" }, "+" + l.off.toString(16).padStart(4, "0")), h("span", { class: "byt", title: l.bytes }, l.bytes), insEl,
        l.target !== undefined ? h("span", { class: "cmt" }, "→ ", link(l.comment || `func ${l.target}`, () => void open(l.target!), `go to function ${l.target}`)) : l.comment ? h("span", { class: "cmt" }, l.comment) : "");
      rowLine.set(row, l);
      const uc = dc.insComment(l.off);
      if (uc) row.appendChild(h("span", { class: "cmt user", title: "your comment" }, "// " + uc));
      row.addEventListener("click", () => { markRow(l.off); dc.select(l.off, "dis"); });
      row.addEventListener("dblclick", () => { const m = /i32\.const (-?\d+)/.exec(l.text); if (m) ctx.openMemory(Number(m[1]) >>> 0); });
      if (hl === l.off) hlEl = row;
      frag.appendChild(row);
    }
    listing.appendChild(frag);
    paintDots();
    hlEl?.scrollIntoView({ block: "center" });
    if (d.error) listing.appendChild(h("div", { class: "banner err" }, "Decode stopped: " + d.error));
  }

  // ---- line breakpoints (gutter) ---------------------------------------------------------
  const dots = new Map<number, HTMLElement>();
  const rowLine = new WeakMap<HTMLElement, ListLine>();
  const paintDots = () => {
    const mine = ctx.data().lineBps.filter((b) => cur && b.func === cur.index);
    for (const [off, dot] of dots) {
      const b = mine.find((x) => x.off === off);
      dot.textContent = b ? "●" : "";
      dot.className = "bpdot" + (b ? (b.enabled ? " on" : " off") : "");
    }
  };
  async function toggleBp(off: number, text: string) {
    if (!cur || cur.imported) return;
    if (cur.patched) return void toast("this function is patched — line breakpoints work on original code only", "error");
    const d = ctx.data();
    const i = d.lineBps.findIndex((b) => b.func === cur!.index && b.off === off);
    if (i >= 0) {
      const b = d.lineBps[i]!;
      d.lineBps.splice(i, 1);
      void rpc("bp.config", { func: b.func, off: b.off, enabled: false }).catch(() => {});
    } else {
      d.lineBps.push({ func: cur.index, off, enabled: true, text });
      toast("Line breakpoint set. It is compiled into the game on the next page load — reload the target tab.", "ok", 4500);
    }
    await ctx.saveData();
    paintDots();
    void bpPanel.refresh();
  }
  const bpPanel = lineBpPanel(ctx, { func: () => cur?.index, onChange: () => paintDots() });

  async function loadXrefs(idx: number) {
    try {
      const x = await rpc("mod.xrefs", { kind: "func", value: idx });
      const list = (items: any[]) => items.length ? items.slice(0, 300).map((c) => h("div", null, link(`${c.name}`, () => void open(c.index)), h("span", { class: "muted" }, ` #${c.index}`))) : [h("div", { class: "muted" }, "none")];
      callers.replaceChildren(h("h3", null, `Callers (${x.callers.length})${x.indirectTarget ? " · address-taken" : ""}`), ...list(x.callers));
      callees.replaceChildren(h("h3", null, `Calls (${x.callees.length})`), ...list(x.callees));
    } catch { /* ignore */ }
  }

  function setEdit(on: boolean) {
    editing = on;
    editor.style.display = on ? "" : "none";
    listing.style.display = on ? "none" : "";
    editBtn.style.display = on ? "none" : "";
    validateBtn.style.display = saveBtn.style.display = cancelBtn.style.display = on ? "" : "none";
    if (on && cur) editor.value = cur.text;
    if (!on) { msg.style.display = "none"; }
  }
  const showMsg = (text: string, cls: string) => { msg.className = "banner " + cls; msg.textContent = text; msg.style.display = ""; };

  async function assembleNow() {
    const a = assemble(editor.value);
    return { code: hexStr(a.code), locals: a.locals ? hexStr(a.locals) : undefined };
  }
  validateBtn.onclick = async () => {
    try {
      const a = await assembleNow();
      const r = await rpc("mod.validatePatch", { index: cur!.index, code: a.code, locals: a.locals });
      if (r.ok) showMsg(`Valid. ${a.code.length / 2} instruction bytes.`, "info"); else showMsg("Rejected by the wasm validator: " + r.error, "err");
    } catch (e) { showMsg(errMsg(e), "err"); }
  };
  saveBtn.onclick = async () => {
    try {
      const a = await assembleNow();
      const r = await rpc("mod.validatePatch", { index: cur!.index, code: a.code, locals: a.locals });
      if (!r.ok) return showMsg("Rejected by the wasm validator: " + r.error, "err");
      const name = await promptText("Save patch", "Patch name", `${cur!.name} patch`);
      if (!name) return;
      const patches = await loadPatches();
      const url = pageKey(ctx.target());
      patches.push({ name, url, enabled: true, created: Date.now(), functionPatches: [{ index: cur!.index, code: a.code, ...(a.locals ? { locals: a.locals } : {}) }] });
      await savePatches(patches);
      setEdit(false);
      showMsg(`Patch “${name}” saved and enabled. It is applied when the page loads — reload the target tab.`, "");
      msg.appendChild(h("button", { style: { marginLeft: "10px" }, onclick: () => void reloadTarget() }, "Reload target tab"));
    } catch (e) { showMsg(errMsg(e), "err"); }
  };
  editBtn.onclick = () => cur && !cur.imported && setEdit(true);
  cancelBtn.onclick = () => setEdit(false);
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab") { e.preventDefault(); const s = editor.selectionStart; editor.setRangeText("  ", s, editor.selectionEnd, "end"); }
  });

  const resolve = async () => {
    const t = input.value.trim();
    if (!t) return;
    if (/^(0x[0-9a-f]+|\d+)$/i.test(t)) return void open(Number(t));
    try {
      const r = await rpc("mod.funcs", { filter: { mode: "contains", text: t }, offset: 0, limit: 20 });
      if (!r.rows.length) return toast("no function matches", "info");
      const exact = r.rows.find((x: any) => x.name === t) ?? r.rows[0];
      void open(exact.index);
    } catch (e) { toast(errMsg(e), "error"); }
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") void resolve(); });

  // ------------------------------------------------------------ patches ----
  const managePatches = async () => {
    const url = pageKey(ctx.target());
    const body = h("div", { class: "stack", style: { minWidth: "560px" } });
    const draw = async () => {
      const all = await loadPatches();
      clear(body);
      const mine = all.map((p, i) => ({ p, i })).filter((x) => x.p.url === url);
      if (!mine.length) body.appendChild(h("div", { class: "muted" }, `No patches saved for ${url}`));
      for (const { p, i } of mine) {
        const en = h("input", { type: "checkbox", checked: p.enabled });
        en.onchange = async () => { all[i]!.enabled = en.checked; await savePatches(all); };
        body.appendChild(h("div", { class: "row panel" }, en, h("b", { class: "grow" }, p.name), h("span", { class: "muted" }, p.functionPatches.map((f) => "#" + f.index).join(", ")),
          iconBtn("⤓", "export", () => download(`${p.name}.cetus-patch.json`, JSON.stringify(p, null, 1), "application/json")),
          iconBtn("✕", "delete", async () => { all.splice(i, 1); await savePatches(all); void draw(); }, "danger")));
      }
    };
    void draw();
    const imp = h("input", { type: "file", accept: ".json", style: { display: "none" } });
    imp.onchange = async () => {
      try {
        const p = JSON.parse(await imp.files![0]!.text()) as SavedPatch;
        if (!Array.isArray(p.functionPatches)) throw new Error("not a Cetus patch file");
        const all = await loadPatches(); all.push({ ...p, url, enabled: true }); await savePatches(all); void draw();
      } catch (e) { toast(errMsg(e), "error"); }
    };
    modal("Patches for this page", h("div", null, body, imp), [{ label: "Import…", onClick: () => { imp.click(); return false; } }, { label: "Reload target tab", onClick: () => void reloadTarget() }, { label: "Close", primary: true, onClick: () => {} }]);
  };

  const nav = (d: number) => { const n = hpos + d; if (n >= 0 && n < history.length) { hpos = n; void open(history[n]!, undefined, false); } };
  const el = h("div", { class: "view" },
    h("div", { class: "row" }, iconBtn("◀", "back", () => nav(-1)), iconBtn("▶", "forward", () => nav(1)), input, h("button", { onclick: () => void resolve() }, "Go"), title,
      decompBtn, editBtn, validateBtn, saveBtn, cancelBtn,
      iconBtn("●", "breakpoint on entry", async () => { if (!cur) return; try { await rpc("fbp.set", { index: cur.index }); toast("breakpoint set — see Debugger", "ok"); } catch (e) { toast(errMsg(e), "error"); } }),
      iconBtn("✎", "rename", async () => { if (!cur) return; const n = await promptText("Rename", "Function name", cur.name); if (n === null) return; await rpc("mod.rename", { index: cur.index, name: n }); const dd = ctx.data(); if (n) dd.names[cur.index] = n; else delete dd.names[cur.index]; await ctx.saveData(); await dc.renameFunc(cur.index, n); void open(cur.index, undefined, false); }),
      iconBtn("⎘", "copy disassembly as assembler text (with hints as ;; comments; can be pasted back into the editor)", () => cur && void copyText(cur.text)),
      h("button", { title: "copy the code exactly as shown: one line per instruction — offset, bytes, instruction, hint — aligned", onclick: () => copyShown() }, "Copy code"),
      h("label", { class: "chk", title: "include the bytes column in \"Copy code\"" }, withBytes, "bytes"), iconBtn("⛁", "copy body hex", async () => { if (!cur) return; const r = await rpc("mod.funcHex", { index: cur.index }); void copyText(r.hex); }),
      h("button", { onclick: () => void managePatches() }, "Patches…")),
    msg,
    h("div", { class: "cols", style: { flex: "1 1 55%" } }, h("div", { class: "fill" }, listing, editor), dc.el, h("div", { class: "stack", style: { width: "260px", flex: "none" } }, h("div", { class: "panel", style: { overflow: "auto" } }, callers), h("div", { class: "panel", style: { overflow: "auto" } }, callees))),
    h("div", { class: "panel fill", style: { flex: "1 1 45%", minHeight: "190px" } }, h("h3", null, "Line breakpoints of this function"), bpPanel.el));
  void field; void hex;

  return {
    el,
    show(p) { bpPanel.start(); if (p?.func !== undefined) void open(p.func, p.off); else if (reopen !== undefined && !cur) { const f = reopen; reopen = undefined; void open(f); } else if (!cur) listing.appendChild(h("div", { class: "empty" }, "Pick a function from the Functions view or type an index / name above.")); },
    hide() { bpPanel.stop(); },
    retarget() { dc.clear(); if (cur) reopen = cur.index; cur = null; history = []; hpos = -1; clear(listing); title.textContent = ""; setEdit(false); },
  };
}
