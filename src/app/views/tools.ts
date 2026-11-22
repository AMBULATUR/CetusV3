import { h, toast, errMsg, field, select, fmtBytes } from "../ui";
import { rpc, reloadTarget, loadOptions, saveOptions, Options, DEFAULT_OPTIONS, getUi, saveUi, onUi, DEFAULT_UI, UiSettings } from "../api";
import { Ctx, View } from "../ctx";

export function toolsView(ctx: Ctx): View {
  const speed = h("input", { type: "number", step: "0.05", min: "0.01", value: "1", style: { width: "90px" } });
  const speedLbl = h("span", { class: "muted" });
  const setSpeed = async (v: number) => { try { await rpc("speed.set", { multiplier: v }); speed.value = String(v); speedLbl.textContent = `time runs at ${v}×`; } catch (e) { toast(errMsg(e), "error"); } };
  const diag = h("pre", { class: "stack panel", style: { overflow: "auto", flex: "1" } });

  const opts: Options = { ...DEFAULT_OPTIONS };
  const form = h("div", { class: "stack", style: { maxWidth: "560px" } });
  const cb = (label: string, key: keyof Options, hint?: string) => {
    const i = h("input", { type: "checkbox", checked: !!opts[key] });
    i.onchange = () => { (opts as any)[key] = i.checked; };
    return h("label", { class: "chk", title: hint }, i, label);
  };
  const num = (label: string, key: keyof Options, max: number) => {
    const i = h("input", { type: "number", min: 0, max, value: Number(opts[key]), style: { width: "70px" } });
    i.onchange = () => { (opts as any)[key] = Math.max(0, Math.min(max, Number(i.value) | 0)); };
    return field(label, i);
  };
  async function drawSettings() {
    Object.assign(opts, await loadOptions());
    form.replaceChildren(
      cb("Enable Cetus on all pages", "enabled", "when off, WebAssembly is not touched at all"),
      field("Open workspace in", select<string>([["tab", "a browser tab"], ["window", "a separate window"]], opts.openMode, (v) => (opts.openMode = v as any))),
      h("div", { class: "row" }, num("Watch slots", "wpCount", 16), num("Function breakpoint slots", "funcSlots", 16)),
      h("label", { class: "chk", title: "instrument loads (read watchpoints). Costs some speed on hot code." }, (() => { const i = h("input", { type: "checkbox", checked: !!(opts.enableWatchpoints & 1) }); i.onchange = () => { opts.enableWatchpoints = i.checked ? opts.enableWatchpoints | 1 : opts.enableWatchpoints & ~1; }; return i; })(), "Instrument memory reads (read watchpoints)"),
      h("label", { class: "chk", title: "instrument stores (write watchpoints and hard freeze). Very cheap when no watch is active." }, (() => { const i = h("input", { type: "checkbox", checked: !!(opts.enableWatchpoints & 6) }); i.onchange = () => { opts.enableWatchpoints = i.checked ? opts.enableWatchpoints | 6 : opts.enableWatchpoints & ~6; }; return i; })(), "Instrument memory writes (write watchpoints, hard freeze)"),
      cb("Instrument function entries (breakpoints, call trace)", "funcHooks"),
      cb("Pause in DevTools on every hit (runs `debugger;`)", "pauseOnHit", "open DevTools on the target page first"),
      field("Console logging", select<string>([["0", "off"], ["1", "verbose"]], String(opts.logLevel), (v) => (opts.logLevel = Number(v)))),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: async () => { await saveOptions(opts); toast("Saved. Instrumentation options apply to pages loaded afterwards — reload the target tab.", "ok", 5000); } }, "Save settings"),
        h("button", { onclick: () => void reloadTarget() }, "Reload target tab")));
  }

  // ---- live updates (apply immediately, no reload) ------------------------------------
  const live = h("div", { class: "stack" });
  const drawLive = () => {
    const ui = getUi();
    const interval = (label: string, key: "pollCheat" | "pollMemory" | "pollScanner" | "pollDebugger", hint: string) =>
      field(label, select<string>([["0", "off (manual ↻)"], ["200", "200 ms"], ["300", "300 ms"], ["500", "500 ms"], ["1000", "1 s"], ["1500", "1.5 s"], ["2000", "2 s"], ["5000", "5 s"]], String(ui[key]), (v) => void saveUi({ [key]: Number(v) } as Partial<UiSettings>)), hint);
    const cb = (label: string, key: "live" | "pauseHidden", hint: string) => {
      const i = h("input", { type: "checkbox", checked: ui[key] });
      i.onchange = () => void saveUi({ [key]: i.checked } as Partial<UiSettings>);
      return h("label", { class: "chk", title: hint }, i, label);
    };
    live.replaceChildren(
      cb("Live updates on", "live", "master switch (also the Live button in the header)"),
      cb("Pause while this tab is in the background", "pauseHidden", "recommended: nothing is polled while you play the game"),
      h("div", { class: "row" }, interval("Cheat table", "pollCheat", "how often values are re-read"), interval("Memory view", "pollMemory", "hex view refresh"), interval("Scanner results", "pollScanner", "live value column"), interval("Debugger", "pollDebugger", "hits / breakpoints / trace")),
      h("div", { class: "muted" }, "Each view runs at most one request at a time and pauses while one of your own actions is in flight, so a slow game can never build up a backlog. If the game lags, pick a longer interval or turn a view off."),
      h("button", { onclick: () => void saveUi({ ...DEFAULT_UI }) }, "Reset to defaults"));
  };
  onUi(drawLive);

  async function drawDiag() {
    const t = ctx.target();
    if (!t) { diag.textContent = "no target"; return; }
    try {
      const i = await rpc("info");
      diag.textContent = [
        `page        ${i.url}`, `instance    #${i.id}`, `module      ${fmtBytes(i.moduleBytes)}, ${i.funcs} functions (${i.imported} imported)`,
        `memory      ${i.hasMemory ? fmtBytes(i.memBytes) + (i.shared ? " (shared)" : "") : "NOT FOUND"}`,
        `instrument  ${i.instrumented ? "yes" : "NO"}  write=${i.features.write} read=${i.features.read} func=${i.features.funcHooks} slots=${i.features.slots}/${i.features.funcSlots}`,
        `patched     ${i.patched.length ? i.patched.map((x: number) => "#" + x).join(", ") : "none"}`, `names       ${i.hasNames ? "name section present" : "stripped (functions are func_N)"}`,
        i.error ? `ERROR       ${i.error}` : "", ...i.notes.map((n: string) => "note        " + n),
      ].filter(Boolean).join("\n");
    } catch (e) { diag.textContent = errMsg(e); }
  }

  const el = h("div", { class: "view" },
    h("div", { class: "cols" },
      h("div", { class: "stack", style: { flex: "1" } },
        h("div", { class: "panel" }, h("h3", null, "Speed hack"), h("div", { class: "row" },
          ...[0.1, 0.25, 0.5, 1, 2, 5, 10].map((v) => h("button", { onclick: () => void setSpeed(v) }, v + "×")), speed, h("button", { onclick: () => void setSpeed(Number(speed.value)) }, "Set"), speedLbl),
          h("div", { class: "muted", style: { marginTop: "4px" } }, "Scales Date.now() and performance.now() in the page.")),
        h("div", { class: "panel" }, h("h3", null, "Target"), h("div", { class: "row" },
          h("button", { onclick: () => void rpc("mod.download").then((r) => toast(`Downloading ${fmtBytes(r.size)} original module`, "ok")).catch((e) => toast(errMsg(e), "error")) }, "⤓ Download original .wasm"),
          h("button", { onclick: () => void reloadTarget() }, "↻ Reload target tab"), h("button", { onclick: () => void drawDiag() }, "Refresh diagnostics"))),
        h("div", { class: "panel fill" }, h("h3", null, "Diagnostics"), diag)),
      h("div", { class: "panel scroll", style: { flex: "1" } }, h("h3", null, "Live updates"), live, h("h3", { style: { marginTop: "14px" } }, "Instrumentation & behaviour (needs page reload)"), form)));
  drawLive();
  return { el, show() { void drawSettings(); void drawDiag(); }, retarget() { void drawDiag(); } };
}
