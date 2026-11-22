import { Reader } from "./leb";
import { decode, newIns } from "./decode";

export const SEC = {
  custom: 0, type: 1, import: 2, function: 3, table: 4, memory: 5, global: 6, export: 7,
  start: 8, element: 9, code: 10, data: 11, dataCount: 12, tag: 13,
} as const;

export const SECTION_NAMES: Record<number, string> = {
  0: "custom", 1: "type", 2: "import", 3: "function", 4: "table", 5: "memory", 6: "global",
  7: "export", 8: "start", 9: "element", 10: "code", 11: "data", 12: "datacount", 13: "tag",
};

export interface Section {
  id: number;
  /** offset of the section id byte */
  start: number;
  /** payload bounds */
  payloadStart: number;
  end: number;
  /** for custom sections */
  name?: string;
}

export interface FuncType {
  params: string[];
  results: string[];
  /** raw encoding including the 0x60 form byte */
  raw: Uint8Array;
}

export interface Limits {
  min: number;
  max: number | null;
  shared: boolean;
  memory64: boolean;
}

export interface ImportEntry {
  module: string;
  field: string;
  kind: 0 | 1 | 2 | 3 | 4;
  /** func/tag: type index */
  typeIdx?: number;
  limits?: Limits;
  valType?: string;
  mutable?: boolean;
  elemType?: string;
}

export interface ExportEntry {
  name: string;
  kind: number;
  index: number;
}

export interface GlobalEntry {
  valType: string;
  mutable: boolean;
  imported: boolean;
  /** textual const init, if simple */
  init?: string;
}

export interface TableEntry {
  elemType: string;
  limits: Limits;
  imported: boolean;
}

export interface MemoryEntry {
  limits: Limits;
  imported: boolean;
}

export interface DataSegment {
  index: number;
  mode: "active" | "passive";
  memIdx: number;
  offset: number | null;
  size: number;
  /** offset of the segment's bytes inside the module */
  dataStart: number;
}

export interface Body {
  /** body range, excluding the size prefix */
  start: number;
  end: number;
}

export interface ModuleModel {
  bytes: Uint8Array;
  sections: Section[];
  types: (FuncType | null)[];
  imports: ImportEntry[];
  /** type index for every function (imports first, then defined) */
  funcTypeIdx: number[];
  numImportedFuncs: number;
  numImportedGlobals: number;
  numImportedMemories: number;
  numImportedTables: number;
  numImportedTags: number;
  tables: TableEntry[];
  memories: MemoryEntry[];
  globals: GlobalEntry[];
  exports: ExportEntry[];
  startFunc: number | null;
  data: DataSegment[];
  bodies: Body[];
  funcNames: Map<number, string>;
  moduleName?: string;
  customSections: { name: string; size: number }[];
  warnings: string[];
}

const VT: Record<number, string> = {
  0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64", 0x7b: "v128",
  0x70: "funcref", 0x6f: "externref", 0x6e: "anyref", 0x6d: "eqref", 0x6c: "i31ref", 0x71: "nullref",
  0x73: "nullfuncref", 0x72: "nullexternref", 0x69: "exnref",
  0x78: "i8", 0x77: "i16",
};

function readValType(r: Reader): string {
  const b = r.u8();
  if (b === 0x63 || b === 0x64) {
    const ht = r.s33();
    return (b === 0x63 ? "(ref null " : "(ref ") + heapName(ht) + ")";
  }
  return VT[b] ?? "0x" + b.toString(16);
}

function heapName(ht: number): string {
  if (ht >= 0) return String(ht);
  const m: Record<number, string> = {
    [-16]: "func", [-17]: "extern", [-18]: "any", [-19]: "eq", [-20]: "i31", [-21]: "struct", [-22]: "array",
    [-13]: "nofunc", [-14]: "noextern", [-15]: "none", [-23]: "exn",
  };
  return m[ht] ?? String(ht);
}

function readLimits(r: Reader): Limits {
  const flags = r.u8();
  const memory64 = (flags & 4) !== 0;
  const rd = () => (memory64 ? Number(r.u64()) : r.u32());
  const min = rd();
  const max = flags & 1 ? rd() : null;
  return { min, max, shared: (flags & 2) !== 0, memory64 };
}

