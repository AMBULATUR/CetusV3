import { describe, it, expect } from "vitest";
import wabtInit from "wabt";
import { parseModule, ModuleModel, funcDisplayName } from "../src/wasm/module";
import { disassembleBody } from "../src/wasm/text";
import { buildIR } from "../src/decomp/build";
import { FuncIR, walkNodes, Node } from "../src/decomp/ir";
import { renderPseudo, renderIR, toText, Doc, NO_ANNOTATIONS } from "../src/decomp/render";
import { Annotations, moduleIdentity, emptyDB } from "../src/decomp/annotations";

const wabt = await wabtInit();
const FEAT = { simd: true, threads: true, bulk_memory: true, reference_types: true, multi_value: true, sat_float_to_int: true, sign_extension: true, tail_call: true, exceptions: true };
const compile = (wat: string): Uint8Array => wabt.parseWat("t.wat", wat, FEAT).toBinary({ write_debug_names: false }).buffer as Uint8Array;
const mod = (wat: string): ModuleModel => parseModule(compile(wat));
const STR = 'Usage: GetFontUnit("unit")';
const strAt = (a: number) => (a === 320855 ? STR : undefined);
const ir = (m: ModuleModel, i: number, cstring = strAt): FuncIR => buildIR(m, i, { funcName: (x) => funcDisplayName(m, x), cstring });
const pseudo = (wat: string, i = 0, res = NO_ANNOTATIONS): string => { const m = mod(wat); return toText(renderPseudo(ir(m, i), res, { legend: false })); };

