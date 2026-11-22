export type MatchMode = "contains" | "prefix" | "suffix" | "exact" | "wildcard" | "regex";

export interface MatchSpec {
  mode: MatchMode;
  text: string;
  caseSensitive?: boolean;
  invert?: boolean;
}

export const MATCH_MODES: { id: MatchMode; label: string }[] = [
  { id: "contains", label: "contains" },
  { id: "prefix", label: "starts with" },
  { id: "suffix", label: "ends with" },
  { id: "exact", label: "equals" },
  { id: "wildcard", label: "wildcard (* ?)" },
  { id: "regex", label: "regex" },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Compile a text filter into a predicate. Empty text matches everything. Throws on a bad regex. */
export function compileMatcher(spec: MatchSpec | null | undefined): (s: string) => boolean {
  if (!spec || spec.text === "") return () => true;
  const cs = !!spec.caseSensitive;
  const inv = !!spec.invert;
  let test: (s: string) => boolean;
  const needle = cs ? spec.text : spec.text.toLowerCase();
  switch (spec.mode) {
    case "contains": test = cs ? (s) => s.includes(needle) : (s) => s.toLowerCase().includes(needle); break;
    case "prefix": test = cs ? (s) => s.startsWith(needle) : (s) => s.toLowerCase().startsWith(needle); break;
    case "suffix": test = cs ? (s) => s.endsWith(needle) : (s) => s.toLowerCase().endsWith(needle); break;
    case "exact": test = cs ? (s) => s === needle : (s) => s.toLowerCase() === needle; break;
    case "wildcard": {
      const re = new RegExp("^" + spec.text.split("*").map((p) => p.split("?").map(escapeRe).join(".")).join(".*") + "$", cs ? "s" : "si");
      test = (s) => re.test(s);
      break;
    }
    case "regex": {
      const re = new RegExp(spec.text, cs ? "" : "i");
      test = (s) => re.test(s);
      break;
    }
    default: test = () => true;
  }
  return inv ? (s) => !test(s) : test;
}
