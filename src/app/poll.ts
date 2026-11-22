import { getUi, isBusy, UiSettings } from "./api";

type Key = "pollCheat" | "pollMemory" | "pollScanner" | "pollDebugger";

/**
 * Single-flight background refresher. At most ONE timer and ONE request per view, the next run is
 * scheduled only after the previous finished (so a slow page can never build a request backlog), it
 * backs off while a user action is in flight, and honours the live-update settings.
 */
export function poller(key: Key, fn: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let inFlight = false;

  const runOnce = async () => {
    if (inFlight) return;
    inFlight = true;
    try { await fn(); } catch { /* target gone / transient */ } finally { inFlight = false; }
  };
  const loop = async () => {
    if (!started) return;
    const ui: UiSettings = getUi();
    const ms = ui[key];
    let next = ms > 0 ? Math.max(100, ms) : 500; // when off, re-check settings twice a second
    if (ui.live && ms > 0 && !(ui.pauseHidden && document.hidden)) {
      if (isBusy()) next = 150; // let the user's action go first
      else await runOnce();
    }
    if (started) timer = setTimeout(() => void loop(), next);
  };
  return {
    start() { if (started) return; started = true; timer = setTimeout(() => void loop(), 0); },
    stop() { started = false; if (timer) clearTimeout(timer); timer = undefined; },
    /** refresh immediately (ignores the interval, still single-flight) */
    now: runOnce,
  };
}