function skipConstExpr(r: Reader): string | undefined {
  const ins = newIns();
  let text: string | undefined;
  let first = true;
  for (;;) {
    decode(r, ins);
    if (ins.op.name === "end") break;
    if (first) {
      if (ins.op.name === "i32.const") text = `i32.const ${ins.num}`;
      else if (ins.op.name === "i64.const") text = `i64.const ${ins.big}`;
      else if (ins.op.name === "global.get") text = `global.get ${ins.a}`;
      else if (ins.op.name === "ref.func") text = `ref.func ${ins.a}`;
      else if (ins.op.name === "ref.null") text = "ref.null";
      else if (ins.op.name === "f32.const") {
        text = "f32.const " + new DataView(ins.bytes!.buffer, ins.bytes!.byteOffset, 4).getFloat32(0, true);
      } else if (ins.op.name === "f64.const") {
        text = "f64.const " + new DataView(ins.bytes!.buffer, ins.bytes!.byteOffset, 8).getFloat64(0, true);
      } else text = ins.op.name;
      first = false;
    } else if (text) text += " …";
  }
  return text;
}

export function parseModule(bytes: Uint8Array): ModuleModel {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("not a WebAssembly binary (bad magic)");
  }
  const version = bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24);
  if (version !== 1) throw new Error("unsupported wasm version " + version);

  const m: ModuleModel = {
    bytes, sections: [], types: [], imports: [], funcTypeIdx: [],
    numImportedFuncs: 0, numImportedGlobals: 0, numImportedMemories: 0, numImportedTables: 0, numImportedTags: 0,
    tables: [], memories: [], globals: [], exports: [], startFunc: null, data: [], bodies: [],
    funcNames: new Map(), customSections: [], warnings: [],
  };

  const r = new Reader(bytes, 8);
  while (!r.eof) {
    const start = r.pos;
    const id = r.u8();
    const size = r.u32();
    const payloadStart = r.pos;
    const end = payloadStart + size;
    if (end > bytes.length) throw new RangeError(`section ${id} extends past end of module`);
    const sec: Section = { id, start, payloadStart, end };
    if (id === SEC.custom) {
      const nr = new Reader(bytes, payloadStart, end);
      sec.name = nr.name();
      m.customSections.push({ name: sec.name, size });
    }
    m.sections.push(sec);
    r.pos = end;
  }

  for (const sec of m.sections) {
    const sr = new Reader(bytes, sec.payloadStart, sec.end);
    try {
      switch (sec.id) {
        case SEC.type: {
          const n = sr.u32();
          const readComp = (): FuncType | null => {
            const form = sr.u8();
            if (form === 0x60) {
              const rs = sr.pos - 1;
              const np = sr.u32();
              const params: string[] = [];
              for (let i = 0; i < np; i++) params.push(readValType(sr));
              const nr = sr.u32();
              const results: string[] = [];
              for (let i = 0; i < nr; i++) results.push(readValType(sr));
              return { params, results, raw: bytes.subarray(rs, sr.pos) };
            }
            if (form === 0x5f) {
              const nf = sr.u32();
              for (let i = 0; i < nf; i++) {
                readValType(sr);
                sr.u8();
              }
              return null;
            }
            if (form === 0x5e) {
              readValType(sr);
              sr.u8();
              return null;
            }
            throw new Error("unknown composite type form 0x" + form.toString(16));
          };
          const readSub = (): FuncType | null => {
            const b = sr.peek();
            if (b === 0x50 || b === 0x4f) {
              sr.u8();
              const ns = sr.u32();
              for (let i = 0; i < ns; i++) sr.u32();
            }
            return readComp();
          };
          for (let i = 0; i < n; i++) {
            if (sr.peek() === 0x4e) {
              sr.u8();
              const cnt = sr.u32();
              for (let j = 0; j < cnt; j++) m.types.push(readSub());
            } else m.types.push(readSub());
          }
          break;
        }
        case SEC.import: {
          const n = sr.u32();
          for (let i = 0; i < n; i++) {
            const mod = sr.name();
            const field = sr.name();
            const kind = sr.u8();
            const e: ImportEntry = { module: mod, field, kind: kind as ImportEntry["kind"] };
            switch (kind) {
              case 0:
                e.typeIdx = sr.u32();
                m.funcTypeIdx.push(e.typeIdx);
                m.numImportedFuncs++;
                break;
              case 1:
                e.elemType = readValType(sr);
                e.limits = readLimits(sr);
                m.tables.push({ elemType: e.elemType, limits: e.limits, imported: true });
                m.numImportedTables++;
                break;
              case 2:
                e.limits = readLimits(sr);
                m.memories.push({ limits: e.limits, imported: true });
                m.numImportedMemories++;
                break;
              case 3:
                e.valType = readValType(sr);
                e.mutable = sr.u8() === 1;
                m.globals.push({ valType: e.valType, mutable: e.mutable, imported: true });
                m.numImportedGlobals++;
                break;
              case 4:
                sr.u8();
                e.typeIdx = sr.u32();
                m.numImportedTags++;
                break;
              default:
                throw new Error("unknown import kind " + kind);
            }
            m.imports.push(e);
          }
          break;
        }
        case SEC.function: {
          const n = sr.u32();
          for (let i = 0; i < n; i++) m.funcTypeIdx.push(sr.u32());
          break;
        }
        case SEC.table: {
          const n = sr.u32();
          for (let i = 0; i < n; i++) {
            let hasInit = false;
            if (sr.peek() === 0x40) {
              sr.u8();
              sr.u8();
              hasInit = true;
            }
            const et = readValType(sr);
            const lim = readLimits(sr);
            if (hasInit) skipConstExpr(sr);
            m.tables.push({ elemType: et, limits: lim, imported: false });
          }
          break;
        }
        case SEC.memory: {
          const n = sr.u32();
          for (let i = 0; i < n; i++) m.memories.push({ limits: readLimits(sr), imported: false });
          break;
        }
        case SEC.global: {
          const n = sr.u32();
          for (let i = 0; i < n; i++) {
            const vt = readValType(sr);
            const mut = sr.u8() === 1;
            const init = skipConstExpr(sr);
            m.globals.push({ valType: vt, mutable: mut, imported: false, ...(init ? { init } : {}) });
          }
          break;
        }
        case SEC.export: {
          const n = sr.u32();
          for (let i = 0; i < n; i++) {
            const name = sr.name();
            const kind = sr.u8();
            const index = sr.u32();
            m.exports.push({ name, kind, index });
          }
          break;
        }
        case SEC.start:
          m.startFunc = sr.u32();
          break;
        case SEC.code: {
          const n = sr.u32();
          for (let i = 0; i < n; i++) {
            const size = sr.u32();
            m.bodies.push({ start: sr.pos, end: sr.pos + size });
            sr.skip(size);
          }
          break;
        }
        case SEC.data: {
          const n = sr.u32();
          for (let i = 0; i < n; i++) {
            const flag = sr.u32();
            let memIdx = 0;
            let offset: number | null = null;
            let mode: "active" | "passive" = "active";
            if (flag === 1) mode = "passive";
            else {
              if (flag === 2) memIdx = sr.u32();
              const ins = newIns();
              const e = new Reader(bytes, sr.pos, sec.end);
              let k = 0;
              for (;;) {
                decode(e, ins);
                if (ins.op.name === "end") break;
                if (k++ === 0 && ins.op.name === "i32.const") offset = ins.num >>> 0;
                else if (k === 1 && ins.op.name === "i64.const") offset = Number(BigInt.asUintN(64, ins.big));
              }
              sr.pos = e.pos;
            }
            const size = sr.u32();
            m.data.push({ index: i, mode, memIdx, offset, size, dataStart: sr.pos });
            sr.skip(size);
          }
          break;
        }
        case SEC.custom:
          if (sec.name === "name") parseNameSection(m, sec);
          break;
        default:
          break;
      }
    } catch (e) {
      m.warnings.push(`section ${SECTION_NAMES[sec.id] ?? sec.id}: ${(e as Error).message}`);
    }
  }

  // memories/tables/globals defined in-module come after imports (already ordered by section order)
  return m;
}

