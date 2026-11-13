import { useEffect, useId, useRef, useState } from "react";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import "./device-panel.css";
import HostPanel from "./HostPanel";
import {
  builtinActionDescription,
  FIRMWARE_DEFAULT_CODE,
  firmwareDefaultMap,
  supportsFirmwareDefaults,
} from "./firmware-defaults";

export type DeviceSnapshot = {
  snapshotId: string;
  deviceId: string;
  product: string;
  firmware: string;
  capturedAt: string;
  maps: Record<string, number[]>;
  touchInverted: boolean;
  backupPath: string;
  undo?: {
    index: number;
    target: number[];
    entries?: { index: number; target: number[] }[];
  } | null;
};
export type BatchChange = {
  index: number;
  expected: number[];
  target: number[];
};
export type BatchProgress = {
  index: number;
  status: "running" | "verified" | "uncertain" | "not_applied";
  completed: number;
  total: number;
  backupPath?: string;
  error?: string;
};
export type BatchResult = {
  outcome: "complete" | "stopped" | "failed";
  items: {
    index: number;
    status: "verified" | "uncertain" | "not_applied" | "pending";
    error?: string;
  }[];
  snapshot: DeviceSnapshot | null;
  backupPath?: string;
  error?: string;
};
export const deviceGestures = [
  [1, "左"],
  [2, "右"],
  [3, "上"],
  [4, "下"],
  [5, "反時計回り（実動作未確認）"],
  [6, "時計回り（実動作未確認）"],
  [7, "前方（実動作未確認）"],
  [8, "タッチ ch0（設定0）"],
  [9, "タッチ ch1（設定3）"],
  [10, "スワイプ0（設定7）"],
  [11, "スワイプ1（設定8）"],
] as const;
const specialKeys = [
  ["WindowsOnly", "Windowsキー単独", 0],
  ["ArrowLeft", "←", 0x50],
  ["ArrowRight", "→", 0x4f],
  ["ArrowUp", "↑", 0x52],
  ["ArrowDown", "↓", 0x51],
  ["PageUp", "PgUp", 0x4b],
  ["PageDown", "PgDn", 0x4e],
  ["Space", "Space", 0x2c],
  ["Enter", "Enter", 0x28],
  ["Tab", "Tab", 0x2b],
  ["Escape", "Esc", 0x29],
  ["Backspace", "Backspace", 0x2a],
  ["Delete", "Delete", 0x4c],
  ["Home", "Home", 0x4a],
  ["End", "End", 0x4d],
] as const;
export const deviceKeys: { code: string; label: string; usage: number }[] = [
  ...specialKeys.map(([code, label, usage]) => ({ code, label, usage })),
  ...Array.from({ length: 26 }, (_, i) => ({
    code: `Key${String.fromCharCode(65 + i)}`,
    label: String.fromCharCode(65 + i),
    usage: 4 + i,
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    code: `Digit${(i + 1) % 10}`,
    label: String((i + 1) % 10),
    usage: 0x1e + i,
  })),
];
export const deviceModifiers = [
  [1, "Ctrl"],
  [2, "Shift"],
  [4, "Alt"],
  [8, "Win"],
] as const;
export const deviceHex = (bytes: number[]) =>
  bytes.map((v) => v.toString(16).padStart(2, "0")).join(" ");
