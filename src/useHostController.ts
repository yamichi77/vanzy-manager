import { isMacHost, nativePlatform } from "./native-platform";
/** Host ("アプリ経由") session control for the native UI, extracted from HostPanel.
 * Same guards: explicit start/stop/recover only, one operation at a time, fail closed
 * when status cannot be confirmed, and stored data never authorizes a device write. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { DeviceSnapshot } from "./DevicePanel";
import type { HostBinding, HostStatus } from "./HostPanel";
import type { MacroBinding } from "./useMacroProfile";
import { validMacroProfile } from "./useMacroProfile";

export const PHYSICAL_NAMES = [
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

export const slotReference = (index: number) =>
  index <= 7
    ? `枠${index} / 0x44・設定${index}`
    : `枠${index} / 0x4B・設定${[0, 3, 7, 8][index - 8]}`;

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
    throw new Error("アプリ経由の送信の状態を確認できません。");
  return s;
}

const validProfile = (raw: unknown): raw is HostBinding[] =>
  Array.isArray(raw) &&
  raw.length <= 11 &&
  new Set(raw.map((b) => b?.index)).size === raw.length &&
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
      b.modifiers <= 15 &&
      (b.keys.length > 0 || b.modifiers === 8),
  );

type Options = {
  /** `${deviceId}:${touchInverted}` of the last verified read, kept while sending. */
  identity: string;
  macros?: MacroBinding[];
  externalBusy: boolean;
  operationLock: MutableRefObject<boolean>;
  onInvalidate: () => void;
  confirmAction?: (message: string) => Promise<boolean>;
};

