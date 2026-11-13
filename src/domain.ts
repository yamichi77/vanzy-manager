/** UI-only values. These are NOT device IDs or protocol payloads. */
export const GESTURE_CATALOG = [
  {
    id: "left",
    name: "左ジェスチャー",
    short: "左",
    group: "air",
    symbol: "←",
  },
  {
    id: "right",
    name: "右ジェスチャー",
    short: "右",
    group: "air",
    symbol: "→",
  },
  { id: "up", name: "上ジェスチャー", short: "上", group: "air", symbol: "↑" },
  {
    id: "down",
    name: "下ジェスチャー",
    short: "下",
    group: "air",
    symbol: "↓",
  },
  {
    id: "counterclockwise",
    name: "反時計回り",
    short: "反時計回り",
    group: "air",
    symbol: "↶",
  },
  {
    id: "clockwise",
    name: "時計回り",
    short: "時計回り",
    group: "air",
    symbol: "↷",
  },
  {
    id: "forward",
    name: "前へ突く",
    short: "前へ突く",
    group: "air",
    symbol: "⇧",
  },
  {
    id: "swipe-left",
    name: "左スワイプ",
    short: "左スワイプ",
    group: "touch",
    symbol: "←",
  },
  {
    id: "swipe-right",
    name: "右スワイプ",
    short: "右スワイプ",
    group: "touch",
    symbol: "→",
  },
  {
    id: "touch-left",
    name: "左タッチ",
    short: "左タッチ",
    group: "touch",
    symbol: "L",
  },
  {
    id: "touch-right",
    name: "右タッチ",
    short: "右タッチ",
    group: "touch",
    symbol: "R",
  },
] as const;
export type Gesture = (typeof GESTURE_CATALOG)[number]["id"];
export const GESTURES: Gesture[] = GESTURE_CATALOG.map((item) => item.id);
export const gestureInfo = (gesture: Gesture) =>
  GESTURE_CATALOG.find((item) => item.id === gesture)!;
export const gestureName = (gesture: Gesture) => gestureInfo(gesture).name;
export type Modifier = "ctrl" | "alt" | "shift" | "gui";
export type OS = "windows" | "mac";
export type Binding = { codes: string[]; modifiers: Modifier[] };
export type Bindings = Record<Gesture, Binding>;
export type Change = { gesture: Gesture; before: Binding; after: Binding };
export type Scenario =
  "sample" | "disconnected" | "reading" | "unknown-firmware" | "read-error";
export const MODIFIERS: Modifier[] = ["ctrl", "alt", "shift", "gui"];
/** Empty means not assigned IN THE DEMO, never an assertion about hardware. */
const emptyBindings = (): Bindings =>
  Object.fromEntries<Binding>(
    GESTURES.map((id) => [id, { codes: [], modifiers: [] } satisfies Binding]),
  ) as Bindings;
export const BASELINE: Bindings = {
  ...emptyBindings(),
  left: { codes: ["ArrowLeft"], modifiers: [] },
  right: { codes: ["ArrowRight"], modifiers: [] },
};
export const KEY_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "Del",
  Home: "Home",
  End: "End",
};
export const COMMON_KEYS = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Tab",
  "Space",
  "Enter",
  "Escape",
];
export const cloneBindings = (value: Bindings): Bindings =>
  Object.fromEntries(
    GESTURES.map((id) => [id, normalize(value[id])]),
  ) as Bindings;
