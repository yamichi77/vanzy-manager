/** Official FW 3.2.1 initialization values, not the user's current map or an app preset.
 * Evidence: docs/FIRMWARE-DEFAULTS-3.2.1.md. This does not reset a device.
 */
export const FIRMWARE_DEFAULT_CODE = "FirmwareDefault";
const prefixes = [
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
] as const;

export function firmwareDefaultMap(index: number): number[] | null {
  const prefix = Number.isInteger(index) ? prefixes[index - 1] : undefined;
  return prefix ? [...prefix, ...Array<number>(12).fill(0)] : null;
}

export function supportsFirmwareDefaults(
  device: { product: string; firmware: string } | null,
) {
  return !!device && /^VANZY#1-[0-9A-F]{4}\/A2$/.test(device.product) && device.product.length === 15 && device.firmware === "3.2.1";
}

/** Name only exact forms established by the official category and HID dispatch code. */
export function builtinActionDescription(bytes: number[]): string | null {
  if (bytes.length !== 15) return null;
  if (bytes.every((v) => v === 0)) return "未割当";
  if (!bytes.slice(2).every((v) => v === 0)) return null;
  return (
    (
      {
        "4:1": "音量を下げる",
        "4:0": "音量を上げる",
        "4:3": "再生 / 一時停止",
        "1:22": "左クリック",
        "1:24": "右クリック",
        "1:16": "上スクロール（ホイール＋）",
        "1:17": "下スクロール（ホイール−）",
      } as Record<string, string>
    )[`${bytes[0]}:${bytes[1]}`] ?? null
  );
}
