import { expect, it } from "vitest";
import { currentDescription } from "../src/DevicePanel";
import {
  firmwareDefaultMap,
  supportsFirmwareDefaults,
} from "../src/firmware-defaults";

it("uses the firmware initialization table, not the current arrow-only mapping", () => {
  expect(
    Array.from({ length: 11 }, (_, i) =>
      firmwareDefaultMap(i + 1)?.slice(0, 3),
    ),
  ).toEqual([
    [5, 0, 80],
    [5, 0, 79],
    [5, 8, 43],
    [5, 0, 40],
    [4, 1, 0],
    [4, 0, 0],
    [4, 3, 0],
    [1, 22, 0],
    [1, 24, 0],
    [1, 16, 0],
    [1, 17, 0],
  ]);
  for (let i = 1; i <= 11; i++)
    expect(firmwareDefaultMap(i)?.slice(3)).toEqual(Array(12).fill(0));
  expect(firmwareDefaultMap(0)).toBeNull();
  expect(firmwareDefaultMap(12)).toBeNull();
  expect(
    supportsFirmwareDefaults({ product: "VANZY#1-0000/A2", firmware: "3.2.1" }),
  ).toBe(true);
  expect(
    supportsFirmwareDefaults({ product: "different", firmware: "3.2.1" }),
  ).toBe(false);
  expect(
    supportsFirmwareDefaults({ product: "VANZY#1-0000/A2", firmware: "other" }),
  ).toBe(false);
});

it("names verified empty, mouse, and media forms without guessing unknown or compound actions", () => {
  expect(currentDescription(Array(15).fill(0))).toBe("未割当");
  expect(currentDescription(firmwareDefaultMap(3)!)).toBe("Win + Tab");
  expect(currentDescription(firmwareDefaultMap(5)!)).toBe("音量を下げる");
  expect(currentDescription(firmwareDefaultMap(8)!)).toBe("左クリック");
  expect(currentDescription(firmwareDefaultMap(10)!)).toContain("ホイール＋");
  const compound = firmwareDefaultMap(5)!;
  compound[3] = 5;
  expect(currentDescription(compound)).toContain("未対応");
  expect(currentDescription([1, 99, ...Array(13).fill(0)])).toContain("未対応");
});

it("supports other A2 device suffixes while rejecting other families and firmware", () => {
  for (const product of ["VANZY#1-FFFF/A2", "VANZY#1-1234/A2"]) {
    expect(supportsFirmwareDefaults({product, firmware: "3.2.1"})).toBe(true);
  }
  for (const product of ["", "VANZY", "VANZY#2-0000/A2", "VANZY#1-0000/A3", "VANZY#1-000/A2", "VANZY#1-00000/A2", "VANZY#1-gggg/A2", "VANZY#1-ffff/A2", "VANZY#1-0000/A2\n"]) {
    expect(supportsFirmwareDefaults({product, firmware: "3.2.1"})).toBe(false);
  }
  expect(supportsFirmwareDefaults(null)).toBe(false);
});
