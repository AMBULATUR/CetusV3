import { h, toast, errMsg, select, field, modal, promptText, download, iconBtn, debounce } from "../ui";
import { rpc, pageKey } from "../api";
import { Ctx, View } from "../ctx";
import { Script, Folder, ScriptStore, newScript, exportJson, importJson, uid } from "../../shared/scriptstore";
import { comboFromEvent, normalizeCombo } from "../../shared/hotkey";
import { loadScripts, saveScripts, runScriptOnTarget } from "../scriptstore";
import { parseScript, BUILTIN_NAMES, rowIdentifier } from "../../page/script";

export function scriptsView(ctx: Ctx): View {
  let store: ScriptStore = { folders: [] };
  let selId = "";
  const open = new Set<string>();
  let statusTimer: ReturnType<typeof setTimeout> | undefined;

  const tree = h("div", { class: "scroll", style: { flex: "1" } });
  const editorWrap = h("div", { class: "stack fill", style: { gap: "8px" } });
  const out = h("pre", { class: "stack panel", style: { height: "130px", overflow: "auto", flex: "none", margin: "0" } });
  const rowsBox = h("div", { class: "scroll", style: { flex: "1" } });

  const find = (id: string): { f: Folder; s: Script } | null => {
    for (const f of store.folders) { const s = f.scripts.find((x) => x.id === id); if (s) return { f, s }; }
    return null;
  };
  const persist = () => saveScripts(store).catch((e) => toast(errMsg(e), "error"));
  const persistSoon = debounce(() => void persist(), 400);

  // ---- tree ---------------------------------------------------------------------------
  function drawTree() {
    tree.replaceChildren();
    for (const f of store.folders) {
      const isOpen = open.has(f.id);
      tree.appendChild(h("div", { class: "row", style: { padding: "4px 2px", gap: "2px", flexWrap: "nowrap", borderBottom: "1px solid var(--line)" } },
        h("button", { class: "icon", onclick: () => { if (isOpen) open.delete(f.id); else open.add(f.id); drawTree(); } }, isOpen ? "▾" : "▸"),
        h("b", { class: "grow", style: { cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis" }, onclick: () => { if (isOpen) open.delete(f.id); else open.add(f.id); drawTree(); } }, `📁 ${f.name}`), h("span", { class: "muted" }, String(f.scripts.length)),
        iconBtn("＋", "new script in this folder", () => void addScript(f)),
        iconBtn("✎", "rename folder", async () => { const n = await promptText("Rename folder", "Folder name", f.name); if (n) { f.name = n; await persist(); drawTree(); } }),
        iconBtn("⤓", "export this folder (JSON)", () => download(`${f.name}.cetus-scripts.json`, exportJson(store, [f.id]), "application/json")),
        iconBtn("✕", "delete folder and its scripts", async () => { if (!f.scripts.length || confirm(`Delete folder "${f.name}" with ${f.scripts.length} script(s)?`)) { store.folders = store.folders.filter((x) => x !== f); if (find(selId) === null) selId = ""; await persist(); drawTree(); drawEditor(); } }, "danger")));
      if (isOpen) for (const s of f.scripts) {
        tree.appendChild(h("div", { class: "row", style: { padding: "3px 4px 3px 26px", cursor: "pointer", background: s.id === selId ? "var(--sel)" : "", flexWrap: "nowrap", gap: "4px" }, onclick: () => { selId = s.id; drawTree(); drawEditor(); } },
          h("span", { class: s.enabled ? "" : "muted", style: { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "▶ " + s.name),
          s.hotkey ? h("span", { class: "badge", title: "in-page hotkey" }, s.hotkey) : "", s.slot ? h("span", { class: "badge", title: "Chrome shortcut slot" }, "slot " + s.slot) : ""));
      }
    }
    if (!store.folders.length) tree.appendChild(h("div", { class: "empty" }, "No folders yet — press ＋ Folder"));
  }
  async function addScript(f: Folder) {
    const name = await promptText("New script", "Script name", "New script");
    if (!name) return;
    const s = newScript(name, pageKey(ctx.target()) || "*", "// " + name + "\n");
    f.scripts.push(s); open.add(f.id); selId = s.id;
    await persist(); drawTree(); drawEditor();
  }

  // ---- editor ---------------------------------------------------------------------------
  function drawEditor() {
    editorWrap.replaceChildren();
    const hit = find(selId);
    if (!hit) { editorWrap.appendChild(h("div", { class: "hero" }, h("h2", null, "Scripts"), h("p", null, "Pick or create a script in a folder on the left. Cheat-table rows with a description become variables:"), h("pre", { class: "mono", style: { textAlign: "left", display: "inline-block" } }, 'TextFromAddress = "Text From Script"\nHealth = 999\nif (Gold < 100) Gold += 500'), h("p", null, "Bind a hotkey such as ", h("code", null, "Ctrl+Alt+2"), " — it works while the game tab has focus, even with this workspace closed."))); return; }
    const { f, s } = hit;
    const name = h("input", { type: "text", value: s.name, class: "grow" });
    name.addEventListener("input", () => { s.name = name.value; persistSoon(); });
    name.addEventListener("change", () => drawTree());
    const move = select<string>(store.folders.map((x) => [x.id, "📁 " + x.name] as [string, string]), f.id, (fid) => { const to = store.folders.find((x) => x.id === fid)!; f.scripts = f.scripts.filter((x) => x !== s); to.scripts.push(s); open.add(to.id); void persist(); drawTree(); drawEditor(); });
    const scope = select<string>([[pageKey(ctx.target()) || "*", "this page only"], ["*", "all pages"]], s.scope === "*" ? "*" : (pageKey(ctx.target()) || "*"), (v) => { s.scope = v; void persist(); });
    if (s.scope !== "*" && s.scope !== pageKey(ctx.target())) scope.appendChild(h("option", { value: s.scope, selected: true }, s.scope));
    scope.value = s.scope;
    scope.onchange = () => { s.scope = scope.value; void persist(); };

    const hot = h("input", { type: "text", class: "mono", value: s.hotkey, placeholder: "click & press keys, e.g. Ctrl+Alt+2", style: { width: "210px" }, title: "in-page hotkey (works while the game tab is focused). Backspace clears." });
    hot.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); hot.value = ""; s.hotkey = ""; void persist(); drawTree(); conflict(); return; }
      const c = comboFromEvent(e);
      if (!c) return;
      e.preventDefault(); e.stopPropagation();
      if (!/Ctrl|Alt|Meta|^F\d+$/.test(c)) { toast("use at least Ctrl or Alt (or an F-key) so normal typing is not hijacked", "error"); return; }
      hot.value = c; s.hotkey = c; void persist(); drawTree(); conflict();
    });
    hot.addEventListener("change", () => { s.hotkey = normalizeCombo(hot.value); hot.value = s.hotkey; void persist(); drawTree(); conflict(); });
    const warn = h("span", { class: "warn" });
    const conflict = () => {
      const dup = store.folders.flatMap((x) => x.scripts).find((x) => x !== s && x.enabled && s.hotkey && x.hotkey === s.hotkey && (x.scope === "*" || s.scope === "*" || x.scope === s.scope));
      warn.textContent = dup ? `⚠ also used by “${dup.name}”` : "";
    };
    conflict();
    const slot = select<string>([["0", "none"], ["1", "slot 1"], ["2", "slot 2"], ["3", "slot 3"], ["4", "slot 4"]], String(s.slot), (v) => { s.slot = Number(v) as Script["slot"]; void persist(); drawTree(); void showSlots(); });
    slot.title = "Chrome-level shortcut: assign the key in chrome://extensions/shortcuts. Works from any tab / when the page does not have focus.";
    const slotInfo = h("span", { class: "muted" });
    async function showSlots() {
      if (!s.slot) { slotInfo.textContent = ""; return; }
      try {
        const cmds = await chrome.commands.getAll();
        const c = cmds.find((x) => x.name === `cetus-slot-${s.slot}`);
        slotInfo.textContent = c?.shortcut ? `key: ${c.shortcut}` : "no key assigned yet →";
      } catch { slotInfo.textContent = ""; }
    }
    void showSlots();
    const en = h("input", { type: "checkbox", checked: s.enabled }); en.onchange = () => { s.enabled = en.checked; void persist(); drawTree(); };
    const sil = h("input", { type: "checkbox", checked: s.silent }); sil.onchange = () => { s.silent = sil.checked; void persist(); };

    const code = h("textarea", { class: "editor", spellcheck: false, value: s.code });
    code.addEventListener("input", () => { s.code = code.value; persistSoon(); });
    code.addEventListener("keydown", (e) => {
      if (e.key === "Tab") { e.preventDefault(); code.setRangeText("  ", code.selectionStart, code.selectionEnd, "end"); s.code = code.value; persistSoon(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void run(); }
    });

    const runBtn = h("button", { class: "primary" }, "▶ Run / Stop");
    runBtn.title = "Ctrl+Enter — runs on the selected page; running it again stops it";
    runBtn.onclick = () => void run();
    const check = h("button", { onclick: () => { try { parseScript(s.code); log("✔ syntax OK", "ok"); } catch (e) { log("✖ " + errMsg(e), "err"); } } }, "Check syntax");

    editorWrap.append(
      h("div", { class: "row" }, name, move, scope, h("label", { class: "chk" }, en, "enabled"), h("label", { class: "chk", title: "no toasts on the page" }, sil, "silent")),
      h("div", { class: "row" }, field("In-page hotkey", hot), warn, field("Chrome shortcut slot", slot), slotInfo,
        h("button", { class: "icon", title: "open chrome://extensions/shortcuts", onclick: () => void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }) }, "⌨"), h("span", { class: "grow" }), runBtn, check,
        iconBtn("⤓", "export this script", () => download(`${s.name}.cetus-scripts.json`, exportJson({ folders: [{ ...f, scripts: [s] }] }), "application/json")),
        iconBtn("⧉", "duplicate", () => { const c = { ...s, id: uid(), name: s.name + " copy", hotkey: "", slot: 0 as const }; f.scripts.push(c); selId = c.id; void persist(); drawTree(); drawEditor(); }),
        iconBtn("✕", "delete script", () => { if (!confirm(`Delete "${s.name}"?`)) return; f.scripts = f.scripts.filter((x) => x !== s); selId = ""; void persist(); drawTree(); drawEditor(); }, "danger")),
      code, out);
    drawRows();
  }

  // ---- output ------------------------------------------------------------------------------
  function log(msg: string, cls: "ok" | "err" | "" = "") {
    out.replaceChildren(h("span", { class: cls }, msg));
  }
  async function run() {
    const hit = find(selId);
    if (!hit) return;
    clearTimeout(statusTimer);
    try {
      const r = await runScriptOnTarget(hit.s, ctx);
      if (r.stopped) { log("■ stopped", ""); return; }
      log("▶ running…", "");
      const poll = async () => {
        try {
          const st = await rpc("script.status", { id: hit.s.id });
          if (!st) return;
          out.replaceChildren(h("span", { class: st.error ? "err" : st.running ? "" : "ok" }, (st.running ? "▶ running…" : st.error ? "✖ " + st.error : `✔ finished in ${((st.ended ?? Date.now()) - st.started)} ms`) + (st.logs.length ? "\n" + st.logs.join("\n") : "")));
          out.scrollTop = out.scrollHeight;
          if (st.running) statusTimer = setTimeout(poll, 400);
        } catch { /* target gone */ }
      };
      void poll();
    } catch (e) { log("✖ " + errMsg(e), "err"); }
  }

  // ---- row helper -----------------------------------------------------------------------------
  function drawRows() {
    rowsBox.replaceChildren();
    const rows = ctx.data().bookmarks.filter((b) => b.desc && b.desc.trim());
    rowsBox.appendChild(h("h3", null, `Rows of this page (${rows.length})`));
    if (!rows.length) rowsBox.appendChild(h("div", { class: "muted" }, "Give cheat-table rows a description — it becomes the variable name."));
    for (const b of rows) {
      const id = rowIdentifier(b.desc);
      rowsBox.appendChild(h("div", { class: "row", style: { gap: "4px", flexWrap: "nowrap" } }, h("a", { class: "link", href: "#", title: "insert at cursor", onclick: (e: Event) => { e.preventDefault(); insert(id); } }, id || "?"), h("span", { class: "muted" }, b.type + (b.ptr ? " ⛓" : ""))));
    }
    rowsBox.appendChild(h("h3", { style: { marginTop: "10px" } }, "Functions"));
    rowsBox.appendChild(h("div", { class: "mono muted", style: { fontSize: "11px", lineHeight: "1.6" } }, BUILTIN_NAMES.join("  ")));
    rowsBox.appendChild(h("div", { class: "muted", style: { marginTop: "6px", fontSize: "11px" } }, "freeze(Row[, v]) unfreeze(Row) toggle(Row) · str(Row) setStr(Row, text) · read(addr, type) write(addr, type, v) · call(\"export\", args…) · sleep(ms) log(…) toast(…) · Row.addr"));
  }
  function insert(text: string) {
    const ta = editorWrap.querySelector("textarea") as HTMLTextAreaElement | null;
    if (!ta) return;
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end"); ta.focus();
    const hit = find(selId); if (hit) { hit.s.code = ta.value; persistSoon(); }
  }

  // ---- toolbar: folders / import / export -------------------------------------------------------
  const addFolder = async () => {
    const n = await promptText("New folder", "Folder name (e.g. mockTesting, UiTesting, UserButtonTesting)", "");
    if (!n) return;
    const f: Folder = { id: uid(), name: n, scripts: [] };
    store.folders.push(f); open.add(f.id); await persist(); drawTree();
  };
  const importFile = () => {
    const inp = h("input", { type: "file", accept: ".json", multiple: true });
    inp.onchange = async () => {
      try {
        let tf = 0, ts = 0, ck = 0;
        for (const file of Array.from(inp.files ?? [])) { const r = importJson(store, await file.text()); tf += r.folders; ts += r.scripts; ck += r.clearedKeys; }
        await persist(); drawTree(); toast(`Imported ${ts} script(s), ${tf} new folder(s)` + (ck ? ` · ${ck} hotkey/slot binding(s) were already in use and were cleared` : ""), "ok", ck ? 6000 : 3500);
        store.folders.forEach((f) => open.add(f.id)); drawTree();
      } catch (e) { toast("Import failed: " + errMsg(e), "error"); }
    };
    inp.click();
  };
  const exportAll = () => { if (!store.folders.length) return toast("nothing to export", "info"); download("cetus-scripts.json", exportJson(store), "application/json"); };
  const shortcutsHelp = () => modal("Chrome shortcut slots", h("div", { class: "stack" },
    h("p", null, "Cetus registers four Chrome-level shortcut slots. Pick “slot N” in a script, then assign any key to the slot in ", h("code", null, "chrome://extensions/shortcuts"), " (Cetus → “Run the script assigned to slot N”)."),
    h("p", { class: "muted" }, "Slot shortcuts run on the active tab from anywhere in the browser. The in-page hotkey field needs no setup and has no limit on how many scripts you bind, but only fires while the game tab has focus.")),
    [{ label: "Open shortcut settings", onClick: () => { void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); } }, { label: "Close", primary: true, onClick: () => {} }]);

  const el = h("div", { class: "view" },
    h("div", { class: "cols" },
      h("div", { class: "panel stack", style: { width: "300px", flex: "none", gap: "6px" } },
        h("div", { class: "row" }, h("button", { onclick: () => void addFolder() }, "＋ Folder"), h("button", { onclick: importFile }, "Import"), h("button", { onclick: exportAll }, "Export all"), iconBtn("⌨", "about Chrome shortcut slots", shortcutsHelp)), tree),
      editorWrap,
      h("div", { class: "panel stack", style: { width: "210px", flex: "none" } }, rowsBox)));

  return {
    el,
    async show() {
      store = await loadScripts();
      if (!selId || !find(selId)) { const first = store.folders.find((f) => f.scripts.length); selId = first?.scripts[0]?.id ?? ""; if (first) open.add(first.id); }
      const sel = find(selId); if (sel) open.add(sel.f.id);
      drawTree(); drawEditor();
    },
    hide() { clearTimeout(statusTimer); },
    retarget() { drawRows(); },
  };
}
