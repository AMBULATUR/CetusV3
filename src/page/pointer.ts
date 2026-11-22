/**
 * Pointer-path scanner ("offset finder"). Finds chains  [[base]+o1]+o2 … = target  whose first cell
 * (`base`) lives in static memory, so the path can be re-resolved after the game restarts even
 * though heap addresses change. Works on 32-bit memories; runs in time slices so the game keeps running.
 */
export interface Chain { base: number; offsets: number[] }

export interface PtrParams {
  target: number;
  maxOff: number;
  levels: number;
  staticLo: number;
  staticHi: number;
  maxFrontier?: number;
  maxResults?: number;
}

export function resolveChain(buf: ArrayBufferLike, c: Chain): number | null {
  const dv = new DataView(buf);
  const len = dv.byteLength;
  if (c.base < 0 || c.base + 4 > len || !c.offsets.length) return null;
  let p = dv.getUint32(c.base, true);
  for (let i = 0; i < c.offsets.length - 1; i++) {
    const a = p + c.offsets[i]!;
    if (a < 0 || a + 4 > len) return null;
    p = dv.getUint32(a, true);
  }
  const t = p + c.offsets[c.offsets.length - 1]!;
  return t >= 0 && t < len ? t : null;
}

interface Node { a: number; suf: number[] }

export class PointerScan {
  running = false;
  progress = 0;
  level = 0;
  results: Chain[] = [];
  frontier = 0;
  capped = false;
  error: string | null = null;
  private cancelled = false;

  constructor(private getBuf: () => ArrayBufferLike, readonly p: PtrParams) {}

  cancel(): void { this.cancelled = true; }

  async run(budgetMs = 14): Promise<void> {
    const { maxOff, levels, staticLo, staticHi } = this.p;
    const maxFrontier = this.p.maxFrontier ?? 20000;
    const maxResults = this.p.maxResults ?? 5000;
    this.running = true;
    let nodes: Node[] = [{ a: this.p.target, suf: [] }];
    const visited = new Uint8Array(Math.ceil(Math.floor(this.getBuf().byteLength / 4) / 8) + 1);
    const seen = (w: number) => (visited[w >>> 3]! >> (w & 7)) & 1;
    const mark = (w: number) => { visited[w >>> 3]! |= 1 << (w & 7); };
    try {
      for (let level = 1; level <= levels && nodes.length && !this.cancelled; level++) {
        this.level = level;
        nodes.sort((x, y) => x.a - y.a);
        const addrs = Uint32Array.from(nodes.map((n) => n.a));
        const minA = addrs[0]!;
        const maxA = addrs[addrs.length - 1]!;
        const next: Node[] = [];
        const buf0 = this.getBuf();
        const nWords = Math.floor(buf0.byteLength / 4);
        let i = 0;
        while (i < nWords && !this.cancelled) {
          const buf = this.getBuf();
          if (buf !== buf0) { this.error = "memory grew during the scan — run it again"; return; }
          const words = new Uint32Array(buf, 0, nWords);
          const t0 = performance.now();
          const lo = minA > maxOff ? minA - maxOff : 0;
          while (i < nWords) {
            const w = words[i]!;
            if (w >= lo && w <= maxA) {
              // first node with a >= w
              let l = 0, h = addrs.length;
              while (l < h) { const m = (l + h) >>> 1; if (addrs[m]! < w) l = m + 1; else h = m; }
              if (l < addrs.length && addrs[l]! - w <= maxOff) {
                const x = i * 4;
                if (!seen(i)) {
                  const node = nodes[l]!;
                  const suf = [node.a - w, ...node.suf];
                  if (x >= staticLo && x < staticHi) {
                    if (this.results.length < maxResults) this.results.push({ base: x, offsets: suf });
                  } else if (level < levels && next.length < maxFrontier * 4) {
                    next.push({ a: x, suf });
                  }
                  mark(i);
                }
              }
            }
            i++;
            if ((i & 0x3fff) === 0 && performance.now() - t0 > budgetMs) break;
          }
          this.progress = ((level - 1) + i / nWords) / levels;
          if (i < nWords) await new Promise((r) => setTimeout(r, 0));
        }
        if (next.length > maxFrontier) {
          next.sort((x, y) => x.suf[0]! - y.suf[0]!);
          next.length = maxFrontier;
          this.capped = true;
        }
        this.frontier = next.length;
        nodes = next;
      }
      this.results.sort((x, y) => x.offsets.length - y.offsets.length || sum(x.offsets) - sum(y.offsets) || x.base - y.base);
      this.progress = 1;
    } catch (e) {
      this.error = String((e as Error)?.message ?? e);
    } finally {
      this.running = false;
    }
  }
}

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
