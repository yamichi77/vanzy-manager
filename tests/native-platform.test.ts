import { expect, it } from "vitest";
import { nativePlatform } from "../src/native-platform";
it("enables only supported native platforms, never browser or iOS", () => {
  expect(nativePlatform(true, "MacIntel")).toBe("macOS");
  expect(nativePlatform(true, "Win32")).toBe("Windows");
  for (const platform of ["MacIntel", "Win32", "Linux x86_64", "iPad", "iPhone", ""])
    expect(nativePlatform(false, platform)).toBeNull();
  for (const platform of ["Linux x86_64", "iPad", "iPhone", ""])
    expect(nativePlatform(true, platform)).toBeNull();
});
