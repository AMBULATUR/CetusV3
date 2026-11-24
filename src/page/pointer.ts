/**
 * Pointer-path scanner ("offset finder"). Finds chains  [[base]+o1]+o2 … = target  whose root lives in
 * static memory (or in a Wasm global), so the path can be re-resolved after the game restarts even though
 * heap addresses change. Works on 32-bit memories; runs in time slices so the game keeps running.
 *
 * Algorithm: ONE pass over the heap builds a *reverse pointer map* — every 4-byte aligned word that looks
 * like a pointer, indexed by the address it points to ("target") and sorted by it. Walking a level is then
 * a binary search per frontier node (O(log N)) instead of re-scanning the whole heap per level, which is
 * what makes 512 MB – 2 GB heaps practical.
 */
export interface Chain {
  /** address of the static cell holding the first pointer (-1 when the chain is rooted in a Wasm global) */
  base: number;
  offsets: number[];
  /** Wasm global index that holds the first pointer (instead of a memory cell) */
  global?: number;
}

export interface GlobalRoot { idx: number; value: number }

export interface PtrParams {
  target: number;
  maxOff: number;
  levels: number;
  staticLo: number;
  staticHi: number;
  maxFrontier?: number;
  maxResults?: number;
  /** keep only paths whose base object (what the root cell/global points to) has a first word inside [vtLo, vtHi): a vtable in .rodata/.data */
  requireVtable?: boolean;
  vtLo?: number | undefined;
  vtHi?: number | undefined;
  /** Wasm i32 globals (already filtered to plausible pointers) that may act as chain roots */
  globals?: GlobalRoot[];
  /** safety cap on indexed pointers (8 bytes each) */
  maxPairs?: number;
}

/** Resolve a chain in the current memory. `gv` reads a Wasm global by index (needed for global-rooted chains). */
export function resolveChain(buf: ArrayBufferLike, c: Chain, gv?: (idx: number) => number | null): number | null {
  const dv = new DataView(buf);
  const len = dv.byteLength;
  if (!c.offsets.length) return null;
  let p: number;
  if (c.global !== undefined) {
    const g = gv?.(c.global);
    if (g === null || g === undefined) return null;
    p = g >>> 0;
  } else {
    if (c.base < 0 || c.base + 4 > len) return null;
    p = dv.getUint32(c.base, true);
  }
  for (let i = 0; i < c.offsets.length - 1; i++) {
    const a = p + c.offsets[i]!;
    if (a < 0 || a + 4 > len) return null;
    p = dv.getUint32(a, true);
  }
  const t = p + c.offsets[c.offsets.length - 1]!;
  return t >= 0 && t < len ? t : null;
}

// ---------------------------------------------------------------------------------------------
// Reverse pointer map
// ---------------------------------------------------------------------------------------------
const BUCKET_SHIFT = 16; // targets are bucketed by their top bits (64 KiB per bucket)
const yieldTick = () => new Promise<void>((r) => setTimeout(r, 0));

export class ReverseMap {
  /** pointer values, ascending (ties ordered by source) */
  targets = new Uint32Array(0);
  /** address of the word holding that pointer */
  sources = new Uint32Array(0);
  private bucketStart = new Uint32Array(1);
  /** pointers seen during the scan (>= length if the map was capped) */
  get length(): number { return this.targets.length; }

