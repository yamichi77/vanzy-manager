import { nativePlatform } from "./native-platform";
import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { DeviceSnapshot } from "./DevicePanel";
import "./host-panel.css";

export type HostStatus = {
  active: boolean;
  phase: string;
  error?: string;
  restored?: boolean;
  eventCount: number;
  lastGesture?: number;
  runtimeMode?: number;
  modeReadAt?: string;
  lastReceivedAt?: string;
};
export type HostBinding = { index: number; keys: number[]; modifiers: number };
const gestures = [
  [1, "空中・左"],
  [2, "空中・右"],
  [3, "空中・上"],
  [4, "空中・下"],
  [5, "空中・反時計回り"],
  [6, "空中・時計回り"],
  [7, "空中・前へ突く"],
  [8, "タッチch0（設定0）"],
  [9, "タッチch1（設定3）"],
  [10, "スワイプ0（設定7）"],
  [11, "スワイプ1（設定8）"],
] as const;
const physicalNames = [
  "左",
  "右",
  "上",
  "下",
  "反時計回り",
  "時計回り",
  "前方",
  "左スワイプ",
  "右スワイプ",
  "左タッチ",
  "右タッチ",
  "○印側へスワイプ",
  "○印と反対側へスワイプ",
  "○印側タッチ",
  "○印と反対側タッチ",
] as const;
const slotReference = (index: number) =>
  index <= 7
    ? `枠${index} / 0x44・設定${index}`
    : `枠${index} / 0x4B・設定${[0, 3, 7, 8][index - 8]}`;
const modifiers = [
  [1, "Ctrl"],
  [2, "Shift"],
  [4, "Alt"],
  [8, "Win"],
] as const;
const keys: [number, string][] = [
  ...Array.from({ length: 26 }, (_, i): [number, string] => [
    i + 4,
    String.fromCharCode(65 + i),
  ]),
  ...Array.from({ length: 10 }, (_, i): [number, string] => [
    0x1e + i,
    String((i + 1) % 10),
  ]),
  [0x50, "←"],
  [0x4f, "→"],
  [0x52, "↑"],
  [0x51, "↓"],
  [0x4b, "PageUp"],
  [0x4e, "PageDown"],
  [0x2c, "Space"],
  [0x28, "Enter"],
  [0x2b, "Tab"],
  [0x29, "Esc"],
  [0x2a, "Backspace"],
  [0x4c, "Delete"],
  [0x4a, "Home"],
  [0x4d, "End"],
];
const hex = (bytes: number[]) =>
  bytes.map((v) => v.toString(16).padStart(2, "0")).join(" ");
const chord = (b: HostBinding) =>
  [
    ...modifiers.filter(([m]) => b.modifiers & m).map(([, n]) => n),
    ...b.keys.map((k) => keys.find(([id]) => id === k)?.[1] ?? String(k)),
  ].join(" + ");