export function normalize(binding: Binding): Binding {
  return {
    codes: [...new Set(binding.codes)].sort(),
    modifiers: binding.codes.length
      ? MODIFIERS.filter((m) => binding.modifiers.includes(m))
      : [],
  };
}
export function equalBinding(a: Binding, b: Binding) {
  return (
    normalize(a).codes.join() === normalize(b).codes.join() &&
    normalize(a).modifiers.join() === normalize(b).modifiers.join()
  );
}
export function changes(baseline: Bindings, draft: Bindings): Change[] {
  return GESTURES.filter((g) => !equalBinding(baseline[g], draft[g])).map(
    (gesture) => ({
      gesture,
      before: baseline[gesture],
      after: draft[gesture],
    }),
  );
}
export function modifierLabel(mod: Modifier, os: OS) {
  return os === "mac"
    ? { ctrl: "⌃", alt: "⌥", shift: "⇧", gui: "⌘" }[mod]
    : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", gui: "Win" }[mod];
}
export function keyLabel(code: string) {
  return KEY_LABELS[code] || code.replace(/^Key/, "").replace(/^Digit/, "");
}
export function bindingLabel(binding: Binding, os: OS) {
  if (!binding.codes.length) return "デモ未割当";
  return [
    ...normalize(binding).modifiers.map((m) => modifierLabel(m, os)),
    ...normalize(binding).codes.map(keyLabel),
  ].join(" + ");
}
export function supportedCode(code: string) {
  return (
    Object.hasOwn(KEY_LABELS, code) ||
    /^Key[A-Z]$/.test(code) ||
    /^Digit[0-9]$/.test(code) ||
    /^F([1-9]|1[0-2])$/.test(code)
  );
}
export type KeyInput = {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
};
export function bindingFromEvent(event: KeyInput): Binding | null {
  if (event.isComposing || event.repeat || !supportedCode(event.code))
    return null;
  return {
    codes: [event.code],
    modifiers: MODIFIERS.filter(
      (m) =>
        ({
          ctrl: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
          gui: event.metaKey,
        })[m],
    ),
  };
}
/** Collect keys held together; finish on the first ordinary-key release.
 * Drain remaining releases before accepting another chord in the test field. */
export function createChordCapture() {
  const held = new Set<string>();
  let pending: Binding | null = null;
  let draining = false;
  return {
    press(event: KeyInput) {
      if (
        pending &&
        !draining &&
        !event.isComposing &&
        !event.repeat &&
        /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(event.code)
      ) {
        const modifiers = MODIFIERS.filter(
          (m) =>
            ({
              ctrl: event.ctrlKey,
              alt: event.altKey,
              shift: event.shiftKey,
              gui: event.metaKey,
            })[m],
        );
        pending = { ...pending, modifiers };
        return pending;
      }
      const input = bindingFromEvent(event);
      if (!input) return null;
      held.add(event.code);
      if (draining) return null;
      pending = normalize({ codes: [...held], modifiers: input.modifiers });
      return pending;
    },
    release(code: string) {
      if (!held.delete(code)) return null;
      const result = pending;
      pending = null;
      draining = held.size > 0;
      return result;
    },
    clear() {
      held.clear();
      pending = null;
      draining = false;
    },
  };
}
export const ASSIGNABLE_KEYS = [
  ...Object.keys(KEY_LABELS),
  ...Array.from({ length: 26 }, (_, i) => "Key" + String.fromCharCode(65 + i)),
  ...Array.from({ length: 10 }, (_, i) => "Digit" + i),
  ...Array.from({ length: 12 }, (_, i) => "F" + (i + 1)),
];
/** Simulation changes ONLY the demo baseline. Real device writes have no implementation. */
export function simulateApply(
  baseline: Bindings,
  draft: Bindings,
  failSecond = false,
): { baseline: Bindings; applied: Gesture[]; failed: Gesture | null } {
  const pending = changes(baseline, draft),
    next = cloneBindings(baseline),
    applied: Gesture[] = [];
  let failed: Gesture | null = null;
  for (let i = 0; i < pending.length; i++) {
    const change = pending[i];
    if (failSecond && i === (pending.length > 1 ? 1 : 0)) {
      failed = change.gesture;
      break;
    }
    next[change.gesture] = normalize(change.after);
    applied.push(change.gesture);
  }
  return { baseline: next, applied, failed };
}
export type DemoBackup = {
  schemaVersion?: 2;
  /** Old demo exports contain only left/right; restoring them preserves newer slots. */
  legacyLeftRightOnly?: boolean;
  id: string;
  createdAt: string;
  name: string;
  firmware: "demo-v1" | "unknown";
  bindings: Bindings;
  source: "demo";
  kind?: "auto" | "manual" | "imported" | "draft";
};
export function canRestore(backup: DemoBackup): boolean {
  return backup.source === "demo" && backup.firmware === "demo-v1";
}
export function restoreBindings(draft: Bindings, backup: DemoBackup): Bindings {
  return backup.legacyLeftRightOnly
    ? {
        ...cloneBindings(draft),
        left: normalize(backup.bindings.left),
        right: normalize(backup.bindings.right),
      }
    : cloneBindings(backup.bindings);
}
export function makeBackup(bindings: Bindings): DemoBackup {
  return {
    schemaVersion: 2,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    name: "変更前のサンプル",
    kind: "auto",
    firmware: "demo-v1",
    bindings: cloneBindings(bindings),
    source: "demo",
  };
}
