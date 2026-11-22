/**
 * Minimal MV3 service worker. All analysis state lives in the page, so this
 * only opens the Cetus workspace (tab or window) and tracks which tab hosts it.
 */
const APP = "app/index.html";

async function openApp(): Promise<void> {
  const url = chrome.runtime.getURL(APP);
  const { savedOptions } = await chrome.storage.local.get("savedOptions");
  const mode = (savedOptions as any)?.openMode ?? "tab";
  // find an already-open workspace (no "tabs" permission needed: runtime.getContexts lists our own pages)
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ["TAB"] as chrome.runtime.ContextType[] });
  const mine = ctxs.find((c) => c.documentUrl?.startsWith(url) && c.tabId >= 0);
  if (mine) {
    try {
      const tab = await chrome.tabs.update(mine.tabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch { /* tab vanished: open a new one */ }
  }
  if (mode === "window") {
    await chrome.windows.create({ url, type: "popup", width: 1280, height: 860 });
  } else {
    await chrome.tabs.create({ url });
  }
}

// Chrome-level shortcut slots (assign keys in chrome://extensions/shortcuts): run the script bound to the slot on the active tab
chrome.commands?.onCommand.addListener(async (command) => {
  const m = /^cetus-slot-(\d)$/.exec(command);
  if (!m) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id !== undefined) chrome.tabs.sendMessage(tab.id, { cetus: "runSlot", slot: Number(m[1]) }).catch(() => {});
});

(globalThis as any).cetusOpenApp = openApp; // exposed for tests
chrome.action.onClicked.addListener(() => { void openApp(); });
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus?.create?.({ id: "cetus-open", title: "Open Cetus workspace", contexts: ["action"] });
});
chrome.contextMenus?.onClicked?.addListener((info) => { if (info.menuItemId === "cetus-open") void openApp(); });
export {};
