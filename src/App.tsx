import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Button,
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import {
  ArrowRight,
  Archive,
  CircleHelp,
  Info,
  Keyboard,
  Monitor,
  RotateCcw,
  X,
} from "lucide-react";
import {
  BASELINE,
  GESTURE_CATALOG,
  gestureInfo,
  gestureName as name,
  COMMON_KEYS,
  MODIFIERS,
  ASSIGNABLE_KEYS,
  createChordCapture,
  normalize,
  bindingLabel,
  changes,
  cloneBindings,
  equalBinding,
  keyLabel,
  modifierLabel,
} from "./domain";
import type {
  Binding,
  Bindings,
  DemoBackup,
  Gesture,
  Modifier,
  OS,
} from "./domain";
import { getRuntimeCapabilities } from "./runtime";
import { DevicePanel } from "./DevicePanel";
import { GestureGuide } from "./GestureGuide";
import { DesignTest } from "./DesignTest";
import type { TestLogRow } from "./DesignTest";
import { DesignStates } from "./DesignStates";
import { DesignApply, DesignBackups, DesignDialog } from "./DesignDialogs";
const initialBackups: DemoBackup[] = [
  {
    schemaVersion: 2,
    id: "sample-backup",
    kind: "auto",
    createdAt: "2026-11-09T00:00:00Z",
    name: "サンプルの初期割り当て",
    source: "demo",
    firmware: "demo-v1",
    bindings: cloneBindings(BASELINE),
  },
  {
    schemaVersion: 2,
    id: "manual-backup",
    kind: "manual",
    createdAt: "2026-11-08T08:00:00Z",
    name: "手動で保存（デモの見本）",
    source: "demo",
    firmware: "demo-v1",
    bindings: {
      ...cloneBindings(BASELINE),
      left: { codes: ["PageUp"], modifiers: [] },
    },
  },
  {
    schemaVersion: 2,
    id: "unknown-backup",
    kind: "manual",
    createdAt: "2026-11-08T00:00:00Z",
    name: "手動で保存（別のFWの見本）",
    source: "demo",
    firmware: "unknown",
    bindings: cloneBindings(BASELINE),
  },
];
function Logo() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="14" cy="15" r="9" stroke="currentColor" strokeWidth="2.5" />
      <rect x="10.5" y="2" width="7" height="6" rx="2" fill="currentColor" />
    </svg>
  );
}
function Segments({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  items: [string, string][];
}) {
  return (
    <SegmentedControl label={label} value={value} onChange={onChange} size="sm">
      {items.map(([v, l]) => (
        <SegmentedControlItem key={v} value={v} label={l} />
      ))}
    </SegmentedControl>
  );
}
function Help({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  return (
    <DesignDialog titleId={titleId} className="help-dialog" onClose={onClose}>
      <div className="help-title">
        <h2 id={titleId}>このプレビューについて</h2>
        <Button label="閉じる" isIconOnly icon={<X />} onClick={onClose} />
      </div>
      <p>
        ユーザー提供の改訂HTMLを基に、Astryx
        0.7.11・React・Tauriで実装したUIデモです。
      </p>
      <h3>試せること</h3>
      <p>
        キー割当の下書き、キー入力と認識のデモ、変更トレイ、反映・失敗・バックアップのモック。データはこのセッション内だけで、再読込みすると消えます。
      </p>
      <h3>デモと実機を分離しています</h3>
      <p>
        下のデモ画面から本体へは送信しません。Windowsネイティブ版の「本体の設定」だけが、既知の4枠を読み取り・バックアップし、明示確認後に書き込みます。ファームウェア更新・再ペアリング・OS全体の入力監視は行いません。
      </p>
      <h3>操作図</h3>
      <p>
        VANZY
        v3の操作説明をもとにした独自の静止模式図です。形状・寸法は簡略化しており、実機認識は未検証です。公式画像や推測のアニメーションは使用していません。
      </p>
    </DesignDialog>
  );
}
function KeyCaps({
  binding,
  os,
  changed = false,
}: {
  binding: Binding;
  os: OS;
  changed?: boolean;
}) {
  return (
    <div className={`keycaps ${changed ? "changed" : ""}`}>
      {MODIFIERS.filter((m) => binding.modifiers.includes(m)).map((m) => (
        <kbd key={m}>{modifierLabel(m, os)}</kbd>
      ))}
      {!binding.codes.length && (
        <span className="unassigned-label">デモ未割当</span>
      )}
      {binding.codes.map((code) => (
        <kbd key={code}>{keyLabel(code)}</kbd>
      ))}
    </div>
  );
}
export function App() {
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [osPref, setOsPref] = useState<"auto" | OS>("auto");
  const detectedHost = /Mac|iPhone|iPad/.test(navigator.platform)
    ? "macOS"
    : /Win/.test(navigator.platform)
      ? "Windows"
      : /Linux/.test(navigator.platform)
        ? "Linux"
        : "判定不可";
  const nativeOS: OS = detectedHost === "macOS" ? "mac" : "windows";
  const os = osPref === "auto" ? nativeOS : osPref;
  const [baseline, setBaseline] = useState<Bindings>(() =>
    cloneBindings(BASELINE),
  );
  const [draft, setDraft] = useState<Bindings>(() => ({
    ...cloneBindings(BASELINE),
    right: { codes: ["PageDown"], modifiers: [] },
  }));
  const [selected, setSelected] = useState<Gesture>("right");
  const g = selected;
  const [tab, setTab] = useState<"assign" | "test">("assign");
  const [page, setPage] = useState<"main" | "states">("main");
  const [modal, setModal] = useState<"apply" | "backups" | "help" | null>(null);
  const [backups, setBackups] = useState<DemoBackup[]>(initialBackups);
  const [testLogs, setTestLogs] = useState<TestLogRow[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [capturePreview, setCapturePreview] = useState<Binding | null>(null);
  const [addCode, setAddCode] = useState("");
  const captureArea = useRef<HTMLElement>(null);
  const [notice, setNotice] = useState("");
  const [runtime, setRuntime] = useState("安全状態を確認中");
  const [safe, setSafe] = useState(false);
  const pending = changes(baseline, draft);
  const changed = !equalBinding(baseline[g], draft[g]);
  const editable = safe && page === "main";
  const current = draft[g];
  const osNote =
    os === "mac" &&
    current.modifiers.includes("ctrl") &&
    !current.modifiers.includes("gui")
      ? "Macでは ⌃ Control の表記です。⌘ Command として使いたいときは、Command を選んでください。"
      : os === "windows" && current.modifiers.includes("gui")
        ? "Windowsでは Win、Macでは ⌘ Command の表記になります。"
        : osPref === "auto"
          ? detectedHost === "Linux" || detectedHost === "判定不可"
            ? `このPCは${detectedHost}のため、キー表記はWindows式を仮表示しています。必要に応じて切り替えてください。`
            : `キー表記はこのPCのOS（${detectedHost}）に合わせて自動で選んでいます。`
          : `表記を手動で ${os === "mac" ? "macOS" : "Windows"} にしています。`;
  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      if (active) {
        active = false;
        setSafe(false);
        setRuntime("安全確認に失敗");
      }
    }, 8000);
    getRuntimeCapabilities()
      .then((v) => {
        if (active) {
          window.clearTimeout(timeout);
          setSafe(true);
          setRuntime(
            v.platform === "browser"
              ? "ブラウザプレビュー"
              : "デスクトップ・デモ",
          );
        }
      })
      .catch(() => {
        if (active) {
          window.clearTimeout(timeout);
          setSafe(false);
          setRuntime("安全確認に失敗");
        }
      });
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, []);
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    setCapturing(false);
    setAddCode("");
  }, [selected, tab, page, modal]);
  useEffect(() => {
    setCapturePreview(null);
    if (!capturing || !editable) return;
    const chord = createChordCapture();
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setCapturing(false);
        setNotice("キーの記録をキャンセルしました。");
        return;
      }
      const b = chord.press(e);
      if (b) {
        setCapturePreview(b);
      } else if (
        !e.isComposing &&
        !e.repeat &&
        !["Control", "Alt", "Shift", "Meta", "Dead", "Unidentified"].includes(
          e.key,
        )
      ) {
        chord.clear();
        setCapturePreview(null);
        setNotice(
          "このキーは割当編集に未対応です。対応するキーを押すか、Escで記録を終了してください。",
        );
      }
    };
    const release = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const b = chord.release(e.code);
      if (b) {
        setDraft((d) => ({ ...d, [g]: b }));
        setCapturing(false);
        setNotice("下書きに記録しました。実機には送信していません。");
      }
    };
    const blur = () => setCapturing(false);
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !captureArea.current?.contains(event.target)
      )
        setCapturing(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    window.addEventListener("keydown", handler, true);
    window.addEventListener("keyup", release, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("keyup", release, true);
      window.removeEventListener("blur", blur);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
    };
  }, [capturing, editable, g]);
  function update(b: Binding) {
    if (editable) {
      setDraft((d) => ({ ...d, [g]: normalize(b) }));
      setAddCode("");
    }
  }
  function toggle(m: Modifier) {
    update({
      ...current,
      modifiers: current.modifiers.includes(m)
        ? current.modifiers.filter((x) => x !== m)
        : [...current.modifiers, m],
    });
  }
  function revert(id: Gesture) {
    if (!safe) return;
    setDraft((d) => ({
      ...d,
      [id]: normalize(baseline[id]),
    }));
    setNotice(`${name(id)}の下書きを取り消しました。`);
    document.getElementById("changes-heading")?.focus();
  }
  function reset() {
    if (!safe) return;
    setDraft(cloneBindings(baseline));
    setNotice("下書きの変更を取り消しました。");
    document.getElementById("changes-heading")?.focus();
  }
  function tabKey(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next =
      e.key === "Home"
        ? "assign"
        : e.key === "End"
          ? "test"
          : tab === "assign"
            ? "test"
            : "assign";
    setTab(next);
    document.getElementById(`${next}-tab`)?.focus();
  }
  return (
    <Theme theme={neutralTheme} mode={theme}>
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <Logo />
            <h1 style={{ font: "inherit", margin: 0 }}>VANZY Manager</h1>
          </div>
          <div className="connection-pill">
            <i />
            <strong>未接続</strong>
            <span>サンプルを表示中</span>
          </div>
          <span className="spacer" />
          <div className="header-controls">
            <div className="control-pair">
              <span>キー表記</span>
              <Segments
                label="キーのOS表記"
                value={osPref}
                onChange={(v) => setOsPref(v as typeof osPref)}
                items={[
                  ["auto", "自動"],
                  ["windows", "Windows"],
                  ["mac", "macOS"],
                ]}
              />
            </div>
            <div className="control-pair">
              <span>テーマ</span>
              <Segments
                label="テーマ"
                value={theme}
                onChange={(v) => setTheme(v as typeof theme)}
                items={[
                  ["system", "自動"],
                  ["light", "ライト"],
                  ["dark", "ダーク"],
                ]}
              />
            </div>
            <Button
              className="backup-top"
              label="バックアップ"
              icon={<Archive size={16} />}
              isDisabled={!safe || capturing}
              onClick={() => {
                if (safe) setModal("backups");
              }}
            />
            <Button
              className="help-button"
              label="このプレビューについて"
              isIconOnly
              icon={<CircleHelp size={17} />}
              onClick={() => setModal("help")}
            />
          </div>
        </header>
        {!safe && runtime === "安全確認に失敗" && (
          <div className="sample-banner" role="alert">
            安全確認に失敗しました。編集・復元・反映デモを停止しています。下書きは保持しています。アプリを再起動し、解消しなければ診断してください。
          </div>
        )}
        <DevicePanel />
        {page === "main" ? (
          <>
            <div className="banner-wrap">
              <div className="sample-banner">
                <Info size={18} />
                <div>
                  <strong>これはサンプルです</strong>
                  <span>
                    点線で囲まれた値は見本で、あなたのVANZYの設定ではありません。サンプルのあいだは本体に反映できません。
                  </span>
                </div>
                <span className="spacer" />
                <Button
                  label="接続まわりの画面例を見る"
                  onClick={() => setPage("states")}
                />
              </div>
            </div>
            <div className="workspace">
              <nav className="gestures-panel" aria-label="ジェスチャー一覧">
                <div className="gesture-heading">
                  <h2>ジェスチャー</h2>
                  <span className="mono">{GESTURE_CATALOG.length}</span>
                </div>
                {(["air", "touch"] as const).map((group) => (
                  <section
                    className="gesture-group"
                    key={group}
                    aria-label={
                      group === "air" ? "空中ジェスチャー" : "タッチ操作"
                    }
                  >
                    <h3>
                      {group === "air"
                        ? "空中ジェスチャー · 7"
                        : "タッチ操作 · 4"}
                    </h3>
                    <div className="gesture-list">
                      {GESTURE_CATALOG.filter(
                        (item) => item.group === group,
                      ).map(({ id, symbol }) => {
                        const dirty = !equalBinding(baseline[id], draft[id]);
                        return (
                          <button
                            className={`gesture-row ${selected === id ? "selected" : ""} ${draft[id].codes.length > 1 ? "multi-key" : ""}`}
                            key={id}
                            aria-pressed={selected === id}
                            onClick={() => setSelected(id)}
                          >
                            <span className="gesture-symbol" aria-hidden="true">
                              {symbol}
                            </span>
                            <span className="gesture-label">
                              <strong>{name(id)}</strong>
                              <small>
                                {group === "touch"
                                  ? "デモ編集可・実機対応未確定"
                                  : "割当デモ・実機未検証"}
                              </small>
                            </span>
                            <span
                              className={`gesture-cap mono ${dirty ? "changed" : ""}`}
                            >
                              {draft[id].codes.length
                                ? bindingLabel(draft[id], os)
                                : "未割当"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
                <p className="gesture-foot">
                  Androidアプリ解析に基づく11項目です。「未割当」はデモ内の状態で、本体は未読取りです。タッチ操作と実機IDの対応は未確定です。
                </p>
              </nav>
              <main className="center-column">
                <section ref={captureArea} className="editor-panel panel">
                  <div className="editor-heading">
                    <h2>{name(g)}</h2>
                    <span className="status-badge sample">
                      {gestureInfo(g).group === "touch"
                        ? "デモ・実機対応未確定"
                        : "サンプル・実機未検証"}
                    </span>
                    <span className="spacer" />
                    <div
                      className="editor-tabs"
                      role="tablist"
                      aria-label="表示の切り替え"
                    >
                      {(["assign", "test"] as const).map((t) => (
                        <button
                          role="tab"
                          key={t}
                          id={`${t}-tab`}
                          aria-controls={`${t}-panel`}
                          aria-selected={tab === t}
                          tabIndex={tab === t ? 0 : -1}
                          className={tab === t ? "active" : ""}
                          onKeyDown={tabKey}
                          onClick={() => setTab(t)}
                        >
                          {t === "assign" ? "割当" : "テスト"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {tab === "assign" ? (
                    <div
                      id="assign-panel"
                      role="tabpanel"
                      aria-labelledby="assign-tab"
                      className="assignment-panel"
                    >
                      <div className="assignment-hero">
                        <GestureGuide direction={g} />
                        <div className="assigned-value">
                          <span>割り当てるキー</span>
                          <KeyCaps
                            binding={current}
                            os={os}
                            changed={changed}
                          />
                          <small>
                            {changed
                              ? `サンプルの基準値：${bindingLabel(baseline[g], os)}（未反映の変更があります）`
                              : "サンプルの値（本体の設定ではありません）"}
                          </small>
                        </div>
                      </div>
                      <button
                        aria-label={
                          capturing
                            ? "組み合わせを押したまま追加し、離して確定（Escでキャンセル）・キーの記録をキャンセル"
                            : "ここを押して、単独キー・複数キーを記録・キーを記録"
                        }
                        type="button"
                        className={`capture-zone ${capturing ? "recording" : ""}`}
                        disabled={!editable}
                        onClick={() => setCapturing(!capturing)}
                      >
                        <Keyboard size={22} />
                        <span>
                          {capturing
                            ? "組み合わせを押したまま追加し、離して確定（Escでキャンセル）"
                            : "ここを押して、単独キー・複数キーを記録"}
                        </span>
                      </button>
                      <p className="key-hint" role="status">
                        {capturing && capturePreview
                          ? "記録中：" +
                            bindingLabel(capturePreview, os) +
                            "（キーを離すと確定）"
                          : "複数キーは同時押しの組合せです。例：Ctrl + Shift + K、A + B。連続入力のマクロではありません。Esc・OSが先に処理するキーは下の選択欄から追加できます。"}
                      </p>
                      <div className="field-group">
                        <span className="field-title" id="mods-label">
                          修飾キー
                        </span>
                        <div
                          className="modifier-row"
                          role="group"
                          aria-labelledby="mods-label"
                        >
                          {MODIFIERS.map((m) => (
                            <button
                              key={m}
                              aria-label={
                                os === "mac"
                                  ? `${modifierLabel(m, os)} ${{ ctrl: "Control", alt: "Option", shift: "Shift", gui: "Command" }[m]}`
                                  : {
                                      ctrl: "Ctrl",
                                      alt: "Alt",
                                      shift: "Shift",
                                      gui: "Windows",
                                    }[m]
                              }
                              className={
                                current.modifiers.includes(m) ? "on" : ""
                              }
                              aria-pressed={current.modifiers.includes(m)}
                              disabled={
                                !editable || capturing || !current.codes.length
                              }
                              onClick={() => toggle(m)}
                            >
                              {os === "mac" && (
                                <span className="modifier-symbol">
                                  {modifierLabel(m, os)}
                                </span>
                              )}
                              <span>
                                {os === "mac"
                                  ? {
                                      ctrl: "Control",
                                      alt: "Option",
                                      shift: "Shift",
                                      gui: "Command",
                                    }[m]
                                  : {
                                      ctrl: "Ctrl",
                                      alt: "Alt",
                                      shift: "Shift",
                                      gui: "Windows",
                                    }[m]}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="field-group">
                        <span className="field-title" id="keys-label">
                          よく使うキー（単独に置き換え）
                        </span>
                        <div
                          className="keys-row"
                          role="group"
                          aria-labelledby="keys-label"
                        >
                          {COMMON_KEYS.map((k) => (
                            <button
                              aria-label={`キー ${keyLabel(k)}`}
                              key={k}
                              className={current.codes.includes(k) ? "on" : ""}
                              aria-pressed={current.codes.includes(k)}
                              disabled={!editable || capturing}
                              onClick={() => update({ ...current, codes: [k] })}
                            >
                              {keyLabel(k)}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="field-group">
                        <label className="field-title" htmlFor="add-key">
                          組み合わせるキーを追加
                        </label>
                        <div className="add-key-row">
                          <select
                            id="add-key"
                            value={addCode}
                            disabled={!editable || capturing}
                            onChange={(e) => setAddCode(e.target.value)}
                          >
                            <option value="">キーを選択</option>
                            {ASSIGNABLE_KEYS.filter(
                              (code) => !current.codes.includes(code),
                            ).map((code) => (
                              <option key={code} value={code}>
                                {keyLabel(code)}
                              </option>
                            ))}
                          </select>
                          <Button
                            label="キーを追加"
                            isDisabled={!editable || capturing || !addCode}
                            onClick={() => {
                              update({
                                ...current,
                                codes: [...current.codes, addCode],
                              });
                              setAddCode("");
                            }}
                          />
                        </div>
                        <div
                          className="selected-keys"
                          role="group"
                          aria-label="登録中のキー"
                        >
                          {current.codes.map((code) => (
                            <button
                              key={code}
                              aria-label={keyLabel(code) + " を組合せから外す"}
                              disabled={
                                !editable ||
                                capturing ||
                                current.codes.length === 1
                              }
                              onClick={() => {
                                update({
                                  ...current,
                                  codes: current.codes.filter(
                                    (key) => key !== code,
                                  ),
                                });
                              }}
                            >
                              <kbd>{keyLabel(code)}</kbd>
                              <X size={13} aria-hidden="true" />
                            </button>
                          ))}
                        </div>
                        <small className="key-hint">
                          ×で1つずつ外せます。組合せには通常キーが1つ以上必要です。デモ未割当からは、先に通常キーを選んでください。
                        </small>
                        <Button
                          label="デモの割当を空にする"
                          isDisabled={
                            !editable || capturing || !current.codes.length
                          }
                          onClick={() => update({ codes: [], modifiers: [] })}
                        />
                      </div>
                      <div className="os-note">
                        <Monitor size={18} />
                        <span>
                          {osNote}{" "}
                          キー表記を切り替えても、割当の値は変わりません。
                        </span>
                      </div>
                      <div className="editor-footer">
                        <span>
                          変更は「変更トレイ」にたまります。まだ本体には書き込まれていません。
                        </span>
                        <div>
                          <Button
                            label="このジェスチャーを試す"
                            onClick={() => {
                              setTab("test");
                              document.getElementById("test-tab")?.focus();
                            }}
                          />
                          {changed && (
                            <Button
                              className="undo-button"
                              label="この変更を取り消す"
                              icon={<RotateCcw size={14} />}
                              isDisabled={capturing}
                              onClick={() => revert(g)}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div
                      id="test-panel"
                      role="tabpanel"
                      aria-labelledby="test-tab"
                    >
                      <DesignTest
                        logs={testLogs}
                        setLogs={setTestLogs}
                        selected={g}
                        allBaselines={baseline}
                        baseline={baseline[g]}
                        draft={draft[g]}
                        os={os}
                      />
                    </div>
                  )}
                </section>
                <section className="settings-panel panel">
                  <div className="settings-heading">
                    <h2>そのほかの設定</h2>
                    <p>対応が確認できた項目だけ編集できます。</p>
                  </div>
                  <div className="setting-row">
                    <div>
                      <strong>ポインタ速度</strong>
                      <p>実機の値と値域は未確認なので、編集できません。</p>
                    </div>
                    <span className="mono">—</span>
                    <span className="status-badge">読取り未実装</span>
                  </div>
                  <div className="setting-row">
                    <div>
                      <strong>2台で使う（2ch）</strong>
                      <p>
                        接続先は本体で切り替えます。このアプリからは切り替えられません。手順は実機で確かめてから載せます。
                      </p>
                    </div>
                    <span className="status-badge">案内のみ</span>
                  </div>
                </section>
              </main>
              <aside
                className="right-column"
                aria-label="変更トレイと本体の状態"
              >
                <section className="changes-panel panel">
                  <div className="tray-heading">
                    <h2 id="changes-heading" tabIndex={-1}>
                      変更トレイ
                    </h2>
                    <span
                      className={`pending-count ${pending.length ? "has-pending" : ""}`}
                    >
                      {pending.length}件
                    </span>
                  </div>
                  {pending.length ? (
                    <>
                      <div className="change-list">
                        {pending.map((c) => (
                          <div className="change-item" key={c.gesture}>
                            <div className="change-item-heading">
                              <i />
                              <strong>{name(c.gesture)}</strong>
                              <Button
                                className="undo-button"
                                label={`${name(c.gesture)}の変更を取り消す`}
                                icon={<RotateCcw size={14} />}
                                isDisabled={capturing}
                                onClick={() => revert(c.gesture)}
                              >
                                取り消す
                              </Button>
                            </div>
                            <div className="change-values">
                              <del>{bindingLabel(c.before, os)}</del>
                              <ArrowRight size={16} />
                              <strong>{bindingLabel(c.after, os)}</strong>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="change-list-actions">
                        <Button
                          className="undo-button"
                          label="変更をすべて取り消す"
                          icon={<RotateCcw size={14} />}
                          isDisabled={capturing}
                          onClick={reset}
                        >
                          すべて取り消す
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="no-changes">
                      変更はありません。ジェスチャーを選んで編集すると、ここにたまります。
                    </div>
                  )}
                  <ol className="safe-steps">
                    <li>反映の前に、今の本体の設定をバックアップします</li>
                    <li>1件ずつ書き込み、読み戻して確かめます</li>
                    <li>
                      失敗したらそこで止め、どこまで反映したかを表示します
                    </li>
                  </ol>
                  <Button
                    className="apply-button"
                    label="確認して反映する"
                    isDisabled
                    aria-describedby="hardware-disabled-reason"
                    width="100%"
                  />
                  <small
                    id="hardware-disabled-reason"
                    className="disabled-reason"
                  >
                    実機対応時の手順です。このデモでは本体に反映できません。
                  </small>
                  <Button
                    className="mock-action"
                    label="反映フローをプレビュー"
                    isDisabled={!pending.length || !safe || capturing}
                    onClick={() => setModal("apply")}
                  />
                </section>
                <section className="device-panel panel">
                  <h2>本体とこのPC</h2>
                  <dl>
                    <dt>接続</dt>
                    <dd>未接続</dd>
                    <dt>ファームウェア</dt>
                    <dd className="mono">—</dd>
                    <dt>このPC</dt>
                    <dd>{detectedHost}（自動判定）</dd>
                    <dt>このOSからの書込み</dt>
                    <dd>
                      <span className="verification-badge">未検証・無効</span>
                    </dd>
                    <dt>最新のバックアップ</dt>
                    <dd className="mono">—（実機未読取り）</dd>
                  </dl>
                </section>
              </aside>
            </div>
          </>
        ) : (
          <DesignStates
            safe={safe}
            pendingCount={pending.length}
            onSample={() => setPage("main")}
            onDiscard={reset}
            onApply={() => {
              if (safe) setModal("apply");
            }}
            onBackups={() => {
              if (safe) setModal("backups");
            }}
            onNotice={setNotice}
          />
        )}
        <footer className="app-footer">
          <span>
            <Monitor size={13} />
            {runtime}
          </span>
          <button onClick={() => setPage(page === "main" ? "states" : "main")}>
            {page === "main"
              ? "空・エラー状態をプレビュー"
              : "メイン画面に戻る"}
          </button>
          <span>VANZY Manager 0.2.0 · Astryx</span>
        </footer>
        <div className="notice" role="status" aria-live="polite">
          {notice}
        </div>
        {modal === "apply" && safe && (
          <DesignApply
            baseline={baseline}
            draft={draft}
            os={os}
            onClose={() => setModal(null)}
            onOpenBackups={() => setModal("backups")}
            onBackupCreated={(b) => setBackups((v) => [b, ...v])}
            onRestart={(b, d) => {
              setBaseline(cloneBindings(b));
              setDraft(cloneBindings(d));
            }}
            onApplyResult={(result) => {
              setBaseline(cloneBindings(result.baseline));
              setNotice(
                "サンプルの反映プレビューを更新しました。実機には送信していません。",
              );
            }}
          />
        )}
        {modal === "backups" && safe && (
          <DesignBackups
            baseline={baseline}
            draft={draft}
            backups={backups}
            os={os}
            onClose={() => setModal(null)}
            onAddBackup={(b) => setBackups((v) => [b, ...v])}
            onRestoreDraft={(d) => {
              setDraft(d);
              setModal("apply");
              setNotice(
                "復元前の下書きを退避保存し、対象項目をバックアップに合わせました。反映内容を確認してください。実機には反映していません。",
              );
            }}
          />
        )}
        {modal === "help" && <Help onClose={() => setModal(null)} />}
      </div>
    </Theme>
  );
}
