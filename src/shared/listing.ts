/**
 * Plain-text rendering of the Code view, exactly as it looks on screen: one instruction per line,
 * `+off  bytes  <indent>instruction  hint`, with the byte column padded so everything lines up.
 */
export interface ListLine {
  off: number;
  indent: number;
  text: string;
  comment: string;
  /** call / ref.func target: the hint is shown as a link `→ name` */
  target?: number | undefined;
  /** raw instruction bytes as hex */
  bytes: string;
}

const MAX_BYTES_COL = 24; // longer encodings (br_table, v128.const) overflow instead of pushing everything right

export const hintOf = (l: ListLine): string => (l.target !== undefined ? "→ " + (l.comment || `func ${l.target}`) : l.comment);

/** `bytesWidth` null = leave the bytes column out */
export function formatLine(l: ListLine, bytesWidth: number | null): string {
  const hint = hintOf(l);
  const bytes = bytesWidth === null ? "" : l.bytes.padEnd(bytesWidth) + "  ";
  return `+${l.off.toString(16).padStart(4, "0")}  ${bytes}${"  ".repeat(l.indent)}${l.text}${hint ? "  " + hint : ""}`.trimEnd();
}

export function formatListing(lines: ListLine[], opts: { header?: string; bytes?: boolean } = {}): string {
  const showBytes = opts.bytes !== false;
  const w = Math.min(MAX_BYTES_COL, lines.reduce((m, l) => Math.max(m, l.bytes.length), 0));
  const out = lines.map((l) => formatLine(l, showBytes ? w : null));
  return (opts.header ? opts.header + "\n" : "") + out.join("\n");
}