export function useHostController({
  identity,
  macros = [],
  externalBusy,
  operationLock,
  onInvalidate,
  confirmAction,
}: Options) {
  const ask = (message: string) => confirmAction ? confirmAction(message) : Promise.resolve(window.confirm(message));
  const native = nativePlatform(isTauri(), navigator.platform) !== null;
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [known, setKnown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [permissionNotice, setPermissionNotice] = useState("");
  const permissionRequested = useRef(false);
  const [profile, setProfile] = useState<HostBinding[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [observing, setObserving] = useState(false);
  const [savedEvent, setSavedEvent] = useState(0);
  const [calibrationNotice, setCalibrationNotice] = useState("");
  const lock = useRef(false);
  const mounted = useRef(true);
  const labelKey = useRef("");
  const profileKey = useRef("");
  const consumedEvent = useRef(0);
  const calibrationSession = useRef(false);

  const refresh = useCallback(async () => {
    const next = parseStatus(await invoke("host_status"));
    if (mounted.current) {
      setStatus(next);
      setKnown(true);
    }
    return next;
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (native)
      void refresh().catch((cause) => {
        if (mounted.current) {
          setKnown(false);
          setError(String(cause));
        }
      });
    return () => {
      mounted.current = false;
    };
  }, [native, refresh]);

  useEffect(() => {
    if (!native || !status?.active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled) return;
      try {
        if (!lock.current) await refresh();
      } catch (cause) {
        if (!cancelled) {
          setKnown(false);
          setError(String(cause));
        }
      }
      if (!cancelled) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [native, status?.active, refresh]);

  // Physical names belong to one device and inversion state; never reload mid-session.
  useEffect(() => {
    if (!identity || status?.active) return;
    const key = `vanzy-physical-labels:${identity}`;
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
            PHYSICAL_NAMES.some((n) => n === name),
        ) &&
        new Set(entries.map(([, name]) => name)).size === entries.length
      )
        setLabels(Object.fromEntries(entries) as Record<string, string>);
    } catch {
      setCalibrationNotice(
        "保存済みの名前を読み込めませんでした。割り当ては変更していません。",
      );
    }
  }, [identity, status?.active]);

  useEffect(() => {
    if (!identity) return;
    const key = `vanzy-host-profile:${identity}`;
    if (profileKey.current === key) return;
    profileKey.current = key;
    setProfile([]);
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (validProfile(raw)) setProfile(raw);
    } catch {
      /* Invalid saved bindings never authorize a device write. */
    }
  }, [identity]);

  const active = !!status?.active;
  const restoreFailed =
    !active &&
    (status?.restored === false || status?.phase === "restore-unconfirmed");
  const blocked = busy || !known || active || restoreFailed;

  const saveProfile = useCallback((next: HostBinding[]) => {
    if (!profileKey.current || !validProfile(next)) return false;
    try {
      localStorage.setItem(profileKey.current, JSON.stringify(next));
      setProfile(next);
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Returns the confirmed status after a successful command, or null. */
  async function run(work: () => Promise<unknown>): Promise<HostStatus | null> {
    lock.current = true;
    operationLock.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
      onInvalidate();
      return await refresh();
    } catch (cause) {
      onInvalidate();
      if (mounted.current) {
        setKnown(false);
        setError(String(cause));
      }
      try {
        await refresh();
      } catch (statusCause) {
        if (mounted.current)
          setError(`${String(cause)} 状態の確認も失敗: ${String(statusCause)}`);
      }
      return null;
    } finally {
      lock.current = false;
      operationLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const free = () =>
    native && !lock.current && !operationLock.current && !externalBusy;

  // Called only by explicit Read/Send actions, not on mount or focus.
  async function checkInputPermission(request: boolean): Promise<boolean> {
    if (!native || !isMacHost()) return true;
    setPermissionNotice("");
    try {
      let allowed: unknown = await invoke("host_input_permission", { request: false });
      if (typeof allowed !== "boolean") throw new Error("許可状態を確認できません。");
      if (!allowed && request && !permissionRequested.current) {
        permissionRequested.current = true;
        allowed = await invoke("host_input_permission", { request: true });
        if (typeof allowed !== "boolean") throw new Error("許可状態を確認できません。");
      }
      if (!allowed) setPermissionNotice("キー送信は未許可です。macOSの案内またはシステム設定でアクセシビリティを許可後、もう一度「送信を開始」を押してください。案内が未表示なら「本体を読み取る」から確認できます。本体の読取りは続行できます。キー送信・本体設定の変更は開始していません。");
      return allowed;
    } catch (cause) {
      setPermissionNotice(`キー送信の許可を確認できません: ${String(cause)} 本体の読取りは続行できます。`);
      return false;
    }
  }

  /** Starts sending for the given bindings. `observe` sends no keys (name matching only). */
  async function start(
    snapshot: DeviceSnapshot | null,
    bindings: HostBinding[],
    {
      observe = false,
      confirm = true,
      fromSave = false,
    }: { observe?: boolean; confirm?: boolean; fromSave?: boolean } = {},
  ) {
    // The save dialog already holds the shared lock and releases it just before this call.
    const available = fromSave
      ? native && !lock.current && !operationLock.current
      : free();
    if (!available || !snapshot || blocked || (!bindings.length && !macros.length)) return false;
    if (!observe && (!validProfile(bindings) || !validMacroProfile(macros))) return false;
    if (
      confirm &&
      !(await ask(
        observe
          ? "名前合わせのため、11操作を一時的に通知用へ切り替えます。キーは送りません。終了すると元に戻します。始めますか？"
          : `${new Set([...bindings.map(b => b.index), ...macros.map(b => b.index)]).size}件の動きを一時的に通知用へ切り替え、このアプリがキーまたは保存済みマクロをPCで実行します。アプリを開いている間だけ動き、停止すると元に戻します。開始しますか？`,
      ))
    )
      return false;
    if (!mounted.current || lock.current || operationLock.current) return false;
    if (isMacHost() && !observe) {
      lock.current = true;
      operationLock.current = true;
      setBusy(true);
      let allowed = false;
      try { allowed = await checkInputPermission(false); }
      finally { lock.current = false; operationLock.current = false; if (mounted.current) setBusy(false); }
      if (!allowed || !mounted.current) return false;
    }
    labelKey.current = `vanzy-physical-labels:${snapshot.deviceId}:${snapshot.touchInverted}`;
    calibrationSession.current = observe;
    consumedEvent.current = 0;
    setSavedEvent(0);
    setCalibrationNotice("");
    setObserving(observe);
    const next = await run(() =>
      invoke("host_start", {
        snapshotId: snapshot.snapshotId,
        bindings: observe
          ? bindings.map((b) => ({ index: b.index, keys: [], modifiers: 0 }))
          : bindings,
        observeOnly: observe,
        ...(observe || !macros.length ? {} : { macros }),
      }),
    );
    return !!next;
  }

  async function stop({ confirm = true }: { confirm?: boolean } = {}) {
    if (!native || lock.current || operationLock.current || externalBusy) return null;
    if (
      confirm &&
      !(await ask("アプリ経由の送信を止めて、本体の割り当てを元に戻しますか？"))
    )
      return null;
    if (!mounted.current || lock.current || operationLock.current) return null;
    return run(() => invoke("host_stop"));
  }

  async function recover() {
    if (!free() || active) return null;
    if (
      !(await ask(
        "中断した送信のバックアップを読み、通知用のまま残った本体の割り当てを元に戻しますか？",
      ))
    )
      return null;
    if (!mounted.current || lock.current || operationLock.current) return null;
    return run(() => invoke("host_recover"));
  }

  async function recheck() {
    if (lock.current) return;
    try {
      await refresh();
      setError("");
    } catch (cause) {
      setKnown(false);
      setError(String(cause));
    }
  }

  const canCalibrate =
    native &&
    known &&
    !busy &&
    active &&
    observing &&
    calibrationSession.current &&
    !!labelKey.current &&
    status?.lastGesture != null &&
    status.lastGesture >= 1 &&
    status.lastGesture <= 11 &&
    status.eventCount > savedEvent;

  async function saveCalibration(physicalName: string) {
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
      !(await ask(
        `${physicalName}は${slotReference(Number(previous))}に登録済みです。今回受信した${slotReference(Number(index))}へ移しますか？`,
      ))
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
        `${physicalName}を${slotReference(Number(index))}へ保存しました。次の動きをどうぞ。`,
      );
    } catch {
      setCalibrationNotice(
        "名前を保存できませんでした。端末の保存領域を確認してください。",
      );
    }
  }

  return {
    native,
    status,
    known,
    busy,
    error: error || status?.error || "",
    active,
    observing: active && observing,
    restoreFailed,
    blocked,
    profile,
    saveProfile,
    labels,
    start,
    stop,
    recover,
    recheck,
    canCalibrate,
    saveCalibration,
    calibrationNotice,
    permissionNotice,
    checkInputPermission,
  };
}
export type HostController = ReturnType<typeof useHostController>;