  /**
   * Build the map. Two scans of the heap (count, then place) + a small sort per 64 KiB target bucket, so
   * memory use is exactly 8 bytes per pointer and no single step blocks the page for long.
   * `isCancelled` / `getBuf` let the caller abort or detect memory growth.
   */
  static async build(
    getBuf: () => ArrayBufferLike,
    opts: { minVal?: number; maxPairs?: number; budgetMs?: number; isCancelled?: () => boolean; onProgress?: (f: number) => void } = {},
  ): Promise<ReverseMap | null> {
    const minVal = opts.minVal ?? 0x1000;
    const maxPairs = opts.maxPairs ?? 64_000_000;
    const budget = opts.budgetMs ?? 14;
    const buf0 = getBuf();
    const memSize = buf0.byteLength;
    const nWords = Math.floor(memSize / 4);
    const nBuckets = (memSize >>> BUCKET_SHIFT) + 1;
    const counts = new Uint32Array(nBuckets + 1);
    const cancelled = () => !!opts.isCancelled?.();
    const check = (): Uint32Array => {
      const b = getBuf();
      if (b !== buf0) throw new Error("memory grew during the scan — run it again");
      return new Uint32Array(b, 0, nWords);
    };
    const prog = (f: number) => opts.onProgress?.(f);

    // pass 1: count pointers per bucket
    let total = 0;
    for (let i = 0; i < nWords;) {
      const words = check();
      const t0 = performance.now();
      while (i < nWords) {
        const w = words[i]!;
        if (w >= minVal && w < memSize && (w & 3) === 0) { counts[w >>> BUCKET_SHIFT]!++; total++; }
        i++;
        if ((i & 0xffff) === 0 && performance.now() - t0 > budget) break;
      }
      prog((i / nWords) * 0.4);
      if (i < nWords) await yieldTick();
      if (cancelled()) return null;
    }
    if (total > maxPairs) throw new Error(`${total.toLocaleString()} pointers in memory exceeds the index cap (${maxPairs.toLocaleString()}); raise “max indexed pointers” or lower the scan range`);

    const m = new ReverseMap();
    m.targets = new Uint32Array(total);
    m.sources = new Uint32Array(total);
    const start = new Uint32Array(nBuckets + 1);
    for (let b = 0; b < nBuckets; b++) start[b + 1] = start[b]! + counts[b]!;
    const fill = start.slice(0, nBuckets);

    // pass 2: place (target, source)
    for (let i = 0; i < nWords;) {
      const words = check();
      const t0 = performance.now();
      while (i < nWords) {
        const w = words[i]!;
        if (w >= minVal && w < memSize && (w & 3) === 0) {
          const b = w >>> BUCKET_SHIFT;
          const at = fill[b]!;
          if (at < start[b + 1]!) { m.targets[at] = w; m.sources[at] = i * 4; fill[b] = at + 1; } // (guards a game that mutates memory between passes)
        }
        i++;
        if ((i & 0xffff) === 0 && performance.now() - t0 > budget) break;
      }
      prog(0.4 + (i / nWords) * 0.4);
      if (i < nWords) await yieldTick();
      if (cancelled()) return null;
    }

    // sort inside each bucket. key = low16(target) * 2^30 + sourceWord  (< 2^46, exact in a double)
    const TWO30 = 1 << 30;
    let t0 = performance.now();
    for (let b = 0; b < nBuckets; b++) {
      const s = start[b]!;
      const e = fill[b]!;
      if (e - s > 1) {
        const keys = new Float64Array(e - s);
        for (let k = s; k < e; k++) keys[k - s] = (m.targets[k]! & 0xffff) * TWO30 + (m.sources[k]! >>> 2);
        keys.sort();
        const hiBits = (b << BUCKET_SHIFT) >>> 0;
        for (let k = s; k < e; k++) {
          const key = keys[k - s]!;
          const lo = Math.floor(key / TWO30);
          m.targets[k] = (hiBits | lo) >>> 0;
          m.sources[k] = (key - lo * TWO30) * 4;
        }
      }
      if (performance.now() - t0 > budget) { prog(0.8 + (b / nBuckets) * 0.2); await yieldTick(); if (cancelled()) return null; t0 = performance.now(); }
    }
    // if memory changed between the passes some buckets are under-filled: close the gaps
    let gaps = false;
    for (let b = 0; b < nBuckets; b++) if (fill[b]! < start[b + 1]!) { gaps = true; break; }
    if (gaps) {
      let w = 0;
      const newStart = new Uint32Array(nBuckets + 1);
      for (let b = 0; b < nBuckets; b++) {
        newStart[b] = w;
        for (let k = start[b]!; k < fill[b]!; k++, w++) { m.targets[w] = m.targets[k]!; m.sources[w] = m.sources[k]!; }
      }
      newStart[nBuckets] = w;
      m.targets = m.targets.slice(0, w);
      m.sources = m.sources.slice(0, w);
      m.bucketStart = newStart;
    } else m.bucketStart = start;
    prog(1);
    return m;
  }

  /** first index whose target >= t (binary search, restricted to t's bucket) — O(log N) */
  lowerBound(t: number): number {
    const b = t >>> BUCKET_SHIFT;
    let l = this.bucketStart[Math.min(b, this.bucketStart.length - 2)] ?? 0;
    let h = this.bucketStart[Math.min(b + 1, this.bucketStart.length - 1)] ?? this.targets.length;
    if (b >= this.bucketStart.length - 1) return this.targets.length;
    while (l < h) { const mid = (l + h) >>> 1; if (this.targets[mid]! < t) l = mid + 1; else h = mid; }
    return l;
  }

