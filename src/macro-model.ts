/** Host-only macro data. Never a device map or an authorization to write hardware. */
export type MacroStep =
  | { type: "key"; keys: number[]; modifiers: number; targetApp?: string }
  | { type: "wait"; ms: number }
  | { type: "openApp"; app: string; timeoutMs: number }
  | { type: "openUrl"; url: string; app: string; timeoutMs: number };
export type MacroDefinition = { version: 1; steps: MacroStep[] };
export type MacroBinding = { index: number; macro: MacroDefinition };
export const MAX_MACRO_STEPS = 32;
export const MAX_MACRO_WAIT_MS = 10_000;
export const emptyMacro = (): MacroDefinition => ({ version: 1, steps: [] });

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, min: number, max: number): v is number =>
  Number.isInteger(v) && Number(v) >= min && Number(v) <= max;
export type MacroPlatform = "macos" | "windows";
export const macroPlatform = (): MacroPlatform =>
  typeof navigator !== "undefined" && /^Win/i.test(navigator.platform) ? "windows" : "macos";
/** Local OS identifiers, never command lines. Native code checks existence/identity again. */
export function validMacroApp(app: unknown, platform: MacroPlatform = macroPlatform()): app is string {
  if (platform === "windows") {
    if (typeof app !== "string") return false;
    if (app.startsWith("aumid:")) {
      const id = app.slice(6);
      return id.length <= 255 && /^[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/.test(id);
    }
    return app.length <= 32767 && /^[A-Za-z]:\\/.test(app) && /\.exe$/i.test(app) &&
      !/[\x00-\x1f\x7f<>"|?*\/]/.test(app) && !app.slice(2).includes(":") &&
      app.slice(3).split("\\").every(part => !!part && part !== "." && part !== ".." && !/[. ]$/.test(part));
  }
  return (
    typeof app === "string" &&
    app.length <= 255 &&
    /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(app)
  );
}
export function validMacroUrl(url: unknown): url is string {
  if (
    typeof url !== "string" ||
    !url ||
    url.length > 4096 ||
    /[\s\u0000-\u001f\u007f]/u.test(url)
  )
    return false;
  try {
    const parsed = new URL(url);
    return (
      /^[a-z][a-z0-9+.-]*:$/.test(parsed.protocol) &&
      ![
        "javascript:",
        "data:",
        "file:",
        "shell:",
        "command:",
        "powershell:",
        "vbscript:",
        "cmd:",
        "osascript:",
        "applescript:",
      ].includes(parsed.protocol.toLowerCase()) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}
/** Reject unknown input without altering it, including saved profiles from newer versions. */
export function validateMacro(raw: unknown, platform: MacroPlatform = macroPlatform()): string | null {
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.steps))
    return "マクロの形式またはバージョンを確認してください。";
  if (raw.steps.length < 1 || raw.steps.length > MAX_MACRO_STEPS)
    return "手順は1〜32件にしてください。";
  let waits = 0;
  let budget = 0;
  for (const [index, step] of raw.steps.entries()) {
    const prefix = `手順${index + 1}: `;
    if (!record(step)) return prefix + "手順の形式が不正です。";
    switch (step.type) {
      case "key":
        if (
          !Array.isArray(step.keys) ||
          step.keys.length > 6 ||
          !step.keys.every((k) => integer(k, 4, 0x65)) ||
          new Set(step.keys).size !== step.keys.length ||
          !integer(step.modifiers, 0, 15) ||
          (!step.keys.length && step.modifiers !== 8)
        )
          return prefix + "通常キー1〜6個と修飾キーを設定してください。";
        if (step.targetApp !== undefined && !validMacroApp(step.targetApp, platform))
          return prefix + "送信条件の対象アプリ識別子を入力してください。";
        break;
      case "wait":
        if (!integer(step.ms, 0, MAX_MACRO_WAIT_MS))
          return prefix + "待機時間は0〜10000msの整数にしてください。";
        waits += step.ms;
        budget += step.ms;
        break;
      case "openApp":
      case "openUrl":
        if (!validMacroApp(step.app, platform))
          return prefix + "対象アプリの識別子を入力してください。";
        if (!integer(step.timeoutMs, 100, 10_000))
          return prefix + "起動待機の上限は100〜10000msにしてください。";
        budget += step.timeoutMs;
        if (step.type === "openUrl") {
          if (!validMacroUrl(step.url))
            return (
              prefix +
              "安全な形式のURLを入力してください。認証情報やスクリプト形式は利用できません。"
            );
        }
        break;
      default:
        return prefix + "未対応の手順です。";
    }
  }
  if (budget > 60_000)
    return "待機と起動待機上限の合計は60000ms以内にしてください。";
  return waits > MAX_MACRO_WAIT_MS
    ? "待機時間の合計は10000ms以内にしてください。"
    : null;
}
export const isMacroDefinition = (raw: unknown): raw is MacroDefinition =>
  validateMacro(raw) === null;
export function validMacroBindings(raw: unknown): raw is MacroBinding[] {
  return (
    Array.isArray(raw) &&
    raw.length <= 11 &&
    new Set(raw.map((b) => b?.index)).size === raw.length &&
    raw.every(
      (b) => record(b) && integer(b.index, 1, 11) && isMacroDefinition(b.macro),
    )
  );
}
export function newMacroStep(type: MacroStep["type"]): MacroStep {
  switch (type) {
    case "key":
      return { type, keys: [], modifiers: 0 };
    case "wait":
      return { type, ms: 200 };
    case "openApp":
      return { type, app: "", timeoutMs: 5000 };
    case "openUrl":
      return { type, url: "", app: "", timeoutMs: 5000 };
  }
}
export function moveMacroStep(
  value: MacroDefinition,
  from: number,
  to: number,
): MacroDefinition {
  if (
    from < 0 ||
    to < 0 ||
    from >= value.steps.length ||
    to >= value.steps.length ||
    from === to
  )
    return value;
  const steps = [...value.steps];
  const [step] = steps.splice(from, 1);
  steps.splice(to, 0, step);
  return { ...value, steps };
}