describe("pseudocode: control flow", () => {
  it("if / else with a result, block results", () => {
    const t = pseudo(`(module (func (param i32) (result i32) local.get 0 if (result i32) i32.const 1 else i32.const 2 end))`);
    expect(t).toContain("if (p0) {");
    expect(t).toContain("} else {");
    expect(t).toMatch(/r1 = 1;[\s\S]*r1 = 2;[\s\S]*return r1;/);
  });
  it("block + br_if becomes if (!cond) when it is the only way out; flips integer comparisons", () => {
    const t = pseudo(`(module (memory 1) (func (param i32) (result i32) block local.get 0 i32.const 5 i32.lt_s br_if 0 local.get 0 i32.const 1 i32.store end i32.const 1))`);
    expect(t).toContain("if (p0 >= 5) {");
    expect(t).not.toContain("L1");
  });
  it("loops: trailing br_if -> do/while; other back edges -> while(true) with continue", () => {
    expect(pseudo(`(module (func (param i32) loop local.get 0 i32.const 1 i32.sub local.tee 0 br_if 0 end))`)).toMatch(/do \{[\s\S]*p0 = p0 - 1;[\s\S]*\} while \(p0\);/);
    const t = pseudo(`(module (func (param i32) loop local.get 0 if br 2 end br 0 end))`);
    // br 1 targets the function (return), br 0 the loop (continue)
    expect(t).toContain("while (true) {");
    expect(t).toContain("continue;");
    expect(t).toContain("return;");
  });
  it("labelled break / continue across nested constructs; br_table", () => {
    const t = pseudo(`(module (func (param i32 i32) block loop local.get 0 br_if 1 local.get 1 br_if 0 end end))`);
    expect(t).toMatch(/L1: \{[\s\S]*break L1;/);
    const bt = pseudo(`(module (func (param i32) (result i32) block block block local.get 0 br_table 0 1 2 end i32.const 10 return end i32.const 20 return end i32.const 30))`);
    expect(bt).toContain("br_table(p0) { 0: break L3; 1: break L2; default: break L1; }");
    expect(bt).toContain("return 10;");
    expect(bt).toContain("return 30;");
  });
  it("dead code after return / br is not shown", () => {
    const t = pseudo(`(module (func (result i32) i32.const 1 return i32.const 2 drop i32.const 3))`);
    expect(t).toContain("return 1;");
    expect(t).not.toContain("return 3");
  });
});

describe("pseudocode: stack, locals, memory, calls", () => {
  it("keeps evaluation order: a load is spilled before the store that follows it", () => {
    const t = pseudo(`(module (memory 1) (func (param i32) (result i32) local.get 0 i32.load local.get 0 i32.const 1 i32.store))`);
    expect(t.indexOf("t1 = *(i32*)p0;")).toBeGreaterThan(-1);
    expect(t.indexOf("t1 = *(i32*)p0;")).toBeLessThan(t.indexOf("*(i32*)p0 = 1;"));
    expect(t).toContain("return t1;");
  });
  it("a read of a local is captured before the local is reassigned", () => {
    const t = pseudo(`(module (func (param i32) (result i32) (local i32) local.get 1 i32.const 5 local.set 1 local.get 1 i32.add))`);
    expect(t).toContain("t1 = l1;");
    expect(t).toContain("return t1 + l1;");
    expect(t).toContain("i32 l1 = 0;"); // wasm zero-initialises locals
  });
  it("two calls keep their order; call arguments and multi-value results are preserved", () => {
    const t = pseudo(`(module (func $a (result i32) i32.const 1) (func $b (result i32) i32.const 2) (func (result i32) call $a call $b i32.add))`, 2);
    expect(t).toMatch(/t1 = func_0\(\);\s+return t1 \+ func_1\(\);/);
    const mv = pseudo(`(module (func $p (param i32) (result i32 i32) local.get 0 local.get 0) (func (param i32) (result i32) local.get 0 call $p i32.add))`, 1);
    expect(mv).toContain("(t1, t2) = func_0(p0);");
  });
  it("memory operations read as casts and field offsets; narrow loads keep signedness", () => {
    const t = pseudo(`(module (memory 1) (func (param i32) (result f64) local.get 0 i32.load offset=216 f32.load offset=140 f64.promote_f32 local.get 0 i32.load8_s drop local.get 0 i32.load16_u drop))`);
    expect(t).toContain("(f64)*(f32*)(*(i32*)(p0 + 216) + 140)");
    expect(t).toContain("*(i8*)p0");
    expect(t).toContain("*(u16*)p0");
  });
  it("unsigned ops are cast, float ops keep their types, types stay wasm types", () => {
    const t = pseudo(`(module (func (param i32 i32 f32 i64) (result i32) local.get 0 local.get 1 i32.lt_u drop local.get 2 f32.sqrt drop local.get 3 i32.wrap_i64 drop local.get 0 local.get 1 i32.shr_u))`);
    expect(t).toContain("(u32)p0 < (u32)p1");
    expect(t).toContain("sqrtf(p2)");
    expect(t).toContain("(i32)p3");
    expect(t).toContain("(u32)p0 >> p1");
    expect(t).toContain("f32 p2");
    expect(t).toContain("i64 p3");
  });
  it("select with a call keeps the call's effect in order", () => {
    const t = pseudo(`(module (func $a (result i32) i32.const 1) (func (param i32) (result i32) call $a i32.const 2 local.get 0 select))`, 1);
    expect(t).toContain("t1 = func_0();");
    expect(t).toContain("return p0 ? t1 : 2;");
  });
  it("unresolved callees stay func_N; names from the module are used when the module has them", () => {
    const m = mod(`(module (func $helper (export "helper") (result i32) i32.const 1) (func (result i32) call $helper call 0 drop))`);
    const t = toText(renderPseudo(ir(m, 1), NO_ANNOTATIONS, { legend: false }));
    expect(t).toContain("helper()"); // export name: confirmed by the module
  });
});

describe("types: confirmed vs inferred", () => {
  const m = mod(`(module (memory 1) (func (param i32 i32) (result i32) local.get 0 i32.load offset=4 drop local.get 1 i32.eqz drop local.get 1 i32.const 3 i32.lt_s drop i32.const 0))`);
  const f = ir(m, 0);
  it("the wasm type is exact; pointer / bool / signed are hints that say why", () => {
    const p0 = f.vars.find((v) => v.id === "p0")!, p1 = f.vars.find((v) => v.id === "p1")!;
    expect(p0.ty).toBe("i32");
    expect(p0.hints.find((h) => h.hint === "ptr")!.why).toMatch(/i32\.load/);
    expect(p1.hints.map((h) => h.hint)).toContain("signed");
    const t = toText(renderPseudo(f));
    expect(t).toContain("// p0: ptr? (inferred: used as the base address of i32.load)"); // the guess is marked with ?
    expect(t).toContain("i32 p0"); // but the declared type is the wasm type
  });
});

describe("IR", () => {
  const m = mod(`(module (memory 1) (func (param i32) (result i32) (local i32)
      local.get 0 if i32.const 1 local.set 1 else i32.const 2 local.set 1 end
      loop local.get 1 i32.const 1 i32.sub local.tee 1 br_if 0 end
      local.get 1 i32.load))`);
  const f = ir(m, 0);
  it("has basic blocks with edges, defs/uses, and offsets on every node", () => {
    expect(f.blocks.length).toBeGreaterThan(3);
    const kinds = new Set(f.blocks.flatMap((b) => b.edges.map((e) => e.kind)));
    for (const k of ["true", "false", "back", "fall"]) expect(kinds.has(k as never), k).toBe(true);
    const ids = new Set(f.blocks.map((b) => b.id));
    for (const b of f.blocks) for (const e of b.edges) expect(ids.has(e.to), `edge to bb${e.to}`).toBe(true);
    const l1 = f.vars.find((v) => v.id === "l1")!;
    expect(l1.defs).toBeGreaterThanOrEqual(3);
    expect(l1.uses).toBeGreaterThanOrEqual(2);
    walkNodes(f.tree, (n: Node) => { expect(Number.isInteger(n.off)).toBe(true); expect(typeof (n as { bb: number }).bb).toBe("number"); });
  });
  it("the IR is plain JSON (survives the page -> app message) and renders identically afterwards", () => {
    const j: FuncIR = JSON.parse(JSON.stringify(f));
    expect(toText(renderPseudo(j))).toBe(toText(renderPseudo(f)));
    expect(toText(renderIR(j))).toBe(toText(renderIR(f)));
  });
  it("IR text shows blocks, edges, stack-free statements with defs / uses / memory access", () => {
    const t = toText(renderIR(f));
    expect(t).toMatch(/bb0 .*\(entry\)/);
    expect(t).toMatch(/→ bb\d+ \(true\)/);
    expect(t).toContain("defs l1");
    expect(t).toMatch(/mem R4 @ i32\.load/);
    expect(t).toContain("i32.load(l1)");
  });
});

describe("source offsets: every view maps back to the disassembly", () => {
  const WAT = `(module (memory 1) (data (i32.const 320855) "x") (func $a (param i32) (result i32) local.get 0)
    (func (param i32 i32) (result f64) (local i32)
      local.get 0 call $a local.tee 2 i32.eqz if i32.const 320855 drop end
      block local.get 2 i32.const 5 i32.lt_s br_if 0 loop local.get 2 i32.const 1 i32.sub local.tee 2 br_if 0 end end
      local.get 1 i32.load offset=216 f32.load offset=140 f64.promote_f32))`;
  const m = mod(WAT);
  const f = ir(m, 1);
  const body = m.bodies[1 - m.numImportedFuncs]!;
  const dis = disassembleBody(m.bytes, body.start, body.end);
  const real = new Set(dis.lines.map((l) => l.off));
  const check = (d: Doc) => { for (const l of d.lines) for (const o of l.offs) expect(real.has(o), `+${o.toString(16)} is not an instruction`).toBe(true); };
  it("all offsets in pseudocode and IR are real instruction offsets of the function", () => {
    check(renderPseudo(f));
    check(renderIR(f));
  });
  it("selecting the f32.load maps to the pseudocode line and IR line that contain it, and every instruction is covered", () => {
    const loadOff = dis.lines.find((l) => l.text.startsWith("f32.load"))!.off;
    const pl = renderPseudo(f).lines.filter((l) => l.offs.includes(loadOff));
    expect(pl.length).toBeGreaterThan(0);
    expect(pl[0]!.segs.map((s) => s.t).join("")).toContain("*(f32*)");
    const segHit = pl[0]!.segs.find((s) => s.off === loadOff);
    expect(segHit?.t).toContain("*(f32*)");
    expect(renderIR(f).lines.some((l) => l.offs.includes(loadOff))).toBe(true);
    const covered = new Set([...renderPseudo(f).lines, ...renderIR(f).lines].flatMap((l) => l.offs));
    // every value-producing / effectful instruction that is not pure structure is reachable from some line
    for (const l of dis.lines) if (/^(call|i32\.load|f32\.load|local\.tee)/.test(l.text)) expect(covered.has(l.off), l.text).toBe(true);
  });
});

describe("reliability", () => {
  it("unsupported instructions stop the decompilation with a message, never invent code", () => {
    const m = mod(`(module (tag $e) (func (param i32) (result i32) local.get 0 drop try (result i32) i32.const 1 catch_all i32.const 2 end))`);
    const f = ir(m, 0);
    expect(f.incomplete?.reason).toMatch(/unsupported instruction try/);
    const t = toText(renderPseudo(f, NO_ANNOTATIONS, { legend: false }));
    expect(t).toContain("decompilation stopped at +");
    expect(t).toContain("is not shown");
  });
  it("SIMD / atomics / bulk memory have known stack effects and are shown as named operations", () => {
    const m = mod(`(module (memory 1 1 shared) (func (param i32) (result i32) local.get 0 v128.load drop local.get 0 i32.const 1 i32.atomic.rmw.add local.get 0 i32.const 0 i32.const 4 memory.fill))`);
    const t = toText(renderPseudo(ir(m, 0), NO_ANNOTATIONS, { legend: false }));
    expect(t).toContain("*(v128*)p0");
    expect(t).toContain("i32_atomic_rmw_add(p0, 1)");
    expect(t).toContain("memory_fill(p0, 0, 4);");
    expect(ir(m, 0).incomplete).toBeUndefined();
  });
  it("a function with no body / a bad index is rejected, a huge body is cut off gracefully", () => {
    const m = mod(`(module (import "env" "f" (func)) (func))`);
    expect(() => buildIR(m, 0)).toThrow(/no body/);
    const big = mod(`(module (func ${"nop ".repeat(50)}))`);
    expect(buildIR(big, 0, { maxInstructions: 10 }).incomplete?.reason).toMatch(/too large/);
  });
  it("the same function always decompiles to the same text (deterministic)", () => {
    const m = mod(`(module (func (param i32) (result i32) local.get 0 if (result i32) i32.const 1 else i32.const 2 end))`);
    expect(toText(renderPseudo(ir(m, 0)))).toBe(toText(renderPseudo(ir(m, 0))));
  });
});

describe("annotations: names, strings, constants, comments", () => {
  const WAT = `(module (memory 1) (data (i32.const 320855) "Usage: GetFontUnit(\\"unit\\")\\00")
    (func $isValid (param i32) (result i32) local.get 0)
    (func $getObj (param i32) (result i32) local.get 0)
    (func $push (param i32 i32) nop)
    (func (param i32) i32.const 320855 local.get 0 call $isValid call $push)
    (func (param i32) local.get 0 call $getObj drop i32.const 320855 i32.const 7 call $push))`;
  const m = mod(WAT);
  const id = moduleIdentity(m.bytes);
  const f3 = ir(m, 3), f4 = ir(m, 4);

  it("renaming a function once updates every function that calls it (project level); original index kept", () => {
    const a = new Annotations(emptyDB(id));
    a.setFuncName(2, "PushNumberResult", "confirmed");
    a.setFuncName(0, "IsValidUnit", "inferred");
    const t3 = toText(renderPseudo(f3, a, { legend: false })), t4 = toText(renderPseudo(f4, a, { legend: false }));
    expect(t3).toContain("PushNumberResult(");
    expect(t4).toContain("PushNumberResult(");
    expect(t3).toContain("IsValidUnit(p0)");
    expect(t3).not.toContain("func_2");
    // the legend of the function lists the original wasm index; the IR view still names the callee by the same project name
    expect(toText(renderIR(f3, a))).toContain("PushNumberResult");
    expect(f3.callees.map((c) => c.index).sort()).toEqual([0, 2]);
    // unresolved callee stays func_N
    expect(t4).toContain("func_1(p0)");
  });
  it("confirmed and inferred names are distinguishable in the output", () => {
    const a = new Annotations(emptyDB(id));
    a.setFuncName(2, "PushNumberResult", "confirmed");
    a.setFuncName(0, "IsValidUnit", "inferred");
    const d = renderPseudo(f3, a);
    const segs = d.lines.flatMap((l) => l.segs);
    expect(segs.find((s) => s.t === "IsValidUnit")!.conf).toBe("inferred");
    expect(segs.find((s) => s.t === "IsValidUnit")!.cls).toContain("sym-inferred");
    expect(segs.find((s) => s.t === "PushNumberResult")!.conf).toBe("confirmed");
    expect(a.symbols().map((s) => [s.name, s.conf])).toEqual(expect.arrayContaining([["PushNumberResult", "confirmed"], ["IsValidUnit", "inferred"]]));
    expect(toText(d)).toContain("inferred");
  });
  it("strings are detected; one shared label per address; original address and text stay visible", () => {
    const a = new Annotations(emptyDB(id));
    const raw = toText(renderPseudo(f3, a, { legend: false }));
    expect(raw).toContain(JSON.stringify(STR));
    expect(raw).toContain("@0x4e557");
    a.setString(320855, { name: "STR_USAGE_GET_FONT_UNIT", conf: "confirmed", comment: "usage text" });
    for (const f of [f3, f4]) {
      const t = toText(renderPseudo(f, a, { legend: false }));
      expect(t).toContain("STR_USAGE_GET_FONT_UNIT /* 0x4e557 ");
      expect(t).toContain(JSON.stringify(STR)); // the string content remains accessible
    }
    expect(a.constComment(320855)).toBe("usage text");
  });
  it("constants: shared by value or by single instruction; instruction-level wins", () => {
    const a = new Annotations(emptyDB(id));
    a.setConst(7, { name: "MAX_RETRIES", conf: "inferred" });
    expect(toText(renderPseudo(f4, a, { legend: false }))).toContain("MAX_RETRIES /* 0x7 */");
    const off7 = (() => { let o = -1; walkNodes(f4.tree, (n) => { if (n.k === "expr") o = o; }); const body = m.bodies[4 - m.numImportedFuncs]!; return disassembleBody(m.bytes, body.start, body.end).lines.find((l) => l.text === "i32.const 7")!.off; })();
    a.setIns(4, off7, { name: "RETRY_LIMIT", conf: "confirmed" });
    const t = toText(renderPseudo(f4, a, { legend: false }));
    expect(t).toContain("RETRY_LIMIT /* 0x7 */");
    expect(t).not.toContain("MAX_RETRIES");
  });
  it("instruction comments, variable names and declared types, signatures, field names", () => {
    const a = new Annotations(emptyDB(id));
    const body = m.bodies[3 - m.numImportedFuncs]!;
    const callOff = disassembleBody(m.bytes, body.start, body.end).lines.find((l) => l.text.startsWith("call 0"))!.off;
    a.setIns(3, callOff, { comment: "validates the unit id" });
    a.setVar(3, "p0", { name: "unit", type: "Unit*" });
    a.setFuncSig(3, { ret: "bool", params: [{ type: "Unit*", name: "unit" }] });
    a.setFuncName(3, "ChangeFontUnit");
    const t = toText(renderPseudo(f3, a));
    expect(t).toContain("// validates the unit id");
    expect(t).toContain("bool ChangeFontUnit(Unit* unit)");
    expect(t).toContain("signature declared by the user");
    expect(t).toContain("(unit)"); // variable renamed in the body
    const fm = mod(`(module (memory 1) (func (param i32) (result f32) local.get 0 f32.load offset=140))`);
    const fa = new Annotations(emptyDB(moduleIdentity(fm.bytes)));
    fa.setField(140, { name: "health", conf: "inferred" });
    expect(toText(renderPseudo(ir(fm, 0), fa, { legend: false }))).toContain("p0 + 140 /*.health?*/");
  });
  it("clearing a name removes the entry; empty annotations leave the output untouched", () => {
    const a = new Annotations(emptyDB(id));
    const before = toText(renderPseudo(f3, a));
    a.setFuncName(2, "X"); a.setFuncName(2, "");
    a.setString(320855, { name: "S" }); a.setString(320855, { name: "" });
    expect(a.isEmpty()).toBe(true);
    expect(toText(renderPseudo(f3, a))).toBe(before);
  });
});

describe("annotation persistence and module identity", () => {
  const m1 = mod(`(module (func $a (param i32) (result i32) local.get 0) (func (result i32) i32.const 1 call $a))`);
  const m2 = mod(`(module (func $a (param i32) (result i32) local.get 0 i32.const 1 i32.add) (func (result i32) i32.const 1 call $a))`);
  it("identity is stable for the same bytes and differs for different modules", () => {
    expect(moduleIdentity(m1.bytes)).toBe(moduleIdentity(m1.bytes.slice()));
    expect(moduleIdentity(m1.bytes)).not.toBe(moduleIdentity(m2.bytes));
    const odd = new Uint8Array(m1.bytes.length + 3); odd.set(m1.bytes);
    expect(moduleIdentity(odd)).not.toBe(moduleIdentity(m1.bytes));
  });
  it("round-trips through JSON (storage) and survives a 'reload' of the same module", () => {
    const id = moduleIdentity(m1.bytes);
    const a = new Annotations(emptyDB(id));
    a.setFuncName(0, "Double", "confirmed"); a.setString(4096, { name: "S", comment: "c" }); a.setIns(1, 2, { comment: "hello" }); a.setVar(1, "l0", { name: "x" });
    const stored = JSON.parse(JSON.stringify(a.toJSON()));
    const b = Annotations.fromJSON(stored, id);
    expect(b.symbols()).toEqual(a.symbols());
    expect(b.insComment(1, 2)).toBe("hello");
    expect(toText(renderPseudo(ir(m1, 1), b, { legend: false }))).toContain("Double(1)");
  });
  it("annotations of a different module are never applied; imports must match the module", () => {
    const a = new Annotations(emptyDB(moduleIdentity(m1.bytes)));
    a.setFuncName(0, "Double");
    const other = Annotations.fromJSON(JSON.parse(JSON.stringify(a.toJSON())), moduleIdentity(m2.bytes));
    expect(other.isEmpty()).toBe(true);
    expect(Annotations.matches(a.toJSON(), moduleIdentity(m2.bytes))).toBe(false);
    expect(Annotations.matches(a.toJSON(), moduleIdentity(m1.bytes))).toBe(true);
    expect(toText(renderPseudo(ir(m2, 1), other, { legend: false }))).toContain("func_0(1)");
  });
  it("applying annotations never changes the module bytes", () => {
    const before = m1.bytes.slice();
    const a = new Annotations(emptyDB(moduleIdentity(m1.bytes)));
    a.setFuncName(0, "Z"); renderPseudo(ir(m1, 1), a); renderIR(ir(m1, 1), a);
    expect(Array.from(m1.bytes)).toEqual(Array.from(before));
  });
  it("merge keeps both sides; change listeners fire", () => {
    const id = moduleIdentity(m1.bytes);
    const a = new Annotations(emptyDB(id)); const b = new Annotations(emptyDB(id));
    a.setFuncName(0, "A"); b.setFuncName(1, "B"); b.setFuncName(0, "A2");
    let n = 0; a.onChange(() => n++);
    a.merge(b.toJSON());
    expect(a.db.funcs[0]!.name).toBe("A2");
    expect(a.db.funcs[1]!.name).toBe("B");
    expect(n).toBe(1);
  });
});