const equal = (a: number[], b: number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const validBytes = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length === 15 &&
  value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
function validateSnapshot(value: unknown): DeviceSnapshot {
  const snapshot = value as Partial<DeviceSnapshot> | null;
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    ![
      snapshot.snapshotId,
      snapshot.deviceId,
      snapshot.product,
      snapshot.firmware,
      snapshot.backupPath,
    ].every((v) => typeof v === "string" && v.trim().length > 0) ||
    typeof snapshot.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
    typeof snapshot.touchInverted !== "boolean" ||
    !snapshot.maps ||
    typeof snapshot.maps !== "object" ||
    Object.keys(snapshot.maps).length !== 11 ||
    !deviceGestures.every(([id]) => validBytes(snapshot.maps?.[String(id)]))
  ) {
    throw new Error(
      "読取り結果またはバックアップの情報を確認できません。再読取りが必要です。",
    );
  }
  if (
    snapshot.undo != null &&
    (typeof snapshot.undo !== "object" ||
      !deviceGestures.some(([id]) => id === snapshot.undo!.index) ||
      !validBytes(snapshot.undo.target))
  ) {
    throw new Error("復元情報を確認できません。再読取りしてください。");
  }
  if (
    snapshot.undo?.entries != null &&
    (!Array.isArray(snapshot.undo.entries) ||
      !snapshot.undo.entries.length ||
      snapshot.undo.entries.length > 11 ||
      new Set(snapshot.undo.entries.map((entry) => entry.index)).size !==
        snapshot.undo.entries.length ||
      snapshot.undo.entries.some(
        (entry) =>
          !deviceGestures.some(([id]) => id === entry.index) ||
          !validBytes(entry.target),
      ))
  )
    throw new Error(
      "まとめた変更の復元情報を確認できません。再読取りしてください。",
    );
  return snapshot as DeviceSnapshot;
}
export function currentDescription(bytes: number[]) {
  const builtin = builtinActionDescription(bytes);
  if (builtin) return builtin;
  if (equal(bytes, [5, 8, 0, ...Array<number>(12).fill(0)]))
    return "Windowsキー単独";
  if (
    bytes[0] === 5 &&
    bytes[1] <= 15 &&
    bytes.slice(3).every((v) => v === 0)
  ) {
    const key = deviceKeys.find(
      (item) => item.usage !== 0 && item.usage === bytes[2],
    );
    if (key)
      return [
        ...deviceModifiers
          .filter(([bit]) => bytes[1] & bit)
          .map(([, label]) => label),
        key.label,
      ].join(" + ");
  }
  return "複合アクション／未対応の割り当て（生データを保持）";
}

export function draftTarget(
  index: number,
  code: string,
  mask: number,
  snapshot: DeviceSnapshot | null,
): number[] | null {
  if (code === FIRMWARE_DEFAULT_CODE)
    return supportsFirmwareDefaults(snapshot)
      ? firmwareDefaultMap(index)
      : null;
  const key = deviceKeys.find((item) => item.code === code);
  return key
    ? [
        5,
        code === "WindowsOnly" ? 8 : mask,
        key.usage,
        ...Array<number>(12).fill(0),
      ]
    : null;
}

function validateBatchResult(
  value: unknown,
  changes: BatchChange[],
  before: DeviceSnapshot,
): BatchResult {
  const result = value as BatchResult | null;
  if (
    !result ||
    !["complete", "stopped", "failed"].includes(result.outcome) ||
    !Array.isArray(result.items) ||
    result.items.length !== changes.length ||
    result.items.some(
      (item, i) =>
        item.index !== changes[i].index ||
        !["verified", "uncertain", "not_applied", "pending"].includes(
          item.status,
        ),
    )
  ) {
    throw new Error(
      "まとめた変更の結果を確認できません。再読取りしてください。",
    );
  }
  let stopped = false;
  for (const item of result.items) {
    if (item.status !== "verified") stopped = true;
    else if (stopped)
      throw new Error("反映順序の結果が不正です。再読取りしてください。");
  }
  if (result.outcome === "complete") {
    const next = validateSnapshot(result.snapshot);
    const targets = new Map(
      changes.map((change) => [change.index, change.target]),
    );
    if (
      result.items.some((item) => item.status !== "verified") ||
      next.deviceId !== before.deviceId ||
      next.firmware !== before.firmware ||
      next.touchInverted !== before.touchInverted ||
      deviceGestures.some(
        ([id]) =>
          !equal(
            next.maps[String(id)],
            targets.get(id) ?? before.maps[String(id)],
          ),
      )
    ) {
      throw new Error(
        "書込み後の読戻しが一致しません。結果は未確認です。再読取りしてください。",
      );
    }
  }
  return result;
}

