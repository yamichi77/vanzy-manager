import { expect, it } from "vitest";
import { macroKeyDraft, updateMacroKey } from "../src/macro-key-adapter";
it("round trips ordinary chords, GUI-only and unknown display usages without losing target", () => {
  for (const step of [
    {
      type: "key" as const,
      keys: [4, 5],
      modifiers: 3,
      targetApp: "org.test.App",
    },
    { type: "key" as const, keys: [], modifiers: 8 },
    { type: "key" as const, keys: [0x65], modifiers: 0 },
  ])
    expect(updateMacroKey(step, macroKeyDraft(step))).toEqual(step);
});
it("maps selected/captured keys while preserving optional target", () => {
  expect(
    updateMacroKey(
      { type: "key", keys: [4], modifiers: 0, targetApp: "org.test.App" },
      { codes: ["KeyA", "KeyB"], mask: 8 },
    ),
  ).toEqual({
    type: "key",
    keys: [4, 5],
    modifiers: 8,
    targetApp: "org.test.App",
  });
});
