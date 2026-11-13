/** Pure helpers for the unified native assignment screen. No device or host I/O. */
import {
  currentDescription,
  deviceKeys,
  deviceModifiers,
  draftTarget,
  type BatchChange,
  type DeviceSnapshot,
} from "./DevicePanel";
import type { HostBinding } from "./HostPanel";
import {
  FIRMWARE_DEFAULT_CODE,
  firmwareDefaultMap,
  supportsFirmwareDefaults,
} from "./firmware-defaults";

export const GESTURE_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
export const AIR_IDS = [1, 2, 3, 4, 5, 6, 7] as const;
export const TOUCH_IDS = [8, 9, 10, 11] as const;
/** Normal keys a chord may contain on the host (one to six, no modifiers-only). */
export const MAX_CHORD_KEYS = 6;

const defaultNames: Record<number, string> = {
  1: "左へ",
  2: "右へ",
  3: "上へ",
  4: "下へ",
  5: "左回り",
  6: "右回り",
  7: "前へ突く",
  8: "タッチ A",
  9: "タッチ B",
  10: "スワイプ A",
  11: "スワイプ B",
};

export type GestureIconKind =
  | "left"
  | "right"
  | "up"
  | "down"
  | "ccw"
  | "cw"
  | "push"
  | "tapA"
  | "tapB"
  | "swipe"
  | "swipeLeft"
  | "swipeRight";

const defaultIcons: Record<number, GestureIconKind> = {
  1: "left",
  2: "right",
  3: "up",
  4: "down",
  5: "ccw",
  6: "cw",
  7: "push",
  8: "tapA",
  9: "tapB",
  10: "swipe",
  11: "swipe",
};
/** Calibrated physical names (HostPanel physicalNames) decide the icon so it never contradicts the label. */
const labelIcons: Record<string, GestureIconKind> = {
  左: "left",
  右: "right",
  上: "up",
  下: "down",
  反時計回り: "ccw",
  時計回り: "cw",
  前方: "push",
  左スワイプ: "swipeLeft",
  右スワイプ: "swipeRight",
  左タッチ: "tapA",
  右タッチ: "tapB",
  "○印側へスワイプ": "swipeLeft",
  "○印と反対側へスワイプ": "swipeRight",
  "○印側タッチ": "tapA",
  "○印と反対側タッチ": "tapB",
};

/** Short display names for calibrated physical names, in the same style as the defaults. */
const labelNames: Record<string, string> = {
  左: "左へ",
  右: "右へ",
  上: "上へ",
  下: "下へ",
  反時計回り: "左回り",
  時計回り: "右回り",
  前方: "前へ突く",
  "○印側へスワイプ": "○側へスワイプ",
  "○印と反対側へスワイプ": "反対側へスワイプ",
  "○印側タッチ": "○側タッチ",
  "○印と反対側タッチ": "反対側タッチ",
};
export function gestureName(index: number, labels: Record<string, string>) {
  const label = labels[String(index)];
  return label ? (labelNames[label] ?? label) : defaultNames[index];
}
export function gestureIcon(
  index: number,
  labels: Record<string, string>,
): GestureIconKind {
  const label = labels[String(index)];
  return (label && labelIcons[label]) || defaultIcons[index];
}
export function gestureGroup(index: number) {
  return index <= 7 ? "空中ジェスチャー" : "タッチ操作";
}
/** Only physically confirmed names drop the warning. */
export function unverifiedNote(index: number, labels: Record<string, string>) {
  if (labels[String(index)]) return "";
  if (index >= 8) return "どちら側の操作かは実機で未確認です";
  if (index >= 5) return "認識は実機で未確認です";
  return "";
}

/** A draft is a set of normal key codes (deviceKeys codes) plus a modifier mask.
 * One code (or Windows-only / firmware default) is stored on the device; two or more
 * normal keys can only be sent by this app while host sending is active. */
export type Draft = { codes: string[]; mask: number };
export type Route = "device" | "host";

export const isDefaultDraft = (draft: Draft) =>
  draft.codes[0] === FIRMWARE_DEFAULT_CODE;
export const isWindowsOnlyDraft = (draft: Draft) =>
  draft.codes[0] === "WindowsOnly";
export const draftComplete = (draft: Draft) => draft.codes.length > 0;
export const draftRoute = (draft: Draft): Route =>
  draft.codes.length >= 2 ? "host" : "device";

const modifierLabels = (mask: number) =>
  deviceModifiers.filter(([bit]) => mask & bit).map(([, label]) => label);
const keyByCode = (code: string) => deviceKeys.find((key) => key.code === code);
const keyByUsage = (usage: number) =>
  deviceKeys.find((key) => key.code !== "WindowsOnly" && key.usage === usage);

export function chordLabel(mask: number, keyLabels: string[]) {
  return [...modifierLabels(mask), ...keyLabels].join(" + ");
}
export function bindingLabel(binding: HostBinding) {
  return (
    chordLabel(
      binding.modifiers,
      binding.keys.map((usage) => keyByUsage(usage)?.label ?? String(usage)),
    ) || "未設定"
  );
}
export function defaultTargetFor(index: number, snapshot: DeviceSnapshot | null) {
  return supportsFirmwareDefaults(snapshot) ? firmwareDefaultMap(index) : null;
}
export function draftLabel(
  index: number,
  draft: Draft,
  snapshot: DeviceSnapshot | null,
) {
  if (isDefaultDraft(draft)) {
    const target = defaultTargetFor(index, snapshot);
    return target ? currentDescription(target) : "標準設定";
  }
  if (isWindowsOnlyDraft(draft)) return "Windowsキー単独";
  return chordLabel(
    draft.mask,
    draft.codes.length
      ? draft.codes.map((code) => keyByCode(code)?.label ?? code)
      : ["…"],
  );
}

