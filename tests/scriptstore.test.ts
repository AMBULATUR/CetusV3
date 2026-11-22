import { describe, it, expect } from "vitest";
import { defaultStore, exportJson, importJson, newScript, normalizeStore, rowsForScript } from "../src/shared/scriptstore";

describe("script store", () => {
  it("seeds the example folders", () => {
    expect(defaultStore().folders.map((f) => f.name)).toEqual(["mockTesting", "UiTesting", "UserButtonTesting"]);
  });
  it("export → import round trip keeps code/hotkey, merges same-named folders, renames duplicates", () => {
    const a = defaultStore();
    const ui = a.folders[1]!;
    const s = newScript("ChangeText", "host/p", 'TextFromAddress = "x"'); s.hotkey = "Ctrl+Alt+2"; s.slot = 3;
    ui.scripts.push(s);
    const json = exportJson(a, [ui.id]);
    expect(JSON.parse(json).folders).toHaveLength(1);
    const b = defaultStore();
    const r = importJson(b, json);
    expect(r).toEqual({ folders: 0, scripts: 1, clearedKeys: 0 });
    const got = b.folders[1]!.scripts[0]!;
    expect(got).toMatchObject({ name: "ChangeText", hotkey: "Ctrl+Alt+2", slot: 3, scope: "host/p", code: 'TextFromAddress = "x"' });
    const r2 = importJson(b, json); // same file again: duplicate name + taken hotkey/slot
    expect(r2.clearedKeys).toBe(2);
    const dup = b.folders[1]!.scripts[1]!;
    expect(dup.name).toBe("ChangeText (2)");
    expect(dup.hotkey).toBe("");
    expect(dup.slot).toBe(0);
  });
  it("creates new folders on import and tolerates a single bare folder / garbage", () => {
    const b = defaultStore();
    const r = importJson(b, JSON.stringify({ name: "Extra", scripts: [{ name: "a", code: "x = 1" }] }));
    expect(r.folders).toBe(1);
    expect(b.folders.at(-1)!.scripts[0]!.name).toBe("a");
    expect(() => importJson(b, "not json")).toThrow();
    expect(normalizeStore(undefined).folders.length).toBe(3);
  });
  it("only described rows are script variables", () => {
    const rows = rowsForScript([{ desc: "Health", type: "i32", addr: 1 }, { desc: "  ", type: "i32", addr: 2 }, { desc: "Coins", type: "i32", addr: 0, ptr: { base: 1, offsets: [2] } }]);
    expect(rows.map((r) => r.label)).toEqual(["Health", "Coins"]);
    expect(rows[1]).toMatchObject({ ptr: { base: 1, offsets: [2] } });
  });
});
