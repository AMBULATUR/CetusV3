/**
 * JS side of the shared-memory watch table (see CTRL in ../wasm/rewrite.ts).
 *
 * Arming a watchpoint = writing words into the control block. Because the block lives in linear memory
 * (a SharedArrayBuffer for threaded builds) every thread's instrumented code sees the change at once; no
 * postMessage round trip and no per-instance global to keep in sync.
 */
import { CTRL } from "../wasm/rewrite";

export interface RingHit {
  /** 1 = read, 2 = write */
  kind: 1 | 2;
  slot: number;
  /** effective address (reads) or the watched address (writes) */
  ea: number;
  /** ORIGINAL function index that performed the access */
  func: number;
  /** byte offset of the instruction inside that function's body (original module) */
  off: number;
  seq: number;
}

export class WatchMem {
  /** next ring sequence number this reader has not consumed yet */
  private tail = 0;
  /** hits that were overwritten before we could read them (ring is small; threads can outrun the poller) */
  lost = 0;

  constructor(private readonly memory: WebAssembly.Memory, readonly ctrl: number) {}

  private i32(): Int32Array { return new Int32Array(this.memory.buffer); }
  private shared(): boolean { return typeof SharedArrayBuffer !== "undefined" && this.memory.buffer instanceof SharedArrayBuffer; }
  private rd(a: Int32Array, byteAddr: number): number { return this.shared() ? Atomics.load(a, byteAddr >> 2) : a[byteAddr >> 2]!; }
  private wr(a: Int32Array, byteAddr: number, v: number): void { if (this.shared()) Atomics.store(a, byteAddr >> 2, v); else a[byteAddr >> 2] = v; }

  private slotAddr(s: number): number { return this.ctrl + CTRL.SLOTS + s * CTRL.SLOT_STRIDE; }

  /** Stamp the magic word (fresh memory is zero). Safe to call repeatedly. */
  init(): void { this.wr(this.i32(), this.ctrl, CTRL.MAGIC | 0); }

  /** Arm slot `s`. The flags word is written last, so a thread never sees a half-written slot as armed. */
  arm(s: number, addr: number, size: number, flags: number, value: bigint): void {
    const a = this.i32();
    const b = this.slotAddr(s);
    this.wr(a, b + 8, 0);
    this.wr(a, b, addr | 0);
    this.wr(a, b + 4, size);
    const v = BigInt.asUintN(64, value);
    this.wr(a, b + 16, Number(v & 0xffffffffn) | 0);
    this.wr(a, b + 20, Number(v >> 32n) | 0);
    this.wr(a, b + 8, flags);
  }
  disarm(s: number): void { this.wr(this.i32(), this.slotAddr(s) + 8, 0); }
  setEnables(write: boolean, read: boolean): void {
    const a = this.i32();
    this.wr(a, this.ctrl + CTRL.WEN, write ? 1 : 0);
    this.wr(a, this.ctrl + CTRL.REN, read ? 1 : 0);
  }
  /** i64 the freeze logic currently holds for slot `s` */
  slotValue(s: number): bigint {
    const a = this.i32();
    const b = this.slotAddr(s) + 16;
    return (BigInt(this.rd(a, b + 4)) << 32n) | BigInt(this.rd(a, b) >>> 0);
  }

  /** Consume every committed ring entry written since the last call. */
  drain(): RingHit[] {
    const a = this.i32();
    const head = this.rd(a, this.ctrl + CTRL.HEAD) >>> 0;
    const out: RingHit[] = [];
    // anything older than one ring length was overwritten
    if (head - this.tail > CTRL.RING_N) { this.lost += head - this.tail - CTRL.RING_N; this.tail = head - CTRL.RING_N; }
    while (this.tail < head) {
      const seq = this.tail;
      const e = this.ctrl + CTRL.RING + (seq & (CTRL.RING_N - 1)) * CTRL.RING_STRIDE;
      const commit = this.rd(a, e + 16) >>> 0;
      if (commit === ((seq + 1) >>> 0)) {
        const w0 = a[e >> 2]!;
        out.push({ kind: (w0 & 0xff) as 1 | 2, slot: (w0 >> 8) & 0xff, ea: a[(e + 4) >> 2]! >>> 0, func: a[(e + 8) >> 2]!, off: a[(e + 12) >> 2]!, seq });
      } else if (commit > ((seq + 1) >>> 0) || head - seq > CTRL.RING_N) {
        this.lost++; // overwritten by a later lap
      } else break; // the writer claimed this entry but has not committed yet: pick it up next poll
      this.tail++;
    }
    return out;
  }
  /** total hits ever claimed (including ones we lost) */
  total(): number { return this.rd(this.i32(), this.ctrl + CTRL.HEAD) >>> 0; }
}
