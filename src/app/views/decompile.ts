/**
 * Decompile pane of the Code view: pseudocode, IR and the project symbol table, all built from ONE IR and the
 * module-level annotation database. Selecting an instruction (or any expression / line) in any view highlights the
 * matching instruction or expression in the others via the WASM offsets every node carries.
 */
import { h, toast, errMsg, modal, copyText, download, iconBtn, select, clear, debounce } from "../ui";
import { rpc, loadAnnotations, saveAnnotations } from "../api";
import { Ctx } from "../ctx";
import { FuncIR } from "../../decomp/ir";
import { renderPseudo, renderIR, toText, Doc, Line, Seg, SymRef, Conf, PseudoResult } from "../../decomp/render";
import { Annotations } from "../../decomp/annotations";

type Mode = "pseudo" | "ir" | "symbols";

export function decompPane(ctx: Ctx, hooks: { onSelect: (off: number | null) => void; reopen: (func: number, off?: number) => void; refreshListing: () => void; onRender: () => void }) {
  let ir: FuncIR | null = null;
  let ann: Annotations | null = null;
  let moduleId = "";
  let mode: Mode = "pseudo";
  let selOff: number | null = null;
  let busy = false;
  let loadedFor = -1;

  const status = h("span", { class: "muted" });
  const view = h("div", { class: "dc-view mono" });
  const tabs = new Map<Mode, HTMLButtonElement>();
  const mkTab = (m: Mode, label: string, title: string) => { const b = h("button", { title, onclick: () => { mode = m; paintTabs(); render(); } }, label); tabs.set(m, b); return b; };
  const paintTabs = () => tabs.forEach((b, m) => b.classList.toggle("active", m === mode));

  // ------------------------------------------------------------------------------------------ database
  async function ensureAnn(id: string): Promise<void> {
    if (ann && moduleId === id) return;
    moduleId = id;
    ann = Annotations.fromJSON(await loadAnnotations(id), id);
    // names given before this database existed (per-page rename) become project-level, as inferred
    const legacy = ctx.data().names ?? {};
    for (const [k, v] of Object.entries(legacy)) if (v && !ann.db.funcs[k]?.name) ann.setFuncName(Number(k), v, "inferred");
    void pushNames();
    const save = debounce(() => { if (ann) void saveAnnotations(ann.db); }, 400);
    ann.onChange(() => { save(); render(); void pushNames().then((changed) => { if (changed) hooks.refreshListing(); }); });
  }
  /** other views (Functions, traces, Debugger) show the same names */
  let lastNames = "";
  async function pushNames(): Promise<boolean> {
    if (!ann) return false;
    const names: Record<string, string> = {};
    for (const [k, f] of Object.entries(ann.db.funcs)) if (f.name) names[k] = f.name;
    const sig = JSON.stringify(names);
    if (sig === lastNames) return false;
    // names that were removed must be removed in the page too
    const gone = Object.keys(JSON.parse(lastNames || "{}")).filter((k) => !(k in names));
    lastNames = sig;
    for (const k of gone) await rpc("mod.rename", { index: Number(k), name: "" }, undefined, true).catch(() => {});
    await rpc("mod.names", { names }, undefined, true).catch(() => {});
    return true;
  }

  async function load(idx: number, force = false): Promise<void> {
    if (busy) return;
    if (!force && loadedFor === idx && ir) return render();
    busy = true;
    try {
      const r = await rpc("decomp.ir", { index: idx }, undefined, true);
      await ensureAnn(r.moduleId);
      ir = r.ir as FuncIR; loadedFor = idx;
      render();
    } catch (e) {
      ir = null; loadedFor = -1;
      view.replaceChildren(h("div", { class: "empty" }, /no body/.test(errMsg(e)) ? "Imported from the host environment — no wasm body to decompile." : "Cannot decompile: " + errMsg(e)));
    }
    busy = false;
  }

  // ------------------------------------------------------------------------------------------ rendering
  let docs: { pseudo: PseudoResult; ir: Doc } | null = null;
  const confTitle = (s: Seg): string => (s.conf === "inferred" ? "inferred name (a guess / entered by the user, not verified). Double-click to edit." : s.conf === "confirmed" ? "confirmed name. Double-click to edit." : "double-click to annotate");

  function lineEl(l: Line): HTMLElement {
    const row = h("div", { class: "dl " + (l.kind ?? "code"), dataset: { offs: l.offs.join(",") } });
    row.style.paddingLeft = 8 + l.indent * 18 + "px";
    if (!l.segs.length) row.appendChild(h("span", null, "\u00a0"));
    for (const s of l.segs) {
      const sp = h("span", { class: s.cls ?? "" }, s.t);
      if (s.off !== undefined) sp.dataset.off = String(s.off);
      if (s.ref) { sp.dataset.ref = JSON.stringify(s.ref); sp.title = confTitle(s); sp.classList.add("ref"); if (s.conf === "inferred") sp.classList.add("sym-inferred"); }
      row.appendChild(sp);
    }
    return row;
  }
  function paintDoc(doc: Doc): void {
    const frag = document.createDocumentFragment();
    for (const l of doc.lines) frag.appendChild(lineEl(l));
    view.replaceChildren(frag);
    applySel();
  }
  function render(): void {
    if (!ir || !ann) return;
    docs = { pseudo: renderPseudo(ir, ann), ir: renderIR(ir, ann) };
    hooks.onRender();
    if (mode === "symbols") return paintSymbols();
    paintDoc(mode === "pseudo" ? docs.pseudo : docs.ir);
    const w = docs.pseudo.warnings;
    status.textContent = `module ${moduleId.slice(0, 13)}…  ·  ${ann.symbols().length} named symbol(s) in this project` + (w.length ? `  ·  ⚠ ${w[0]}` : "");
  }

  function applySel(): void {
    view.querySelectorAll(".osel").forEach((e) => e.classList.remove("osel"));
    view.querySelectorAll(".lsel").forEach((e) => e.classList.remove("lsel"));
    if (selOff === null) return;
    let first: HTMLElement | null = null;
    for (const sp of view.querySelectorAll<HTMLElement>(`[data-off="${selOff}"]`)) sp.classList.add("osel");
    for (const row of view.querySelectorAll<HTMLElement>(".dl[data-offs]")) {
      if ((row.dataset.offs ?? "").split(",").includes(String(selOff))) { row.classList.add("lsel"); first ??= row; }
    }
    first?.scrollIntoView({ block: "nearest" });
  }
  /** called by the disassembly (or another view): `from` avoids echoing the selection back */
  function selectOff(off: number | null, from: "dis" | "self" = "dis"): void {
    selOff = off;
    applySel();
    if (from === "self") hooks.onSelect(off);
  }

  view.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const sp = t.closest<HTMLElement>("[data-off]");
    const row = t.closest<HTMLElement>(".dl");
    let off: number | null = null;
    if (sp) off = Number(sp.dataset.off);
    else if (row && row.dataset.offs) off = Number(row.dataset.offs.split(",")[0]);
    if (off !== null && !Number.isNaN(off)) selectOff(off, "self");
  });
  view.addEventListener("dblclick", (e) => {
    const sp = (e.target as HTMLElement).closest<HTMLElement>("[data-ref]");
    if (!sp?.dataset.ref) return;
    void annotate(JSON.parse(sp.dataset.ref) as SymRef, sp.dataset.off !== undefined ? Number(sp.dataset.off) : undefined);
  });
  // plain-text copy of several lines: one line per row, indentation kept
  view.addEventListener("copy", (e) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !docs || mode === "symbols") return;
    const rows = [...view.querySelectorAll<HTMLElement>(".dl")].filter((r) => sel.containsNode(r, true));
    if (rows.length < 2) return;
    e.preventDefault();
    const doc = mode === "pseudo" ? docs.pseudo : docs.ir;
    const all = [...view.querySelectorAll<HTMLElement>(".dl")];
    e.clipboardData?.setData("text/plain", rows.map((r) => { const l = doc.lines[all.indexOf(r)]; return l ? "  ".repeat(l.indent) + l.segs.map((s) => s.t).join("") : ""; }).join("\n"));
  });

  // ------------------------------------------------------------------------------------------ symbols tab
  function paintSymbols(): void {
    if (!ann) return;
    const rows = ann.symbols();
    const tb = h("tbody");
    for (const s of rows) {
      const nm = h("input", { type: "text", class: "nm mono", value: s.name });
      nm.addEventListener("change", () => {
        const v = nm.value.trim();
        if (s.kind === "function") ann!.setFuncName(Number(s.key), v, s.conf);
        else if (s.kind === "string") ann!.setString(Number(s.key), { name: v });
        else if (s.kind === "constant") ann!.setConst(Number(s.key), { name: v });
        else if (s.kind === "field") ann!.setField(Number(s.key), { name: v });
        else if (s.kind === "global") ann!.setGlobal(Number(s.key), { name: v });
      });
      const cf = select<string>([["confirmed", "confirmed"], ["inferred", "inferred"]], s.conf, (v) => { if (s.kind !== "variable") ann!.setConf(s.kind, s.key, v as Conf); });
      if (s.kind === "variable") cf.disabled = true;
      const go = s.kind === "function" ? iconBtn("→", "open this function", () => hooks.reopen(Number(s.key))) : "";
      tb.appendChild(h("tr", null, h("td", null, s.kind), h("td", null, nm), h("td", null, cf), h("td", { class: "muted" }, s.where + (s.comment ? "  — " + s.comment : "")), h("td", null, go)));
    }
    view.replaceChildren(h("div", { class: "muted", style: { padding: "6px 8px" } }, "Project-level: a name set here appears in every function that references it. Confirmed = you are sure; inferred = a guess. The WASM binary is never modified."),
      rows.length ? h("table", { class: "data" }, h("thead", null, h("tr", null, h("th", null, "kind"), h("th", null, "name"), h("th", null, "confidence"), h("th", null, "where"), h("th", null, ""))), tb) : h("div", { class: "empty" }, "No names yet. Double-click a function, string, constant or variable in the pseudocode to name it."));
    status.textContent = `${rows.length} symbol(s)`;
  }

  // ------------------------------------------------------------------------------------------ annotate dialogs
  const confSel = (c: Conf) => select<string>([["inferred", "inferred (a guess)"], ["confirmed", "confirmed (I am sure)"]], c);
  const lbl = (t: string, c: Node, hint = ""): HTMLElement => h("label", { class: "field", title: hint }, h("span", null, t), c);
  const inp = (v = "", ph = ""): HTMLInputElement => h("input", { type: "text", class: "mono", value: v, placeholder: ph, style: { width: "100%" } });

  async function annotate(ref: SymRef, off?: number): Promise<void> {
    if (!ann || !ir) return;
    const f = ir.index;
    const A = ann;
    const done = (fn: () => void) => () => { fn(); };
    if (ref.kind === "func") {
      const modName = ir.callees.find((c) => c.index === ref.id)?.name ?? (ref.id === f ? ir.name : `func_${ref.id}`);
      const cur = A.db.funcs[ref.id] ?? {};
      const name = inp(cur.name ?? "", modName), cf = confSel(cur.conf ?? "inferred"), cm = inp(cur.comment ?? "");
      const callee = ir.callees.find((c) => c.index === ref.id);
      const wasmSig = callee ? `(${callee.params.join(", ")}) -> ${callee.results.length ? callee.results.join(", ") : "()"}` : `(${ir.params.join(", ")}) -> ${ir.results.length ? ir.results.join(", ") : "()"}`;
      const ret = inp(cur.sig?.ret ?? "", "e.g. bool"), params = h("textarea", { class: "mono", rows: 4, style: { width: "100%" }, placeholder: "one per line:  type name\nUnit* unit", spellcheck: false });
      params.value = (cur.sig?.params ?? []).map((p) => `${p.type ?? ""} ${p.name ?? ""}`.trim()).join("\n");
      modal(`Function #${ref.id}`, h("div", { class: "stack", style: { minWidth: "440px" } },
        h("div", { class: "muted" }, `Original: ${modName}  ·  wasm signature ${wasmSig}  ·  the index #${ref.id} is never changed`),
        lbl("Name", name), lbl("Confidence", cf, "inferred names are drawn with a dashed underline and listed as inferred when copied"), lbl("Comment", cm),
        h("h4", null, "Signature (optional, shown instead of the raw wasm types; not verified)"), lbl("Return type", ret), lbl("Parameters", params)),
        [{ label: "Clear", onClick: done(() => { A.setFuncName(ref.id, ""); A.setFuncComment(ref.id, ""); A.setFuncSig(ref.id, null); }) },
          { label: "Cancel", onClick: () => {} },
          { label: "Save", primary: true, onClick: done(() => {
            A.setFuncName(ref.id, name.value, cf.value as Conf); A.setFuncComment(ref.id, cm.value);
            const ps = params.value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.lastIndexOf(" "); return i < 0 ? { type: l } : { type: l.slice(0, i).trim(), name: l.slice(i + 1).trim() }; });
            A.setFuncSig(ref.id, ret.value.trim() || ps.length ? { ...(ret.value.trim() ? { ret: ret.value.trim() } : {}), params: ps } : null);
          }) }]);
      return;
    }
    if (ref.kind === "const" || ref.kind === "str") {
      const v = ref.id >>> 0;
      const str = ir.strings[v];
      const isStr = ref.kind === "str" || str !== undefined;
      const curS = A.db.strings[v] ?? {};
      const curC = A.db.consts[v] ?? {};
      const curI = off !== undefined ? A.db.ins[`${f}:${off}`] : undefined;
      const scope = select<string>([["shared", `Shared: every use of ${v} (0x${v.toString(16)}) in the module`], ["ins", "This instruction only"]], isStr || v >= 0x1000 ? "shared" : "ins");
      const name = inp((curI?.name ?? curS.name ?? curC.name) ?? "", isStr ? "STR_USAGE_…" : "SYMBOL_NAME");
      const cf = confSel((curI?.conf ?? curS.conf ?? curC.conf) ?? "inferred");
      const cm = inp(curS.comment ?? curC.comment ?? "");
      modal(isStr ? `String @ 0x${v.toString(16)}` : `Constant ${v}`, h("div", { class: "stack", style: { minWidth: "460px" } },
        h("div", { class: "muted" }, `Original value: ${v}  (0x${v.toString(16)})${v > 0x7fffffff ? `  (signed ${v | 0})` : ""}`),
        ...(str !== undefined ? [h("pre", { class: "mono", style: { whiteSpace: "pre-wrap", margin: 0 } }, JSON.stringify(str)), h("div", { class: "muted" }, "Detected as a string because the bytes at this address are a NUL-terminated printable string. The constant itself is only an i32: this is inferred.")] : []),
        lbl("Name", name), lbl("Confidence", cf), lbl("Comment", cm), ...(isStr ? [] : [lbl("Applies to", scope)])),
        [{ label: "Clear", onClick: done(() => { A.setString(v, { name: "", comment: "" }); A.setConst(v, { name: "", comment: "" }); if (off !== undefined) A.setIns(f, off, { name: "" }); }) },
          { label: "Cancel", onClick: () => {} },
          { label: "Save", primary: true, onClick: done(() => {
            const nm = name.value.trim();
            if (isStr) { A.setString(v, { name: nm, conf: cf.value as Conf, comment: cm.value }); if (off !== undefined) A.setIns(f, off, { name: "" }); A.setConst(v, { name: "" }); }
            else if (scope.value === "shared") { A.setConst(v, { name: nm, conf: cf.value as Conf, comment: cm.value }); if (off !== undefined) A.setIns(f, off, { name: "" }); }
            else if (off !== undefined) { A.setIns(f, off, { name: nm, conf: cf.value as Conf }); if (cm.value) A.setConst(v, { comment: cm.value }); }
          }) }]);
      return;
    }
    if (ref.kind === "var") {
      const v = ir.vars.find((x) => x.id === ref.id);
      if (!v) return;
      if (v.kind === "temp" || v.kind === "result") return void toast("Temporaries are created by the decompiler and have no stable identity; name a parameter or local instead.", "info", 3500);
      const cur = A.db.funcs[f]?.vars?.[v.id] ?? {};
      const name = inp(cur.name ?? "", v.id), ty = inp(cur.type ?? "", v.ty);
      modal(`Variable ${v.id} (${v.kind})`, h("div", { class: "stack", style: { minWidth: "420px" } },
        h("div", { class: "muted" }, `wasm type ${v.ty} (confirmed)` + (v.hints.length ? `  ·  inferred: ${v.hints.map((x) => `${x.hint}? (${x.why})`).join("; ")}` : "")),
        lbl("Name", name), lbl("Declared type", ty, "free text, shown instead of the wasm type; not verified")),
        [{ label: "Cancel", onClick: () => {} }, { label: "Save", primary: true, onClick: done(() => A.setVar(f, v.id, { name: name.value.trim(), type: ty.value.trim() })) }]);
      return;
    }
    const isField = ref.kind === "field";
    const cur = isField ? A.db.fields[ref.id] ?? {} : A.db.globals[ref.id] ?? {};
    const name = inp(cur.name ?? ""), cf = confSel(cur.conf ?? "inferred"), cm = inp(cur.comment ?? "");
    modal(isField ? `Field offset +${ref.id}` : `Global ${ref.id}`, h("div", { class: "stack", style: { minWidth: "420px" } },
      isField ? h("div", { class: "muted" }, "Shared by every memory access with this static offset in the module, whatever struct it belongs to. Only name it if that is true.") : "",
      lbl("Name", name), lbl("Confidence", cf), lbl("Comment", cm)),
      [{ label: "Clear", onClick: done(() => (isField ? A.setField(ref.id, { name: "", comment: "" }) : A.setGlobal(ref.id, { name: "", comment: "" }))) }, { label: "Cancel", onClick: () => {} },
        { label: "Save", primary: true, onClick: done(() => (isField ? A.setField(ref.id, { name: name.value.trim(), conf: cf.value as Conf, comment: cm.value }) : A.setGlobal(ref.id, { name: name.value.trim(), conf: cf.value as Conf, comment: cm.value }))) }]);
  }

  /** comment attached to one instruction (offset shown as +001a) */
  async function commentInstruction(off: number | null): Promise<void> {
    if (!ann || !ir) return;
    if (off === null) return void toast("Select an instruction first (click a line in any view).", "info");
    const cur = ann.insComment(ir.index, off) ?? "";
    const i = inp(cur);
    modal(`Comment on +${off.toString(16).padStart(4, "0")} of func #${ir.index}`, h("div", { class: "stack", style: { minWidth: "440px" } }, lbl("Comment", i)),
      [{ label: "Clear", onClick: () => { ann!.setIns(ir!.index, off, { comment: "" }); } }, { label: "Cancel", onClick: () => {} }, { label: "Save", primary: true, onClick: () => { ann!.setIns(ir!.index, off, { comment: i.value }); } }]);
  }

  // ------------------------------------------------------------------------------------------ copy / import / export
  function exportText(): string {
    if (!docs || !ann || !ir) return "";
    if (mode === "ir") return toText(docs.ir);
    const used = docs.pseudo.used;
    const syms = ann.symbols().filter((s) => (s.kind === "function" && used.funcs.includes(Number(s.key))) || (s.kind === "string" && used.strs.includes(Number(s.key))) || (s.kind === "constant" && used.consts.includes(Number(s.key))));
    const head = syms.length ? ["// symbols used in this function (name = original, confidence):", ...syms.map((s) => `//   ${s.where}: ${s.name}  (${s.conf})`), ""].join("\n") + "\n" : "";
    return head + toText(docs.pseudo);
  }
  const exportDB = () => { if (ann) download(`cetus-annotations-${moduleId.slice(0, 13)}.json`, JSON.stringify(ann.db, null, 2), "application/json"); };
  const importDB = () => {
    const i = h("input", { type: "file", accept: ".json" });
    i.onchange = async () => {
      try {
        const txt = await i.files?.[0]?.text(); if (!txt || !ann) return;
        const j = JSON.parse(txt);
        if (!Annotations.matches(j, moduleId)) return void toast("These annotations belong to a different module (identity mismatch); not imported.", "error", 5000);
        ann.merge(j); toast("Annotations merged", "ok");
      } catch (e) { toast("Import failed: " + errMsg(e), "error"); }
    };
    i.click();
  };

  const el = h("div", { class: "stack fill dc", style: { display: "none" } },
    h("div", { class: "row" }, mkTab("pseudo", "Pseudocode", "C-like pseudocode"), mkTab("ir", "IR", "intermediate representation: basic blocks, edges, defs/uses"), mkTab("symbols", "Symbols", "project-level names with confidence"),
      h("span", { class: "grow" }),
      h("button", { title: "copy this view as text (pseudocode includes a header of the names used and their confidence)", onclick: () => { void copyText(exportText()); toast("copied", "ok", 900); } }, "Copy"),
      h("button", { title: "attach a comment to the selected instruction", onclick: () => void commentInstruction(selOff) }, "Comment…"),
      iconBtn("⇩", "export all annotations of this module (JSON)", exportDB), iconBtn("⇧", "import annotations for this module", importDB)),
    h("div", { class: "panel fill", style: { overflow: "auto", padding: 0 } }, view),
    status);
  paintTabs();

  return {
    el,
    load,
    select: selectOff,
    get ir() { return ir; },
    insComment: (off: number): string | undefined => (ir && ann ? ann.insComment(ir.index, off) : undefined),
    refresh: () => render(),
    /** the ✎ button of the Code view and the pseudocode share one name */
    async renameFunc(idx: number, name: string): Promise<void> {
      if (!ann) { const r = await rpc("decomp.ir", { index: idx }, undefined, true); await ensureAnn(r.moduleId); }
      ann!.setFuncName(idx, name, ann!.db.funcs[idx]?.conf ?? "inferred");
    },
    clear() { ir = null; loadedFor = -1; docs = null; clear(view); },
    onAnnotationsChange(f: () => void) { ann?.onChange(f); },
  };
}
