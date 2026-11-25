import { describe, it, expect } from "vitest";
import wabtInit from "wabt";
import { parseModule } from "../src/wasm/module";
import { disassembleBody, assemble } from "../src/wasm/text";
import { formatListing, formatLine, ListLine } from "../src/shared/listing";

const wabt = await wabtInit();
const compile = (wat: string) => wabt.parseWat("t.wat", wat, {}).toBinary({}).buffer as Uint8Array;
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("Code view: hints and copy-as-shown", () => {
  const WAT = `(module (memory 1) (data (i32.const 320855) "Usage: ChangeFontUnit(\\"unit\\")\\00")
    (func (export "f") (param i32) (result f64)
      i32.const 320855 drop
      local.get 0
      if (result f64)
        local.get 0 i32.load offset=216 f32.load offset=140 f64.promote_f32
      else
        f64.const 0
      end))`;
  const m = parseModule(compile(WAT));
  const b = m.bodies[0]!;
  const str = (v: number) => (v === 320855 ? JSON.stringify('Usage: ChangeFontUnit("unit")') : undefined);

  it("string hints land in the disassembly text (as ;; comments) and still assemble to identical bytes", () => {
    const d = disassembleBody(m.bytes, b.start, b.end, { i32Comment: str });
    expect(d.text).toContain('i32.const 320855  ;; "Usage: ChangeFontUnit(\\"unit\\")"');
    const a = assemble(d.text);
    expect([...(a.locals ?? [0]), ...a.code]).toEqual(Array.from(m.bytes.subarray(b.start, b.end)));
    expect(disassembleBody(m.bytes, b.start, b.end).text).not.toContain("Usage"); // without the callback nothing changes
  });

  it("copy as shown: one aligned line per instruction, hint at the end, nothing split across lines", () => {
    const d = disassembleBody(m.bytes, b.start, b.end, { i32Comment: str });
    const lines: ListLine[] = d.lines.map((l) => ({ off: l.off, indent: l.indent, text: l.text, comment: l.comment, target: l.target, bytes: hexOf(l.bytes) }));
    const out = formatListing(lines, { header: "f  #0" });
    const rows = out.split("\n");
    expect(rows.length).toBe(lines.length + 1);
    const withStr = rows.find((r) => r.includes("320855"))!;
    expect(withStr).toMatch(/^\+[0-9a-f]{4}  [0-9a-f]+ +i32\.const 320855  "Usage: ChangeFontUnit\(\\"unit\\"\)"$/);
    // columns line up: instruction text starts at the same column on every top-level row
    expect(rows.slice(1).every((r) => /^\+[0-9a-f]{4}  /.test(r))).toBe(true);
    const loadRow = rows.find((r) => r.includes("f32.load offset=140"))!;
    expect(loadRow).toMatch(/^\+[0-9a-f]{4}  [0-9a-f]+ +\s*f32\.load offset=140$/);
    // nested instructions are indented relative to the `if`
    const ifRow = rows.find((r) => /\bif \(result f64\)/.test(r))!;
    expect(loadRow.indexOf("f32.load")).toBeGreaterThan(ifRow.indexOf("if"));
    // the bytes column is padded to one fixed width: the two-space gap after it sits at the same column on every row
    const w = Math.max(...lines.map((l) => l.bytes.length));
    for (const r of rows.slice(1)) {
      expect(r.slice(7, 7 + w)).toMatch(/^[0-9a-f]+ *$/);
      expect(r.slice(7 + w, 9 + w)).toBe("  ");
    }
  });

  it("call targets are shown as `→ name`; bytes column can be dropped", () => {
    const l: ListLine = { off: 0x20, indent: 1, text: "call 12", comment: "$render", target: 12, bytes: "100c" };
    expect(formatLine(l, 8)).toBe("+0020  100c      " + "  call 12  → $render");
    expect(formatLine(l, null)).toBe("+0020    call 12  → $render");
    expect(formatLine({ ...l, comment: "" }, null)).toBe("+0020    call 12  → func 12");
    expect(formatListing([l], { bytes: false })).toBe("+0020    call 12  → $render");
  });
});
