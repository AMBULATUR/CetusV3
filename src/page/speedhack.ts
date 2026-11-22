/** Time scaling for Date.now() / performance.now() (carried over from Cetus 1.x). */
export class SpeedHack {
  multiplier = 1;
  private installed = false;
  private oldDn = Date.now;
  private oldPn = performance.now;
  private startDn = 0; private startPn = 0; private lastDn = 0; private lastPn = 0;
  private cumDn = 0; private cumPn = 0;

  install(): void {
    if (this.installed) return;
    this.installed = true;
    const self = this;
    this.oldDn = Date.now;
    this.oldPn = performance.now;
    this.startDn = this.oldDn.call(Date);
    this.startPn = this.oldPn.call(performance);
    this.lastDn = this.startDn;
    this.lastPn = this.startPn;
    Date.now = function () {
      const real = self.oldDn.call(Date);
      const el = (real - self.lastDn) * self.multiplier;
      const r = Math.floor(self.startDn + self.cumDn + el);
      self.cumDn += el;
      self.lastDn = real;
      return r;
    };
    performance.now = function () {
      const real = self.oldPn.call(performance);
      const el = (real - self.lastPn) * self.multiplier;
      const r = self.startPn + self.cumPn + el;
      self.cumPn += el;
      self.lastPn = real;
      return r;
    };
  }

  set(multiplier: number): void {
    if (!(multiplier > 0) || !Number.isFinite(multiplier)) throw new Error("multiplier must be > 0");
    this.install();
    // flush elapsed time at the old rate first
    Date.now(); performance.now();
    this.multiplier = multiplier;
  }
}
