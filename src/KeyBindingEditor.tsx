import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { deviceKeys } from "./DevicePanel";
import { isMacHost } from "./native-platform";
import {
  MAX_CHORD_KEYS,
  MODIFIER_KEYS,
  isDefaultDraft,
  isWindowsOnlyDraft,
  eventMask,
  receivedLabel,
  type Draft,
} from "./native-model";
export type KeyBindingEditorProps = {
  value: Draft;
  onChange: (value: Draft) => void;
  editable: boolean;
  onCaptureChange?: (capturing: boolean) => void;
  resetKey?: string | number;
  hint?: string;
  onHintChange?: (hint: string) => void;
  description?: string;
  showValue?: boolean;
  captureMessage?: string;
  allowWindowsOnly?: boolean;
  title?: string;
};
const COMMON_KEYS = [
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
/** Display order of the modifier chips: Ctrl, Alt, Shift, Win. */
const MODIFIER_CHIPS: [number, string][] = [
  [1, "Ctrl"],
  [4, "Alt"],
  [2, "Shift"],
  [8, "Win"],
];
const keyLabelOf = (code: string) =>
  deviceKeys.find((key) => key.code === code)?.label ?? code;

export function KeyBindingEditor({
  value,
  onChange,
  editable,
  onCaptureChange,
  resetKey,
  hint: controlledHint,
  onHintChange,
  description = "同時押しもそのまま記録できます。通常キーが2つ以上になると、アプリ経由で動きます。",
  captureMessage,
  showValue = false,
  allowWindowsOnly = true,
  title = "変更する",
}: KeyBindingEditorProps) {
  const id = useId();
  const mac = isMacHost();
  const base = value;
  const [capturing, setCapturing] = useState(false);
  const [live, setLive] = useState("");
  const [localHint, setLocalHint] = useState("");
  const hint = controlledHint ?? localHint;
  const setHint = (text: string) => {
    setLocalHint(text);
    onHintChange?.(text);
  };
  const held = useRef<string[]>([]);
  const heldMask = useRef(0);
  const callback = useRef(onCaptureChange);
  callback.current = onCaptureChange;
  const modifierChips = MODIFIER_CHIPS.map(
    ([bit, label]) =>
      [
        bit,
        mac
          ? ((
              { 1: "Control", 4: "Option", 2: "Shift", 8: "Command" } as Record<
                number,
                string
              >
            )[bit] ?? label)
          : label,
      ] as [number, string],
  );
  useEffect(() => {
    stopCapture();
  }, [resetKey, editable]);
  useEffect(
    () => () => {
      callback.current?.(false);
    },
    [],
  );
  const otherValue =
    base.codes.length === 1 &&
    !COMMON_KEYS.includes(base.codes[0]) &&
    !isDefaultDraft(base)
      ? base.codes[0]
      : "";
  const fixedKey = (draft: Draft) =>
    isDefaultDraft(draft) || isWindowsOnlyDraft(draft);
  function toggleModifier(bit: number) {
    const base = value;
    if (!editable || fixedKey(base)) return;
    onChange({ codes: base.codes, mask: base.mask ^ bit });
    setHint("");
  }
  function pickKey(code: string) {
    if (!editable || !code) return;
    const base = value;
    const keepMask = code !== "WindowsOnly" && !fixedKey(base);
    onChange({ codes: [code], mask: keepMask ? base.mask : 0 });
    setHint("");
  }
  // ---- key capture (local, opt-in) ---------------------------------------
  function startCapture() {
    if (!editable) return;
    held.current = [];
    heldMask.current = 0;
    setCapturing(true);
    onCaptureChange?.(true);
    setLive("");
    setHint("");
  }
  function stopCapture() {
    setCapturing(false);
    onCaptureChange?.(false);
    setLive("");
    held.current = [];
    heldMask.current = 0;
  }
  function captureDown(event: ReactKeyboardEvent) {
    if (!capturing || event.repeat) return;
    if (event.key === "Tab") {
      stopCapture();
      return;
    }
    event.preventDefault();
    if (event.key === "Escape") {
      stopCapture();
      setHint("記録を取り消しました。");
      return;
    }
    heldMask.current |= eventMask(event);
    if (!MODIFIER_KEYS.includes(event.key)) {
      const key = deviceKeys.find(
        (item) => item.code === event.code && item.code !== "WindowsOnly",
      );
      if (!key) setHint("このキーは「その他のキー」から選んでください。");
      else if (
        !held.current.includes(key.code) &&
        held.current.length < MAX_CHORD_KEYS
      )
        held.current = [...held.current, key.code];
    }
    setLive(
      held.current.length
        ? receivedLabel(heldMask.current, held.current)
        : heldMask.current
          ? `${receivedLabel(heldMask.current, [])} + …`
          : "",
    );
  }
  function captureUp(event: ReactKeyboardEvent) {
    if (!capturing || !held.current.length) return;
    event.preventDefault();
    const next = { codes: [...held.current], mask: heldMask.current };
    stopCapture();
    onChange(next);
    setHint(
      captureMessage ??
        (next.codes.length >= 2
          ? "同時押しを記録しました。保存するとアプリ経由で動きます。"
          : "記録しました。まだ本体には保存していません。"),
    );
  }

  return (
    <div className="nx-block">
      <h2 className="nx-eyebrow">{title}</h2>
      {showValue && (
        <div className="nx-value-panel" aria-label="選択中のキー">
          {(base.codes.length === 1 && base.codes[0] === "WindowsOnly"
            ? mac
              ? "Command"
              : "Win"
            : receivedLabel(base.mask, base.codes)
          )
            .split(" + ")
            .filter(Boolean)
            .map((part, i) => (
              <span key={`${i}-${part}`} className="nx-keycap-wrap">
                {i > 0 && (
                  <span className="nx-plus" aria-hidden="true">
                    +
                  </span>
                )}
                <kbd className="nx-keycap">{part}</kbd>
              </span>
            ))}
        </div>
      )}
      <div className="nx-field nx-field-top">
        <span className="nx-label">キー入力</span>
        <div className="nx-field-body">
          <button
            type="button"
            className="nx-input-zone"
            aria-pressed={capturing}
            disabled={!editable}
            onClick={(event) => {
              event.currentTarget.focus();
              startCapture();
            }}
            onBlur={stopCapture}
            onKeyDown={captureDown}
            onKeyUp={captureUp}
          >
            <KeyboardIcon />
            <span>
              {capturing
                ? live
                  ? `${live} … キーを離すと確定`
                  : "キーを押してください（同時押しもできます・Esc で取り消し）"
                : "ここをクリックして、割り当てたいキーを押す"}
            </span>
          </button>
          <p className="nx-meta" role="status">
            {hint || description}
          </p>
        </div>
      </div>
      <div className="nx-field">
        <span className="nx-label" id={`${id}-mods`}>
          修飾キー
        </span>
        <div className="nx-chips" role="group" aria-labelledby={`${id}-mods`}>
          {modifierChips.map(([bit, label]) => (
            <button
              key={bit}
              type="button"
              className="nx-chip"
              aria-pressed={!!(base.mask & bit) && !fixedKey(base)}
              disabled={!editable || fixedKey(base)}
              onClick={() => toggleModifier(bit)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="nx-field">
        <span className="nx-label" id={`${id}-common`}>
          よく使うキー
        </span>
        <div className="nx-chips" role="group" aria-labelledby={`${id}-common`}>
          {COMMON_KEYS.map((code) => (
            <button
              key={code}
              type="button"
              className="nx-chip"
              aria-pressed={base.codes.includes(code)}
              disabled={!editable}
              onClick={() => pickKey(code)}
            >
              {keyLabelOf(code)}
            </button>
          ))}
        </div>
      </div>
      <div className="nx-field">
        <label className="nx-label" htmlFor={`${id}-other`}>
          その他のキー
        </label>
        <select
          id={`${id}-other`}
          className="nx-select"
          value={otherValue}
          disabled={!editable}
          onChange={(event) => pickKey(event.target.value)}
        >
          <option value="">一覧から選ぶ</option>
          {deviceKeys
            .filter(
              (key) =>
                !COMMON_KEYS.includes(key.code) &&
                (allowWindowsOnly || key.code !== "WindowsOnly"),
            )
            .map((key) => (
              <option key={key.code} value={key.code}>
                {key.label}
              </option>
            ))}
        </select>
      </div>
    </div>
  );
}
function KeyboardIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="nx-stroke"
    >
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </svg>
  );
}