/** Separate from demo state and demo backups. No automatic reads or device writes. */
export function useDeviceController() {
  const titleId = useId();
  const inputId = useId();
  const [snapshot, setSnapshot] = useState<DeviceSnapshot | null>(null);
  const [index, setIndex] = useState(1);
  const [code, setCode] = useState("");
  const [mask, setMask] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [confirming, setConfirming] = useState<"apply" | "restore" | null>(
    null,
  );
  const busyRef = useRef(false);
  const batchActive = useRef(false);
  const cancelRequested = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const nativeWindows = isTauri() && /Win/i.test(navigator.platform);
  const current = snapshot?.maps[String(index)];
  const key = deviceKeys.find((item) => item.code === code);
  const defaultTarget = supportsFirmwareDefaults(snapshot)
    ? firmwareDefaultMap(index)
    : null;
  const target = draftTarget(index, code, mask, snapshot);
  const changed = Boolean(current && target && !equal(current, target));
  const writable = snapshot?.firmware === "3.2.1";
  const proposed =
    code === FIRMWARE_DEFAULT_CODE && defaultTarget
      ? currentDescription(defaultTarget)
      : code === "WindowsOnly"
        ? "Windowsキー単独"
        : key
          ? [
              ...deviceModifiers
                .filter(([bit]) => mask & bit)
                .map(([, label]) => label),
              key.label,
            ].join(" + ")
          : "";

  async function operate(
    write: boolean,
    restore = false,
  ): Promise<DeviceSnapshot | null> {
    const operationIndex = restore ? snapshot?.undo?.index : index;
    const operationCurrent = operationIndex
      ? snapshot?.maps[String(operationIndex)]
      : undefined;
    const operationTarget = restore ? snapshot?.undo?.target : target;
    if (!nativeWindows || busyRef.current) return null;
    if (
      write &&
      (!confirming ||
        !snapshot ||
        !operationIndex ||
        !operationCurrent ||
        !operationTarget ||
        !writable ||
        (!restore && !changed) ||
        (restore && !snapshot.undo))
    )
      return null;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    setConfirming(null);
    try {
      const value: unknown = write
        ? restore
          ? await invoke("device_restore_previous", {
              snapshotId: snapshot!.snapshotId,
            })
          : await invoke("device_apply_map", {
              request: {
                snapshotId: snapshot!.snapshotId,
                index,
                expected: [...current!],
                target: [...target!],
              },
            })
        : await invoke("device_read_snapshot");
      const next = validateSnapshot(value);
      if (
        write &&
        (next.deviceId !== snapshot!.deviceId ||
          next.firmware !== snapshot!.firmware ||
          next.touchInverted !== snapshot!.touchInverted ||
          deviceGestures.some(
            ([id]) =>
              id !== operationIndex &&
              !equal(next.maps[String(id)], snapshot!.maps[String(id)]),
          ) ||
          !equal(next.maps[String(operationIndex)], operationTarget!))
      ) {
        throw new Error(
          "書込み後の読戻しが一致しません。結果は未確認です。再読取りしてください。",
        );
      }
      if (mounted.current) {
        setSnapshot(next);
        setCode("");
        setMask(0);
        setStatus(
          write
            ? "書込み後の読戻しが一致しました。"
            : "実機から読み取り、バックアップを保存しました。",
        );
      }
      return next;
    } catch (cause) {
      if (mounted.current) {
        setSnapshot(null);
        setCode("");
        setMask(0);
        setError(
          `${write ? "書込みの完了を確認できません。自動で再試行しません。 " : ""}${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      return null;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function operateBatch(
    changes: BatchChange[],
    restore: boolean,
    onProgress: (event: BatchProgress) => void,
  ): Promise<BatchResult> {
    if (
      !nativeWindows ||
      busyRef.current ||
      !confirming ||
      !snapshot ||
      !writable ||
      !changes.length ||
      changes.length > 11
    )
      throw new Error("本体を読み直してから変更を確認してください。");
    const before = snapshot;
    const planned = changes.map((change) => ({
      index: change.index,
      expected: [...change.expected],
      target: [...change.target],
    }));
    if (
      new Set(planned.map((change) => change.index)).size !== planned.length ||
      planned.some(
        (change) =>
          !validBytes(change.expected) ||
          !validBytes(change.target) ||
          !before.maps[String(change.index)] ||
          !equal(change.expected, before.maps[String(change.index)]),
      )
    )
      throw new Error("確認した差分と現在値が一致しません。");
    busyRef.current = true;
    batchActive.current = true;
    cancelRequested.current = false;
    setBusy(true);
    setError("");
    setStatus("");
    setConfirming(null);
    const progress = new Channel<BatchProgress>();
    progress.onmessage = (event) => {
      if (
        mounted.current &&
        batchActive.current &&
        planned.some((change) => change.index === event.index) &&
        event.total === planned.length &&
        ["running", "verified", "uncertain", "not_applied"].includes(
          event.status,
        )
      )
        onProgress(event);
    };
    try {
      const result = validateBatchResult(
        await invoke("device_apply_batch", {
          request: { snapshotId: before.snapshotId, changes: planned, restore },
          progress,
        }),
        planned,
        before,
      );
      if (mounted.current) {
        setSnapshot(result.outcome === "complete" ? result.snapshot : null);
        setStatus(
          result.outcome === "complete"
            ? "すべての変更の読戻しが一致しました。"
            : "残りの変更は下書きに保持しています。本体を読み直してから確認してください。",
        );
        if (result.outcome === "failed")
          setError(
            result.error ||
              "一部の反映結果を確認できません。自動で再試行しません。",
          );
      }
      return result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (mounted.current) {
        setSnapshot(null);
        setError(message);
      }
      throw new Error(message);
    } finally {
      batchActive.current = false;
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function cancelBatch() {
    if (!batchActive.current || cancelRequested.current) return false;
    cancelRequested.current = true;
    try {
      return await invoke<boolean>("device_cancel_batch");
    } catch (cause) {
      cancelRequested.current = false;
      throw cause;
    }
  }

  return {
    titleId,
    inputId,
    snapshot,
    setSnapshot,
    index,
    setIndex,
    code,
    setCode,
    mask,
    setMask,
    busy,
    error,
    status,
    setStatus,
    confirming,
    setConfirming,
    nativeWindows,
    current,
    target,
    defaultTarget,
    changed,
    writable,
    proposed,
    key,
    operate,
    operateBatch,
    cancelBatch,
  };
}
export function DevicePanel() {
  const {
    titleId,
    inputId,
    snapshot,
    setSnapshot,
    index,
    setIndex,
    code,
    setCode,
    mask,
    setMask,
    busy,
    error,
    status,
    setStatus,
    confirming,
    setConfirming,
    nativeWindows,
    current,
    target,
    changed,
    writable,
    proposed,
    key,
    operate,
  } = useDeviceController();
  return (
    <>
      <section className="device-panel" aria-labelledby={titleId}>
        <div className="device-panel-heading">
          <div>
            <p className="device-eyebrow">WINDOWS · 実機</p>
            <h2 id={titleId}>本体の設定</h2>
          </div>
          <span className="device-state">
            {busy ? "通信中" : snapshot ? "読取り済み" : "未読取り"}
          </span>
        </div>
        <p>
          現在の本体設定を読み取ってから変更します。プレビュー用のサンプルやJSONは本体へ送りません。
        </p>
        {!nativeWindows ? (
          <p className="device-note">
            実機機能はWindowsネイティブ版でのみ利用できます。ブラウザー版からは接続・書込みしません。
          </p>
        ) : (
          <>
            <p className="device-note">
              解析済み11設定に通常キー1個と修飾キー、またはWin単独を書き込めます。タッチ・スワイプの物理的な左右は未校正です。回転・前方は公式ガイド名で、実動作は未確認です。複数通常キーの同時押しはホスト機能を使用してください。
            </p>
            <button
              className="device-button"
              disabled={busy || Boolean(confirming)}
              onClick={() => void operate(false)}
            >
              {busy
                ? "通信結果を待っています…"
                : "本体から読み取り・バックアップ"}
            </button>
            {error && (
              <p role="alert" className="device-error">
                {error} 本体を再読取りするまで書込みはできません。
              </p>
            )}
            {status && (
              <p role="status" className="device-success">
                {status}
              </p>
            )}
            {snapshot && (
              <>
                <dl className="device-facts">
                  <div>
                    <dt>対象</dt>
                    <dd>{snapshot.product}</dd>
                  </div>
                  <div>
                    <dt>ファームウェア</dt>
                    <dd>{snapshot.firmware}</dd>
                  </div>
                  <div>
                    <dt>タッチ反転</dt>
                    <dd>
                      {snapshot.touchInverted ? "有効" : "無効"}
                      （物理左右未校正）
                    </dd>
                  </div>
                  <div>
                    <dt>取得日時</dt>
                    <dd>{new Date(snapshot.capturedAt).toLocaleString()}</dd>
                  </div>
                  <div className="device-backup">
                    <dt>保存先</dt>
                    <dd>{snapshot.backupPath}</dd>
                  </div>
                </dl>
                {!writable && (
                  <p className="device-error" role="alert">
                    このファームウェアへの書込みは未検証です。読取り結果のみ表示します。
                  </p>
                )}
                <fieldset
                  disabled={busy || Boolean(confirming) || !writable}
                  className="device-edit"
                >
                  <legend>本体用の変更を準備</legend>
                  <label htmlFor={`${inputId}-gesture`}>ジェスチャー</label>
                  <select
                    id={`${inputId}-gesture`}
                    value={index}
                    onChange={(event) => {
                      setIndex(Number(event.target.value));
                      setCode("");
                      setMask(0);
                    }}
                  >
                    {deviceGestures.map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}（設定 {id}）
                      </option>
                    ))}
                  </select>
                  <div className="device-current">
                    <span>読取り時の割り当て</span>
                    <strong>{currentDescription(current!)}</strong>
                    <code>{deviceHex(current!)}</code>
                  </div>
                  <label htmlFor={`${inputId}-key`}>変更先のキー</label>
                  <select
                    id={`${inputId}-key`}
                    value={code}
                    onChange={(event) => {
                      setCode(event.target.value);
                      setMask(0);
                    }}
                  >
                    <option value="">キーを選択してください</option>
                    {deviceKeys.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                  <div
                    className="device-modifiers"
                    role="group"
                    aria-label="本体用の修飾キー"
                  >
                    {deviceModifiers.map(([bit, label]) => (
                      <label key={bit}>
                        <input
                          type="checkbox"
                          disabled={code === "WindowsOnly"}
                          checked={Boolean(mask & bit)}
                          onChange={(event) =>
                            setMask((value) =>
                              event.target.checked ? value | bit : value & ~bit,
                            )
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  <button
                    className="device-button"
                    disabled={!changed}
                    onClick={() => setConfirming("apply")}
                  >
                    本体への変更を確認
                  </button>
                  {key && !changed && <p>読取り時の割り当てと同じです。</p>}
                </fieldset>
                {snapshot.undo && !confirming && (
                  <button
                    className="device-button device-undo"
                    disabled={busy || !writable}
                    onClick={() => setConfirming("restore")}
                  >
                    直前の割当へ戻す
                  </button>
                )}
                {confirming === "restore" && snapshot.undo && (
                  <div
                    className="device-confirm"
                    role="region"
                    aria-label="本体の復元確認"
                  >
                    <h3>
                      {
                        deviceGestures.find(
                          ([id]) => id === snapshot.undo!.index,
                        )?.[1]
                      }
                      を直前の割り当てに戻しますか？
                    </h3>
                    <p>
                      {snapshot.product} · FW {snapshot.firmware}
                    </p>
                    <div className="device-diff">
                      <span>
                        現在：
                        {currentDescription(
                          snapshot.maps[String(snapshot.undo.index)],
                        )}
                      </span>
                      <code>
                        {deviceHex(snapshot.maps[String(snapshot.undo.index)])}
                      </code>
                      <strong>
                        復元先：{currentDescription(snapshot.undo.target)}
                      </strong>
                      <code>{deviceHex(snapshot.undo.target)}</code>
                    </div>
                    <p>
                      直前の書込み前に保存した生データを、この1件だけ本体へ戻します。デモのバックアップは使いません。
                    </p>
                    <div className="device-actions">
                      <button
                        className="device-button"
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                      >
                        戻る
                      </button>
                      <button
                        className="device-button device-primary"
                        disabled={busy}
                        onClick={() => void operate(true, true)}
                      >
                        この1件を復元する
                      </button>
                    </div>
                  </div>
                )}
                {confirming === "apply" && current && target && (
                  <div
                    className="device-confirm"
                    role="region"
                    aria-label="本体への書込み確認"
                  >
                    <h3>
                      {deviceGestures.find(([id]) => id === index)?.[1]}
                      の割り当てを変更しますか？
                    </h3>
                    <p>
                      {snapshot.product} · FW {snapshot.firmware}
                    </p>
                    <div className="device-diff">
                      <span>変更前：{currentDescription(current)}</span>
                      <code>{deviceHex(current)}</code>
                      <strong>変更後：{proposed}</strong>
                      <code>{deviceHex(target)}</code>
                    </div>
                    <p>
                      この設定の5枠を上記の1キーに置き換えます。他の設定は変更しません。書込み直前の再読取りとバックアップ保存に失敗した場合は停止します。
                    </p>
                    <div className="device-actions">
                      <button
                        className="device-button"
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                      >
                        戻る
                      </button>
                      <button
                        className="device-button device-primary"
                        disabled={busy}
                        onClick={() => void operate(true)}
                      >
                        この1件を本体へ書き込む
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </section>
      {nativeWindows && (
        <HostPanel
          snapshot={snapshot}
          onInvalidate={() => {
            setSnapshot(null);
            setCode("");
            setStatus("");
          }}
        />
      )}
    </>
  );
}