function parseNameSection(m: ModuleModel, sec: Section): void {
  const r = new Reader(m.bytes, sec.payloadStart, sec.end);
  r.name();
  while (!r.eof) {
    const id = r.u8();
    const size = r.u32();
    const end = r.pos + size;
    try {
      const sr = new Reader(m.bytes, r.pos, end);
      if (id === 0) m.moduleName = sr.name();
      else if (id === 1) {
        const n = sr.u32();
        for (let i = 0; i < n; i++) {
          const idx = sr.u32();
          m.funcNames.set(idx, sr.name());
        }
      }
    } catch {
      /* ignore malformed name subsections */
    }
    r.pos = end;
  }
}

export function funcTypeString(t: FuncType | null | undefined): string {
  if (!t) return "(?)";
  return `(${t.params.join(", ")}) -> ${t.results.length ? t.results.join(", ") : "()"}`;
}

/** Display name for a function index: name section > export > import > func_N */
export function funcDisplayName(m: ModuleModel, idx: number): string {
  const n = m.funcNames.get(idx);
  if (n) return n;
  if (idx < m.numImportedFuncs) {
    let k = 0;
    for (const imp of m.imports) {
      if (imp.kind === 0) {
        if (k === idx) return `${imp.module}.${imp.field}`;
        k++;
      }
    }
  }
  const ex = m.exports.find((e) => e.kind === 0 && e.index === idx);
  if (ex) return ex.name;
  return `func_${idx}`;
}
