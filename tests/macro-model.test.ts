import { describe, expect, it } from "vitest";
import {
  emptyMacro,
  moveMacroStep,
  validMacroBindings,
  validateMacro,
  validMacroUrl,
  type MacroDefinition,
} from "../src/macro-model";
const key = { type: "key" as const, keys: [4, 5], modifiers: 0 };
const macro: MacroDefinition = {
  version: 1,
  steps: [
    key,
    { type: "wait", ms: 100 },
    { type: "openApp", app: "org.vendor.App", timeoutMs: 1000 },
  ],
};
describe("host-only macro schema", () => {
  it("preserves chords, order and data without migration writes", () => {
    const copy = JSON.stringify(macro);
    expect(validateMacro(macro)).toBeNull();
    expect(JSON.stringify(macro)).toBe(copy);
    expect(validMacroBindings([{ index: 1, macro }])).toBe(true);
    expect(
      validMacroBindings([
        { index: 1, macro },
        { index: 1, macro },
      ]),
    ).toBe(false);
  });
  it("rejects unknown versions, empty, overlong, duplicate keys, bad values", () => {
    for (const m of [
      emptyMacro(),
      { ...macro, version: 2 },
      { ...macro, steps: Array(33).fill(key) },
      { ...macro, steps: [{ ...key, keys: [4, 4] }] },
      { ...macro, steps: [{ type: "wait", ms: NaN }] },
      {
        ...macro,
        steps: [
          { type: "wait", ms: 5001 },
          { type: "wait", ms: 5000 },
        ],
      },
    ])
      expect(validateMacro(m)).not.toBeNull();
  });
  it("bounds the configured total execution budget", () => {
    expect(
      validateMacro({
        version: 1,
        steps: Array(7).fill({
          type: "openApp",
          app: "org.vendor.App",
          timeoutMs: 10000,
        }),
      }),
    ).not.toBeNull();
    expect(
      validateMacro({
        version: 1,
        steps: Array(6).fill({
          type: "openApp",
          app: "org.vendor.App",
          timeoutMs: 10000,
        }),
      }),
    ).toBeNull();
  });
  it("requires exact app IDs and bounded launch waits", () => {
    for (const app of [
      "",
      "App",
      "org..App",
      "org.vendor.App --flag",
      "/Applications/App.app",
    ])
      expect(
        validateMacro({
          ...macro,
          steps: [{ type: "openApp", app, timeoutMs: 1000 }],
        }),
      ).not.toBeNull();
    expect(
      validateMacro({
        ...macro,
        steps: [{ type: "openApp", app: "org.vendor.App", timeoutMs: 10001 }],
      }),
    ).not.toBeNull();
  });
  it("rejects unsafe URLs without revealing values", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///tmp/x",
      "osascript:run",
      "https://user:secret@host.test", // betterleaks:allow -- synthetic rejected-credential fixture on reserved .test domain
      "https://host.test/ bad",
      "bad url",
      "data:text/plain,secret",
    ])
      expect(validMacroUrl(url)).toBe(false);
    expect(validMacroUrl("https://host.test/path")).toBe(true);
    expect(validMacroUrl("vendor-app://route")).toBe(true);
  });
  it("allows URL, configured wait, and key sequences", () => {
    const open = {
      type: "openUrl" as const,
      url: "https://host.test",
      app: "org.vendor.App",
      timeoutMs: 1000,
    };
    expect(validateMacro({ ...macro, steps: [open] })).toBeNull();
    expect(
      validateMacro({
        ...macro,
        steps: [open, { type: "wait", ms: 100 }, key],
      }),
    ).toBeNull();
    expect(
      validateMacro({
        ...macro,
        steps: [
          open,
          { type: "openApp", app: "org.vendor.App", timeoutMs: 1000 },
          key,
        ],
      }),
    ).toBeNull();
  });
  it("keeps optional key target conditions unset for legacy data", () => {
    expect(validateMacro({ version: 1, steps: [key] })).toBeNull();
    expect(key).not.toHaveProperty("targetApp");
    expect(
      validateMacro({
        version: 1,
        steps: [{ ...key, targetApp: "org.vendor.App" }],
      }),
    ).toBeNull();
    for (const targetApp of ["", "App", "org..App", null, 42]) {
      expect(
        validateMacro({ version: 1, steps: [{ ...key, targetApp }] }),
      ).not.toBeNull();
    }
  });
  it("reorders immutably and ignores out of range moves", () => {
    const moved = moveMacroStep(macro, 0, 2);
    expect(moved.steps[2]).toEqual(key);
    expect(macro.steps[0]).toEqual(key);
    expect(moveMacroStep(macro, -1, 2)).toBe(macro);
  });
});