  /** visit every pointer whose value is in [lo, hi] */
  forRange(lo: number, hi: number, fn: (target: number, source: number) => void): void {
    if (lo < 0) lo = 0;
    const n = this.targets.length;
    let i = this.lowerBound(lo);
    // lowerBound is bucket-local: a miss at the end of the bucket must continue into the next one
    while (i < n && this.targets[i]! < lo) i++;
    for (; i < n; i++) {
      const t = this.targets[i]!;
      if (t > hi) break;
      fn(t, this.sources[i]!);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------------------------
interface Node { a: number; suf: number[] }

export class PointerScan {
  running = false;
  progress = 0;
  level = 0;
  results: Chain[] = [];
  frontier = 0;
  capped = false;
  error: string | null = null;
  /** pointers indexed by the reverse map */
  indexed = 0;
  /** hits removed by the vtable filter */
  vtableRejected = 0;
  private cancelled = false;

  constructor(private getBuf: () => ArrayBufferLike, readonly p: PtrParams) {}

  cancel(): void { this.cancelled = true; }

  async run(budgetMs = 14): Promise<void> {
    const { maxOff, levels, staticLo, staticHi } = this.p;
    const maxFrontier = this.p.maxFrontier ?? 20000;
    const maxResults = this.p.maxResults ?? 5000;
    this.running = true;
    try {
      const map = await ReverseMap.build(this.getBuf, {
        minVal: 0x1000, ...(this.p.maxPairs !== undefined ? { maxPairs: this.p.maxPairs } : {}), budgetMs,
        isCancelled: () => this.cancelled, onProgress: (f) => { this.progress = f * 0.5; },
      });
      if (!map) return;
      this.indexed = map.length;
      const buf = this.getBuf();
      const words = new Uint32Array(buf, 0, Math.floor(buf.byteLength / 4));
      const vt = this.p.requireVtable;
      const vtLo = this.p.vtLo ?? staticLo;
      const vtHi = this.p.vtHi ?? staticHi;
      // a root object `v` (the value a static cell / global holds) passes if its first word points into static data
      const baseOk = (v: number): boolean => {
        if (!vt) return true;
        if ((v & 3) !== 0 || (v >>> 2) >= words.length) return false;
        const w = words[v >>> 2]!;
        return w >= vtLo && w < vtHi;
      };
      const roots = (this.p.globals ?? []).filter((g) => g.value >= 0x1000).sort((x, y) => x.value - y.value);
      const visited = new Uint8Array(Math.ceil(words.length / 8) + 1);
      let nodes: Node[] = [{ a: this.p.target, suf: [] }];
      const tick = (done: number) => { this.progress = 0.5 + 0.5 * ((this.level - 1 + done) / levels); };

      for (let level = 1; level <= levels && nodes.length && !this.cancelled; level++) {
        this.level = level;
        const next: Node[] = [];
        let t0 = performance.now();
        for (let ni = 0; ni < nodes.length; ni++) {
          const node = nodes[ni]!;
          const lo = node.a > maxOff ? node.a - maxOff : 0;
          map.forRange(lo, node.a, (v, src) => {
            const w = src >>> 2;
            if ((visited[w >>> 3]! >> (w & 7)) & 1) return;
            const isRoot = src >= staticLo && src < staticHi;
            // the vtable filter judges the OBJECT AT THE BASE OF THE PATH (what the static cell / global points to);
            // intermediate hops are often plain arrays or blocks without a vptr
            if (isRoot && !baseOk(v)) { this.vtableRejected++; return; }
            visited[w >>> 3]! |= 1 << (w & 7);
            const suf = [node.a - v, ...node.suf];
            if (isRoot) {
              if (this.results.length < maxResults) this.results.push({ base: src, offsets: suf });
            } else if (level < levels && next.length < maxFrontier * 4) next.push({ a: src, suf });
          });
          // Wasm globals: a global holding a pointer is a root without any memory cell
          if (roots.length) {
            let l = 0, h = roots.length;
            while (l < h) { const m = (l + h) >>> 1; if (roots[m]!.value < lo) l = m + 1; else h = m; }
            for (; l < roots.length && roots[l]!.value <= node.a; l++) {
              const g = roots[l]!;
              if (!baseOk(g.value)) { this.vtableRejected++; continue; }
              if (this.results.length < maxResults) this.results.push({ base: -1, global: g.idx, offsets: [node.a - g.value, ...node.suf] });
            }
          }
          if (performance.now() - t0 > budgetMs) {
            tick(ni / nodes.length);
            await yieldTick();
            if (this.cancelled) break;
            if (this.getBuf() !== buf) { this.error = "memory grew during the scan — run it again"; return; }
            t0 = performance.now();
          }
        }
        if (next.length > maxFrontier) {
          next.sort((x, y) => x.suf[0]! - y.suf[0]!);
          next.length = maxFrontier;
          this.capped = true;
        }
        this.frontier = next.length;
        nodes = next;
      }
      this.results.sort((x, y) => x.offsets.length - y.offsets.length || sum(x.offsets) - sum(y.offsets) || x.base - y.base || (x.global ?? -1) - (y.global ?? -1));
      this.progress = 1;
    } catch (e) {
      this.error = String((e as Error)?.message ?? e);
    } finally {
      this.running = false;
    }
  }
}

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