function parseStatus(value: unknown): HostStatus {
  const s = value as HostStatus;
  if (
    !s ||
    typeof s.active !== "boolean" ||
    typeof s.phase !== "string" ||
    !Number.isInteger(s.eventCount) ||
    s.eventCount < 0 ||
    (s.restored != null && typeof s.restored !== "boolean") ||
    (s.runtimeMode != null &&
      (!Number.isInteger(s.runtimeMode) ||
        s.runtimeMode < 0 ||
        s.runtimeMode > 255)) ||
    (s.modeReadAt != null && !Number.isFinite(Date.parse(s.modeReadAt))) ||
    (s.lastReceivedAt != null && !Number.isFinite(Date.parse(s.lastReceivedAt)))
  )
    throw new Error("ホスト状態を確認できません。");
  return s;
}
export default function HostPanel({
  snapshot,
  onInvalidate,
  selectedIndex,
  compact = false,
  onStateChange,
  onBindingsChange,
  onLabelsChange,
  externalBusy = false,
  operationLock,
}: {
  snapshot: DeviceSnapshot | null;
  onInvalidate: () => void;
  selectedIndex?: number;
  compact?: boolean;
  onStateChange?: (
    state: HostStatus | null,
    known: boolean,
    busy: boolean,
  ) => void;
  onBindingsChange?: (bindings: HostBinding[], observeOnly: boolean) => void;
  onLabelsChange?: (labels: Record<string, string>) => void;
  externalBusy?: boolean;
  operationLock?: { current: boolean };
}) {
  const native = nativePlatform(isTauri(), navigator.platform) !== null;
  const [observeOnly, setObserveOnly] = useState(false);
  const [bindings, setBindings] = useState<HostBinding[]>([]);
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [known, setKnown] = useState(false);
  const profileKey = useRef("");
  const labelKey = useRef("");
  const calibrationSession = useRef(false);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [physicalName, setPhysicalName] = useState<string>(physicalNames[0]);
  const [savedEvent, setSavedEvent] = useState(0);
  const consumedEvent = useRef(0);
  const [calibrationNotice, setCalibrationNotice] = useState("");
  const displaySlot = (index: number) =>
    `${labels[String(index)] ?? gestures.find(([id]) => id === index)?.[1] ?? "不明"}（${slotReference(index)}）`;
  useEffect(() => {
    if (!snapshot || status?.active) return;
    const key = `vanzy-physical-labels:${snapshot.deviceId}:${snapshot.touchInverted}`;
    if (labelKey.current === key) return;
    labelKey.current = key;
    setLabels({});
    setSavedEvent(0);
    consumedEvent.current = 0;
    setCalibrationNotice("");
    calibrationSession.current = false;
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
      if (!raw || Array.isArray(raw) || typeof raw !== "object") return;
      const entries = Object.entries(raw);
      if (
        entries.length <= 11 &&
        entries.every(
          ([id, name]) =>
            /^(?:[1-9]|10|11)$/.test(id) &&
            physicalNames.some((n) => n === name),
        ) &&
        new Set(entries.map(([, name]) => name)).size === entries.length
      )
        setLabels(Object.fromEntries(entries) as Record<string, string>);
    } catch {
      setCalibrationNotice(
        "保存済みの物理名を読み込めませんでした。割当先は変更していません。",
      );
    }
  }, [snapshot?.deviceId, snapshot?.touchInverted, status?.active]);
  useEffect(() => {
    onStateChange?.(status, known, busy);
  }, [status, known, busy, onStateChange]);
  useEffect(() => {
    onBindingsChange?.(bindings, observeOnly);
  }, [bindings, observeOnly, onBindingsChange]);
  useEffect(() => {
    onLabelsChange?.(labels);
  }, [labels, onLabelsChange]);
  const canCalibrate =
    native &&
    known &&
    !busy &&
    observeOnly &&
    status?.active &&
    calibrationSession.current &&
    !!labelKey.current &&
    status.lastGesture != null &&
    gestures.some(([id]) => id === status.lastGesture) &&
    status.eventCount > savedEvent;
  const saveCalibration = () => {
    if (
      !canCalibrate ||
      !status ||
      status.lastGesture == null ||
      status.eventCount <= consumedEvent.current
    )
      return;
    const index = String(status.lastGesture);
    const previous = Object.entries(labels).find(
      ([id, name]) => name === physicalName && id !== index,
    )?.[0];
    if (
      previous &&
      !window.confirm(
        `${physicalName}は${slotReference(Number(previous))}に登録済みです。今回受信した${slotReference(Number(index))}へ関連付けを移しますか？`,
      )
    )
      return;
    const next = { ...labels };
    if (previous) delete next[previous];
    next[index] = physicalName;
    try {
      localStorage.setItem(labelKey.current, JSON.stringify(next));
      setLabels(next);
      consumedEvent.current = status.eventCount;
      setSavedEvent(status.eventCount);
      setCalibrationNotice(
        `${physicalName}を${slotReference(Number(index))}へ保存しました。次の操作を行ってください。`,
      );
    } catch {
      setCalibrationNotice(
        "物理名を保存できませんでした。端末の保存領域を確認してください。",
      );
    }
  };
  useEffect(() => {
    if (!snapshot) return;
    const id = `vanzy-host-profile:${snapshot.deviceId}:${snapshot.touchInverted}`;
    if (profileKey.current === id) return;
    profileKey.current = id;
    try {
      const raw = JSON.parse(localStorage.getItem(id) ?? "[]");
      if (
        Array.isArray(raw) &&
        raw.length <= 11 &&
        raw.every(
          (b) =>
            Number.isInteger(b.index) &&
            b.index >= 1 &&
            b.index <= 11 &&
            Array.isArray(b.keys) &&
            b.keys.length <= 6 &&
            b.keys.every(
              (v: unknown) =>
                Number.isInteger(v) && Number(v) >= 4 && Number(v) <= 0x65,
            ) &&
            Number.isInteger(b.modifiers) &&
            b.modifiers >= 0 &&
            b.modifiers <= 15,
        )
      ) {
        setBindings(raw);
      }
    } catch {
      /* Invalid saved drafts never authorize a device write. */
    }
  }, [snapshot?.deviceId, snapshot?.touchInverted]);
  const lock = useRef(false);
  const mounted = useRef(true);
  const refresh = async () => {
    const s = parseStatus(await invoke("host_status"));
    if (mounted.current) {
      setStatus(s);
      setKnown(true);
    }
    return s;
  };
  useEffect(() => {
    mounted.current = true;
    if (native)
      void refresh().catch((e) => {
        if (mounted.current) {
          setKnown(false);
          setError(String(e));
        }
      });
    return () => {
      mounted.current = false;
    };
  }, [native]);
  useEffect(() => {
    if (!native || !status?.active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled) return;
      try {
        if (!lock.current) await refresh();
      } catch (e) {
        if (!cancelled) {
          setKnown(false);
          setError(String(e));
        }
      }
      if (!cancelled) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [native, status?.active]);
  const restoreFailed =
    !status?.active &&
    (status?.restored === false || status?.phase === "restore-unconfirmed");
  const frozen =
    externalBusy || busy || !!status?.active || !known || !!restoreFailed;
  const valid =
    bindings.length > 0 &&
    bindings.every(
      (b) =>
        observeOnly ||
        (b.keys.length <= 6 && (b.keys.length > 0 || b.modifiers === 8)),
    );
  const update = (index: number, patch: Partial<HostBinding>) =>
    setBindings((bs) =>
      bs.map((b) => (b.index === index ? { ...b, ...patch } : b)),
    );
  const operate = async (start: boolean) => {
    if (
      lock.current ||
      operationLock?.current ||
      externalBusy ||
      (start && (!snapshot || frozen || !valid))
    )
      return;
    const diff = bindings
      .map(
        (b) =>
          `${displaySlot(b.index)}\n元の本体設定: ${hex(snapshot?.maps[String(b.index)] ?? [])}\nホスト割当: ${observeOnly ? "通知の確認のみ（キーを送らない）" : chord(b)}`,
      )
      .join("\n\n");
    if (
      !window.confirm(
        start
          ? `選択した操作を専用通知（0xC0）へ変更します。\n${diff}\n\nアプリ起動中のみ動作します。停止時に元の設定へ戻します。開始しますか？`
          : "ホスト処理を停止し、保存した元の本体設定へ復元しますか？",
      )
    )
      return;
    lock.current = true;
    if (operationLock) operationLock.current = true;
    setBusy(true);
    setError("");
    try {
      if (start) {
        // Capture the device/inversion identity before onInvalidate clears the snapshot.
        labelKey.current = `vanzy-physical-labels:${snapshot!.deviceId}:${snapshot!.touchInverted}`;
        calibrationSession.current = observeOnly;
        setSavedEvent(0);
        consumedEvent.current = 0;
        setCalibrationNotice("");
      }
      if (start)
        await invoke("host_start", {
          snapshotId: snapshot!.snapshotId,
          bindings,
          observeOnly,
        });
      else await invoke("host_stop");
      if (start && !observeOnly && profileKey.current) {
        localStorage.setItem(profileKey.current, JSON.stringify(bindings));
      }
      onInvalidate();
      await refresh();
    } catch (e) {
      onInvalidate();
      setKnown(false);
      setError(String(e));
      try {
        await refresh();
      } catch (se) {
        setError(`${String(e)} 状態確認も失敗: ${String(se)}`);
      }
    } finally {
      lock.current = false;
      if (operationLock) operationLock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section
      className={`host-panel${compact ? " host-panel-compact" : ""}`}
      aria-label="PCで変換"
    >
      <h2>PCで変換</h2>
      <p>
        最大6キー＋修飾キーの同時押しを、このアプリからPCへ送ります（Gestureモードのみ）。
      </p>
      <button
        className="device-button"
        disabled={externalBusy || busy || !!status?.active}
        onClick={async () => {
          if (externalBusy || lock.current || operationLock?.current) return;
          if (
            !window.confirm(
              "中断したホスト割当のバックアップを読み、専用通知のまま残った設定を元へ復元しますか？",
            )
          )
            return;
          lock.current = true;
          if (operationLock) operationLock.current = true;
          setBusy(true);
          try {
            await invoke("host_recover");
            onInvalidate();
            await refresh();
          } catch (e) {
            onInvalidate();
            setKnown(false);
            setError(String(e));
          } finally {
            lock.current = false;
            if (operationLock) operationLock.current = false;
            setBusy(false);
          }
        }}
      >
        中断したホスト設定を復旧
      </button>
      <p className="host-note">
        動作中はアプリを閉じず、終了前に「停止して元の設定へ復元」を押してください。
      </p>
      {!native ? (
        <p>実機機能はWindows・macOSネイティブ版でのみ利用可</p>
      ) : (
        <>
          <p role="status">
            状態:{" "}
            {known
              ? `${status?.phase} / ${status?.active ? "実行中" : "停止中"}`
              : "未確認"}{" "}
            {status && `・受信 ${status.eventCount} 回`}{" "}
            {status?.lastGesture != null &&
              `・最終 ${displaySlot(status.lastGesture)}`}
          </p>
          {status?.runtimeMode != null && (
            <p>
              本体モード: {status.runtimeMode}（
              {status.modeReadAt
                ? new Date(status.modeReadAt).toLocaleTimeString()
                : "時刻不明"}
              ）
            </p>
          )}
          {status?.lastReceivedAt && (
            <p>
              最終通知受信:{" "}
              {new Date(status.lastReceivedAt).toLocaleTimeString()}
            </p>
          )}
          {(error || status?.error || restoreFailed) && (
            <p className="host-error" role="alert">
              {error || status?.error}{" "}
              {restoreFailed &&
                "元の設定への復元を確認できていません。再開せず、停止・復元の結果を確認してください。"}
            </p>
          )}
          {!snapshot && <p>開始するには、先に本体を読み取ってください。</p>}
          <label>
            <input
              type="checkbox"
              checked={observeOnly}
              disabled={frozen}
              onChange={(e) => {
                setObserveOnly(e.target.checked);
                if (e.target.checked)
                  setBindings(
                    gestures.map(([index]) => ({
                      index,
                      keys: [],
                      modifiers: 0,
                    })),
                  );
                else setBindings([]);
              }}
            />{" "}
            キーを送らず11操作の通知だけ確認する
          </label>
          <details className="host-calibration" open={observeOnly || undefined}>
            <summary>物理ジェスチャーの名前合わせ</summary>

            <p>
              未校正: {11 - Object.keys(labels).length} /
              11。名前だけを保存し、割当は変えません。
            </p>
            {observeOnly && status?.active && (
              <>
                <p>ジェスチャーを動かしてから、その名前を選んで保存します。</p>
                <label>
                  実際に行ったジェスチャー
                  <select
                    value={physicalName}
                    onChange={(e) => setPhysicalName(e.target.value)}
                  >
                    {physicalNames.map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                </label>
                <button disabled={!canCalibrate} onClick={saveCalibration}>
                  最後に受信した枠へ名前を保存
                </button>
                {!canCalibrate && (
                  <small>新しい通知を待っています。</small>
                )}
              </>
            )}
            {Object.keys(labels).length > 0 && (
              <ul>
                {Object.entries(labels).map(([id, name]) => (
                  <li key={id}>
                    {name} — {slotReference(Number(id))}
                  </li>
                ))}
              </ul>
            )}
            {calibrationNotice && <p role="status">{calibrationNotice}</p>}
          </details>
          <div className="host-slots">
            {gestures.map(([index]) => {
              const b = bindings.find((v) => v.index === index);
              return (
                <fieldset
                  key={index}
                  hidden={selectedIndex != null && selectedIndex !== index}
                  disabled={frozen || !snapshot}
                >
                  <legend>{displaySlot(index)}</legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!b}
                      onChange={(e) =>
                        setBindings((bs) =>
                          e.target.checked
                            ? [...bs, { index, keys: [], modifiers: 0 }]
                            : bs.filter((v) => v.index !== index),
                        )
                      }
                    />
                    ホストに割り当てる
                  </label>
                  {b && (
                    <>
                      <div className="host-modifiers">
                        {modifiers.map(([m, label]) => (
                          <label key={m}>
                            <input
                              type="checkbox"
                              checked={!!(b.modifiers & m)}
                              onChange={(e) =>
                                update(index, {
                                  modifiers: e.target.checked
                                    ? b.modifiers | m
                                    : b.modifiers & ~m,
                                })
                              }
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                      <label>
                        通常キー（最大6個）
                        <select
                          multiple
                          size={6}
                          value={b.keys.map(String)}
                          onChange={(e) => {
                            const selected = Array.from(
                              e.currentTarget.selectedOptions,
                              (o) => Number(o.value),
                            );
                            if (selected.length > 6) {
                              setError("通常キーは最大6個まで選択できます。");
                              return;
                            }
                            setError("");
                            update(index, { keys: selected });
                          }}
                        >
                          {keys.map(([id, label]) => (
                            <option key={id} value={id}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <small>Ctrl＋クリックで複数選択</small>
                      <p>
                        新しい割当: <strong>{chord(b) || "未選択"}</strong>
                      </p>
                      <p className="host-raw">
                        元の本体設定: {hex(snapshot?.maps[String(index)] ?? [])}
                      </p>
                    </>
                  )}
                </fieldset>
              );
            })}
          </div>
          <div className="host-actions">
            <button
              disabled={frozen || !snapshot || !valid}
              onClick={() => void operate(true)}
            >
              差分を確認して開始
            </button>
            <button
              disabled={
                busy || (known && !status?.active && status?.restored !== false)
              }
              onClick={() => void operate(false)}
            >
              停止して元の設定へ復元
            </button>
            <button
              disabled={busy}
              onClick={() => {
                void refresh()
                  .then(() => setError(""))
                  .catch((e) => {
                    setKnown(false);
                    setError(String(e));
                  });
              }}
            >
              状態を再確認
            </button>
          </div>
          {status?.restored === true && !status.active && (
            <p>元の設定に戻しました。次の開始前に本体を読み直してください。</p>
          )}
        </>
      )}
    </section>
  );
}