export function draftFromMap(map: number[] | undefined): Draft {
  if (!map || map.length !== 15) return { codes: [], mask: 0 };
  if (map[0] === 5 && map[1] === 8 && map.slice(2).every((v) => v === 0))
    return { codes: ["WindowsOnly"], mask: 0 };
  if (map[0] === 5 && map[1] <= 15 && map.slice(3).every((v) => v === 0)) {
    const key = keyByUsage(map[2]);
    if (key) return { codes: [key.code], mask: map[1] };
  }
  return { codes: [], mask: 0 };
}
export function draftFromBinding(binding: HostBinding): Draft {
  return {
    codes: binding.keys
      .map((usage) => keyByUsage(usage)?.code)
      .filter((code): code is string => Boolean(code)),
    mask: binding.modifiers,
  };
}
export function bindingFromDraft(index: number, draft: Draft): HostBinding | null {
  if (draftRoute(draft) !== "host" || draft.codes.length > MAX_CHORD_KEYS)
    return null;
  const keys = draft.codes.map((code) =>
    code === "WindowsOnly" || code === FIRMWARE_DEFAULT_CODE
      ? undefined
      : keyByCode(code)?.usage,
  );
  if (keys.some((usage) => !usage) || new Set(keys).size !== keys.length)
    return null;
  return { index, keys: keys as number[], modifiers: draft.mask & 0x0f };
}
export function sameBinding(a: HostBinding, b: HostBinding) {
  const left = [...a.keys].sort((x, y) => x - y);
  const right = [...b.keys].sort((x, y) => x - y);
  return (
    a.index === b.index &&
    a.modifiers === b.modifiers &&
    left.length === right.length &&
    left.every((value, i) => value === right[i])
  );
}
const equalBytes = (a: number[], b: number[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** The draft the editor starts from when a gesture has no draft yet. */
export function baseDraft(
  index: number,
  snapshot: DeviceSnapshot | null,
  profile: HostBinding[],
): Draft {
  const bound = profile.find((binding) => binding.index === index);
  if (bound) return draftFromBinding(bound);
  return draftFromMap(snapshot?.maps[String(index)]);
}

/** Whether a complete draft differs from what is effective now (host binding first, then device map). */
export function isChange(
  index: number,
  draft: Draft,
  snapshot: DeviceSnapshot | null,
  profile: HostBinding[],
) {
  if (!draftComplete(draft)) return false;
  const bound = profile.find((binding) => binding.index === index);
  if (draftRoute(draft) === "host") {
    const next = bindingFromDraft(index, draft);
    return !next || !bound || !sameBinding(bound, next);
  }
  if (bound) return true;
  const map = snapshot?.maps[String(index)];
  const target = draftTarget(index, draft.codes[0], draft.mask, snapshot);
  return !map || !target || !equalBytes(map, target);
}

export function currentLabel(
  index: number,
  snapshot: DeviceSnapshot | null,
  profile: HostBinding[],
) {
  const bound = profile.find((binding) => binding.index === index);
  if (bound) return bindingLabel(bound);
  return deviceLabel(index, snapshot);
}
export function deviceLabel(index: number, snapshot: DeviceSnapshot | null) {
  const map = snapshot?.maps[String(index)];
  return map ? currentDescription(map) : "未読取り";
}
/** True when the device value is a keyboard key (shown as keycaps, testable by key input). */
export function deviceIsKey(index: number, snapshot: DeviceSnapshot | null) {
  return draftComplete(draftFromMap(snapshot?.maps[String(index)]));
}

export type SavePlan = {
  device: BatchChange[];
  hostAdds: HostBinding[];
  /** Gestures whose host binding is dropped because a single key goes to the device instead. */
  unbinds: number[];
  invalid: number[];
};
export function planSave(
  drafts: Record<number, Draft>,
  snapshot: DeviceSnapshot,
  profile: HostBinding[],
): SavePlan {
  const plan: SavePlan = { device: [], hostAdds: [], unbinds: [], invalid: [] };
  for (const index of GESTURE_IDS) {
    const draft = drafts[index];
    if (!draft || !isChange(index, draft, snapshot, profile)) continue;
    if (draftRoute(draft) === "host") {
      const binding = bindingFromDraft(index, draft);
      if (binding) plan.hostAdds.push(binding);
      else plan.invalid.push(index);
      continue;
    }
    const map = snapshot.maps[String(index)];
    const target = draftTarget(index, draft.codes[0], draft.mask, snapshot);
    if (!map || !target) {
      plan.invalid.push(index);
      continue;
    }
    if (!equalBytes(map, target))
      plan.device.push({ index, expected: [...map], target: [...target] });
    if (profile.some((binding) => binding.index === index))
      plan.unbinds.push(index);
  }
  return plan;
}

/** Combination text for keys received by the test area, in the same order as device labels. */
export function receivedLabel(mask: number, codes: string[]) {
  return chordLabel(
    mask,
    codes.map((code) => keyByCode(code)?.label ?? code),
  );
}
export const eventMask = (event: {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}) =>
  (event.ctrlKey ? 1 : 0) |
  (event.shiftKey ? 2 : 0) |
  (event.altKey ? 4 : 0) |
  (event.metaKey ? 8 : 0);
export const MODIFIER_KEYS = ["Control", "Shift", "Alt", "Meta", "OS"];
