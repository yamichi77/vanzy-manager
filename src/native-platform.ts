/** UI routing only. Native Rust commands independently enforce OS/device guards. */
export function nativePlatform(tauri: boolean, platform: string): "macOS" | "Windows" | null {
  if (!tauri) return null;
  if (/^Mac/i.test(platform)) return "macOS";
  if (/^Win/i.test(platform)) return "Windows";
  return null;
}
export const isMacHost = () => /^Mac/i.test(navigator.platform);

export const isWindowsHost = () => /^Win/i.test(navigator.platform);
