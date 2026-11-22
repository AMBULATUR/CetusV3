import { describe, it, expect } from "vitest";
import { parseAddressExpr, formatChain } from "../src/shared/addrexpr";
import { normalizeCombo, comboFromEvent } from "../src/shared/hotkey";

describe("address expressions", () => {
  it("plain and arithmetic", () => {
    expect(parseAddressExpr("0x1234")).toEqual({ kind: "addr", addr: 0x1234 });
    expect(parseAddressExpr("4660")).toEqual({ kind: "addr", addr: 4660 });
    expect(parseAddressExpr("0x1000 + 0x20 - 0x10")).toEqual({ kind: "addr", addr: 0x1010 });
  });
  it("the 4-level example from the request", () => {
    const r = parseAddressExpr("[[[[0x4a2220]+0x34]+0x24]+0xd8]+0x18");
    expect(r).toEqual({ kind: "ptr", chain: { base: 0x4a2220, offsets: [0x34, 0x24, 0xd8, 0x18] } });
    expect(formatChain((r as any).chain)).toBe("[[[[0x4a2220]+0x34]+0x24]+0xd8]+0x18");
  });
  it("single hop, no trailing offset, spaces, negatives, arithmetic inside", () => {
    expect(parseAddressExpr("[0x100]")).toEqual({ kind: "ptr", chain: { base: 0x100, offsets: [0] } });
    expect(parseAddressExpr(" [ [0x100] + 8 ] + 0x10 ")).toEqual({ kind: "ptr", chain: { base: 0x100, offsets: [8, 0x10] } });
    expect(parseAddressExpr("[[0x100]-0x8]+4")).toEqual({ kind: "ptr", chain: { base: 0x100, offsets: [-8, 4] } });
    expect(parseAddressExpr("[0x1000+0x20]+4")).toEqual({ kind: "ptr", chain: { base: 0x1020, offsets: [4] } });
    expect(parseAddressExpr("[[0x100]+4+8]+0")).toEqual({ kind: "ptr", chain: { base: 0x100, offsets: [12, 0] } });
  });
  it("rejects garbage with a useful message", () => {
    expect(() => parseAddressExpr("[0x100")).toThrow(/missing \]/);
    expect(() => parseAddressExpr("")).toThrow();
    expect(() => parseAddressExpr("0x10 zz")).toThrow(/unexpected/);
    expect(() => parseAddressExpr("hello")).toThrow();
  });
});

describe("hotkeys", () => {
  it("normalises typed combos", () => {
    expect(normalizeCombo("Ctrl-Alt-2")).toBe("Ctrl+Alt+2");
    expect(normalizeCombo("alt+ctrl+f5")).toBe("Ctrl+Alt+F5");
    expect(normalizeCombo("shift + a")).toBe("Shift+A");
    expect(normalizeCombo("ctrl+space")).toBe("Ctrl+Space");
    expect(normalizeCombo("ctrl")).toBe("");
  });
  it("matches real key events regardless of keyboard layout / AltGr output", () => {
    const ev = (o: any) => ({ code: "", key: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });
    expect(comboFromEvent(ev({ code: "Digit2", key: "@", ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+2");
    expect(comboFromEvent(ev({ code: "KeyQ", key: "q", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+Q");
    expect(comboFromEvent(ev({ code: "ControlLeft", key: "Control", ctrlKey: true }))).toBe("");
    expect(comboFromEvent(ev({ code: "F5", key: "F5", altKey: true }))).toBe("Alt+F5");
  });
});
