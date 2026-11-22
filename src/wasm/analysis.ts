import { ModuleModel } from "./module";
import { Reader } from "./leb";
import { decode, newIns, parseBodyHeader } from "./decode";

export interface Analysis {
  callees: Map<number, number[]>;
  callers: Map<number, number[]>;
  /** i32.const value (>= 0x100) -> functions using it */
  consts: Map<number, number[]>;
  /** functions containing call_indirect */
  indirect: Set<number>;
  /** instruction count per defined function */
  insCount: Uint32Array;
  /** functions referenced by ref.func / element segments (potential indirect targets) */
  refFuncs: Set<number>;
}

export function analyze(m: ModuleModel): Analysis {
  const N0 = m.numImportedFuncs;
  const callees = new Map<number, number[]>();
  const callers = new Map<number, number[]>();
  const consts = new Map<number, number[]>();
  const indirect = new Set<number>();
  const refFuncs = new Set<number>();
  const insCount = new Uint32Array(m.bodies.length);
  const ins = newIns();
  for (let i = 0; i < m.bodies.length; i++) {
    const fi = N0 + i;
    const b = m.bodies[i]!;
    const seenC = new Set<number>();
    const seenV = new Set<number>();
    const list: number[] = [];
    try {
      const h = parseBodyHeader(m.bytes, b.start, b.end);
      const r = new Reader(m.bytes, h.codeStart, b.end);
      let n = 0;
      while (!r.eof) {
        decode(r, ins);
        n++;
        switch (ins.op.name) {
          case "call": case "return_call":
            if (!seenC.has(ins.a)) {
              seenC.add(ins.a);
              list.push(ins.a);
              let c = callers.get(ins.a);
              if (!c) callers.set(ins.a, (c = []));
              c.push(fi);
            }
            break;
          case "call_indirect": case "return_call_indirect": case "call_ref":
            indirect.add(fi);
            break;
          case "ref.func":
            refFuncs.add(ins.a);
            break;
          case "i32.const": {
            const v = ins.num >>> 0;
            if (v >= 0x100 && !seenV.has(v)) {
              seenV.add(v);
              let c = consts.get(v);
              if (!c) consts.set(v, (c = []));
              c.push(fi);
            }
            break;
          }
        }
      }
      insCount[i] = n;
    } catch {
      /* undecodable function: skip */
    }
    if (list.length) callees.set(fi, list);
  }
  return { callees, callers, consts, indirect, insCount, refFuncs };
}

/** Parse element segments' function indices (for indirect-call targets listing). */
export function funcBodySize(m: ModuleModel, funcIdx: number): number {
  const b = m.bodies[funcIdx - m.numImportedFuncs];
  return b ? b.end - b.start : 0;
}

// ---------------------------------------------------------------------------
// Static memory layout detection
// ---------------------------------------------------------------------------
export interface StaticLayout {
  /** exclusive end of the statically initialised region (data + bss), 0 if unknown */
  end: number;
  ranges: { lo: number; hi: number; via: string }[];
  source: string;
}

/**
 * Where does static memory end? Active data segments tell us for classic builds, but threaded builds
 * (shared memory) use *passive* segments that the start function copies with `memory.init` /
 * `memory.fill` using constant destinations. We read those constants from the start function and
 * the functions it calls (two levels deep, e.g. __wasm_init_memory).
 */
function directCallees(m: ModuleModel, fi: number): number[] {
  const b = m.bodies[fi - m.numImportedFuncs];
  if (!b) return [];
  const out = new Set<number>();
  const ins = newIns();
  try {
    const h = parseBodyHeader(m.bytes, b.start, b.end);
    const r = new Reader(m.bytes, h.codeStart, b.end);
    while (!r.eof) { decode(r, ins); if (ins.op.name === "call") out.add(ins.a); }
  } catch { /* ignore */ }
  return [...out];
}

export function findStaticLayout(m: ModuleModel, _A?: Analysis): StaticLayout {
  const ranges: StaticLayout["ranges"] = [];
  for (const d of m.data) if (d.mode === "active" && d.offset !== null && d.size > 0) ranges.push({ lo: d.offset, hi: d.offset + d.size, via: "active data segment" });

  const roots = new Set<number>();
  if (m.startFunc !== null) {
    roots.add(m.startFunc);
    // only the start function and its callees are decoded (cheap even for 100 MB modules)
    for (const c of directCallees(m, m.startFunc)) {
      roots.add(c);
      for (const c2 of directCallees(m, c)) roots.add(c2);
    }
  }
  // exported init helpers used by Emscripten-style runtimes
  for (const e of m.exports) if (e.kind === 0 && /^(__wasm_call_ctors|__wasm_init_memory|_initialize|__post_instantiate)$/.test(e.name)) roots.add(e.index);

  const ins = newIns();
  const hist: number[] = [];
  for (const fi of roots) {
    const b = m.bodies[fi - m.numImportedFuncs];
    if (!b) continue;
    try {
      const h = parseBodyHeader(m.bytes, b.start, b.end);
      const r = new Reader(m.bytes, h.codeStart, b.end);
      hist.length = 0;
      while (!r.eof) {
        decode(r, ins);
        const n = ins.op.name;
        if (n === "i32.const") { hist.push(ins.num >>> 0); if (hist.length > 3) hist.shift(); continue; }
        if ((n === "memory.init" || n === "memory.fill") && hist.length === 3) {
          const dest = hist[0]!;
          const size = hist[2]!;
          if (size > 0 && size < 0x40000000) ranges.push({ lo: dest, hi: dest + size, via: n });
        }
        hist.length = 0;
      }
    } catch { /* skip undecodable */ }
  }
  let end = 0;
  let source = "unknown";
  const viaInit = ranges.filter((x) => x.via !== "active data segment");
  if (viaInit.length) { end = Math.max(...viaInit.map((x) => x.hi)); source = "memory.init/fill in the start-up code"; }
  const act = ranges.filter((x) => x.via === "active data segment");
  if (act.length) {
    const e = Math.max(...act.map((x) => x.hi));
    if (e > end) { end = e; source = "active data segments"; }
  }
  return { end, ranges, source };
}
