/** Hotkey helpers: "Ctrl-Alt-2", "ctrl+alt+2" and real key events all normalise to "Ctrl+Alt+2". */
const MODS = ["Ctrl", "Alt", "Shift", "Meta"] as const;

const KEY_ALIASES: Record<string, string> = {
  control: "Ctrl", ctl: "Ctrl", ctrl: "Ctrl", alt: "Alt", option: "Alt", opt: "Alt", shift: "Shift", meta: "Meta", cmd: "Meta", command: "Meta", win: "Meta",
  esc: "Escape", escape: "Escape", space: "Space", spacebar: "Space", enter: "Enter", return: "Enter", tab: "Tab", del: "Delete", delete: "Delete", ins: "Insert", insert: "Insert",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", pgup: "PageUp", pageup: "PageUp", pgdn: "PageDown", pagedown: "PageDown", home: "Home", end: "End",
  backspace: "Backspace", plus: "+", minus: "-", comma: ",", period: ".", dot: ".",
};

export function normalizeCombo(text: string): string {
  const parts = text.trim().split(/\s*[+\-]\s*(?=[^\s])|\s+/).filter(Boolean);
  // "Ctrl-Alt--" / "Ctrl+Alt++" edge cases: a trailing separator means the key itself is + or -
  if (/[+\-]\s*$/.test(text.trim()) && /[+\-]\s*[+\-]\s*$/.test(text.trim())) parts.push(text.trim().slice(-1) === "+" ? "+" : "-");
  const mods = new Set<string>();
  let key = "";
  for (const raw of parts) {
    const a = KEY_ALIASES[raw.toLowerCase()];
    if (a && (MODS as readonly string[]).includes(a)) mods.add(a);
    else key = a ?? (raw.length === 1 ? raw.toUpperCase() : raw[0]!.toUpperCase() + raw.slice(1));
  }
  if (!key) return "";
  return [...MODS.filter((m) => mods.has(m)), key].join("+");
}

export function comboFromEvent(e: { code: string; key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string {
  if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(e.code) || ["Control", "Alt", "Shift", "Meta"].includes(e.key)) return "";
  let key: string;
  if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) key = "Num" + e.code.slice(6);
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (e.code === "Minus") key = "-";
  else if (e.code === "Equal") key = "=";
  else key = e.code || e.key;
  const m: string[] = [];
  if (e.ctrlKey) m.push("Ctrl");
  if (e.altKey) m.push("Alt");
  if (e.shiftKey) m.push("Shift");
  if (e.metaKey) m.push("Meta");
  return [...m, key].join("+");
}
