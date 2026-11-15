import { deviceKeys } from "./DevicePanel";
import type { Draft } from "./native-model";
import type { MacroStep } from "./macro-model";
type KeyStep = Extract<MacroStep, { type: "key" }>;
/** View adapter only: unsupported existing usages round-trip without data loss. */
export function macroKeyDraft(step: KeyStep): Draft {
  if (!step.keys.length && step.modifiers === 8)
    return { codes: ["WindowsOnly"], mask: 0 };
  return {
    codes: step.keys.map(
      (usage) =>
        deviceKeys.find((k) => k.usage === usage && k.code !== "WindowsOnly")
          ?.code ?? `Usage:${usage}`,
    ),
    mask: step.modifiers,
  };
}
export function updateMacroKey(step: KeyStep, draft: Draft): KeyStep {
  if (draft.codes.length === 1 && draft.codes[0] === "WindowsOnly")
    return { ...step, keys: [], modifiers: 8 };
  const keys = draft.codes.map(
    (code) =>
      deviceKeys.find((k) => k.code === code)?.usage ??
      (/^Usage:\d+$/.test(code) ? Number(code.slice(6)) : NaN),
  );
  // Never turn an unrepresentable draft into a different usable chord.
  if (keys.some((k) => !Number.isInteger(k) || k < 4 || k > 0x65)) return step;
  return { ...step, keys, modifiers: draft.mask };
}
