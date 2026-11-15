import { expect, it } from "vitest";
import { validMacroApp, validateMacro } from "../src/macro-model";

it("accepts Windows local EXE paths and packaged identifiers, not Mac IDs or command lines", () => {
  for (const app of [String.raw`C:\Program Files\Example\Example.exe`, String.raw`d:\Tools\サンプル.EXE`, "aumid:Example.Package_abc!App"]) {
    expect(validMacroApp(app, "windows")).toBe(true);
    expect(validateMacro({ version: 1, steps: [
      { type: "openApp", app, timeoutMs: 1000 },
      { type: "wait", ms: 10 },
      { type: "key", keys: [43], modifiers: 0, targetApp: app },
      { type: "openUrl", url: "https://example.test", app, timeoutMs: 1000 },
    ] }, "windows")).toBeNull();
    expect(validMacroApp(app, "macos")).toBe(false);
  }
  for (const app of ["org.example.App", "Example.exe", "C:/Example.exe", String.raw`\\server\share\Example.exe`, String.raw`\\?\C:\Example.exe`, String.raw`C:\..\Example.exe`, String.raw`C:\.\Example.exe`, String.raw`C:\Example.exe:stream`, String.raw`C:\Example.exe --flag`, String.raw`C:\Example.cmd`, '"C:\\Example.exe"', "aumid:LooseDesktopId", "aumid:!App", "aumid:Example!", "aumid:Example!!App", String.raw`C:\Folder.\Example.exe`, String.raw`C:\Folder \Example.exe`, "aumid:Example!App --flag", "aumid:Example!App\n"]) {
    expect(validMacroApp(app, "windows")).toBe(false);
  }
  expect(validMacroApp("org.example.App", "macos")).toBe(true);
});
it("allows unguarded Windows key steps and bounds local app identifier lengths", () => {
  expect(validateMacro({ version: 1, steps: [{ type: "key", keys: [44], modifiers: 0 }] }, "windows")).toBeNull();
  expect(validMacroApp("aumid:" + "a".repeat(253) + "!A", "windows")).toBe(true);
  expect(validMacroApp("aumid:" + "a".repeat(254) + "!A", "windows")).toBe(false);
  expect(validMacroApp("C:\\" + "a".repeat(32761) + ".exe", "windows")).toBe(false);
});
