import { KeyBindingEditor } from "./KeyBindingEditor";
import { MacroEditor } from "./MacroEditor";
import { useMacroProfile } from "./useMacroProfile";
import type { MacroDefinition } from "./macro-model";
import { useAppConfirm } from "./useAppConfirm";
import { isMacHost } from "./native-platform";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import {
  currentDescription,
  useDeviceController,
} from "./DevicePanel";
import type { BatchChange, BatchResult, DeviceSnapshot } from "./DevicePanel";
import type { HostBinding } from "./HostPanel";
import {
  MonitorIcon,
  NativeApplyDialog,
  type NativeApplyFlow,
  type NativeApplyItem,
} from "./NativeApplyDialog";
import { FIRMWARE_DEFAULT_CODE } from "./firmware-defaults";
import {
  AIR_IDS,
  GESTURE_IDS,
  MODIFIER_KEYS,
  TOUCH_IDS,
  baseDraft,
  bindingLabel,
  currentLabel,
  defaultTargetFor,
  deviceIsKey,
  deviceLabel,
  draftComplete,
  draftFromMap,
  draftLabel,
  draftRoute,
  eventMask,
  gestureGroup,
  gestureIcon,
  gestureName,
  isChange,
  isDefaultDraft,
  planSave,
  receivedLabel,
  unverifiedNote,
  type Draft,
  type GestureIconKind,
  type SavePlan,
} from "./native-model";
import { PHYSICAL_NAMES, slotReference, useHostController } from "./useHostController";
import "./native-app.css";

type View = "assign" | "test";
type Theme = "system" | "light" | "dark";
type WritePlan = {
  mode: "apply" | "restore";
  device: BatchChange[];
  plan: SavePlan | null;
  nextProfile: HostBinding[];
};
type TestEntry = { time: string; combo: string; ok: boolean };

/** Native UI shares the guarded device controller; host sending is a guarded session. */
export function NativeApp() {
  const d = useDeviceController();
  const mac = isMacHost();
  const appConfirm = useAppConfirm();
  const [permissionChecking, setPermissionChecking] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [view, setView] = useState<View>("assign");
  const [sel, setSel] = useState(1);
  const [macroModes, setMacroModes] = useState<Record<number, boolean>>({});
  const [macroDrafts, setMacroDrafts] = useState<Record<number, MacroDefinition>>({});
  const [macroInspect, setMacroInspect] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [lastGood, setLastGood] = useState<DeviceSnapshot | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureReset, setCaptureReset] = useState(0);
  const [hint, setHint] = useState("");
  const [writeFlow, setWriteFlow] = useState<NativeApplyFlow | null>(null);
  const [testFocus, setTestFocus] = useState(false);
  const [history, setHistory] = useState<TestEntry[]>([]);
  const [physicalName, setPhysicalName] = useState<string>(PHYSICAL_NAMES[0]);
  const testHeld = useRef<string[]>([]);
  const testMask = useRef(0);
  const operationLock = useRef(false);
  const identityRef = useRef("");
  const writePlan = useRef<WritePlan | null>(null);
  const writeReturnFocus = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const shown = d.snapshot ?? lastGood;
  const identity = shown ? `${shown.deviceId}:${shown.touchInverted}` : "";
  const invalidate = useCallback(() => {
    d.setSnapshot(null);
    d.setStatus("");
  }, [d.setSnapshot, d.setStatus]);
  const macros = useMacroProfile(identity, macroInspect);
  const savedMacro = macros.profile.find(b => b.index === sel)?.macro;
  const macroMode = macroModes[sel] ?? !!savedMacro;
  const macroValue = macroDrafts[sel] ?? savedMacro ?? { version: 1 as const, steps: [] };
  useEffect(() => { setMacroModes({}); setMacroDrafts({}); }, [identity]);
  const host = useHostController({
    macros: macros.profile,
    identity,
    externalBusy: d.busy || !!writeFlow,
    operationLock,
    onInvalidate: invalidate,
    confirmAction: mac ? appConfirm.ask : undefined,
  });
  const profile = host.profile;
  const labels = host.labels;
  const locked = macros.busy || macros.status.running || permissionChecking || d.busy || !!writeFlow || host.blocked;
  const editable = !macroMode && !savedMacro && !locked && !!d.snapshot && d.writable;
  const name = (index: number) => gestureName(index, labels);

  useEffect(() => {
    if (d.snapshot) setLastGood(d.snapshot);
  }, [d.snapshot]);
  useEffect(() => {
    if (!d.snapshot) return;
    const next = `${d.snapshot.deviceId}:${d.snapshot.touchInverted}`;
    if (identityRef.current && identityRef.current !== next) setDrafts({});
    identityRef.current = next;
  }, [d.snapshot?.deviceId, d.snapshot?.touchInverted]);
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [theme]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  // ---- assignment state -------------------------------------------------
  const changeOf = (index: number) => {
    const draft = drafts[index];
    return draft && isChange(index, draft, shown, profile) ? draft : null;
  };
  const changed = GESTURE_IDS.filter((index) => changeOf(index));
  const bound = (index: number) => profile.some((b) => b.index === index);
  const macroFor = (index: number) => macros.profile.find(b => b.index === index)?.macro;
  const hostCount = new Set([...profile.map(b => b.index), ...macros.profile.map(b => b.index)]).size;
  const valueOf = (index: number) => {
    const draft = changeOf(index);
    return draft ? draftLabel(index, draft, shown) : currentLabel(index, shown, profile);
  };
  const appOf = (index: number) => {
    const draft = changeOf(index);
    return draft ? draftRoute(draft) === "host" : bound(index);
  };

  function selectGesture(index: number) {
    if (d.busy || writeFlow) return;
    stopCapture();
    setSel(index);
    setHint("");
    setHistory([]);
  }
  function switchView(next: View) {
    stopCapture();
    setView(next);
  }
  function setDraft(index: number, next: Draft | null) {
    setDrafts((prev) => {
      const copy = { ...prev };
      if (
        !next ||
        (!draftComplete(next) && next.mask === 0) ||
        (draftComplete(next) && !isChange(index, next, shown, profile))
      )
        delete copy[index];
      else copy[index] = next;
      return copy;
    });
  }
  const editorBase = () => drafts[sel] ?? baseDraft(sel, shown, profile);
  function applyDefault() {
    if (!editable) return;
    const target = defaultTargetFor(sel, shown);
    const map = shown?.maps[String(sel)];
    if (
      target &&
      map &&
      !bound(sel) &&
      target.every((value, i) => value === map[i])
    )
      setDraft(sel, null);
    else setDraft(sel, { codes: [FIRMWARE_DEFAULT_CODE], mask: 0 });
    setHint("");
  }

  function stopCapture() { setCapturing(false); setCaptureReset(n => n + 1); }

  // ---- device read --------------------------------------------------------
  async function readDevice() {
    if (locked || operationLock.current) return;
    operationLock.current = true;
    try {
      if (mac) {
        setPermissionChecking(true);
        await host.checkInputPermission(true);
      }
      await d.operate(false);
    } finally {
      setPermissionChecking(false);
      operationLock.current = false;
    }
  }
  async function stopAndEdit() {
    const status = await host.stop({ confirm: false });
    if (
      status &&
      !status.active &&
      status.restored !== false &&
      status.phase !== "restore-unconfirmed" &&
      !operationLock.current
    ) {
      operationLock.current = true;
      try {
        await d.operate(false);
      } finally {
        operationLock.current = false;
      }
    }
  }

  // ---- save flow ----------------------------------------------------------
  function openSave(mode: "apply" | "restore") {
    if (locked || operationLock.current || !d.snapshot || !d.writable || capturing)
      return;
    const snap = d.snapshot;
    const base = {
      product: snap.product,
      firmware: snap.firmware,
      phase: "review" as const,
      mode,
      startAfter: true,
    };
    if (mode === "restore") {
      const entries = snap.undo?.entries ?? (snap.undo ? [snap.undo] : []);
      const device = entries
        .filter((entry) => {
          const map = snap.maps[String(entry.index)];
          return map && entry.target.some((value, i) => value !== map[i]);
        })
        .map((entry) => ({
          index: entry.index,
          expected: [...snap.maps[String(entry.index)]],
          target: [...entry.target],
        }));
      if (!device.length) return;
      writePlan.current = { mode, device, plan: null, nextProfile: profile };
      writeReturnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMenuOpen(false);
      setWriteFlow({
        ...base,
        canStart: false,
        items: device.map((change) => ({
          index: change.index,
          name: name(change.index),
          before: currentDescription(change.expected),
          after: currentDescription(change.target),
          route: "device",
          status: "pending",
        })),
      });
      d.setConfirming("restore");
      return;
    }
    const plan = planSave(drafts, snap, profile);
    if (
      plan.invalid.length ||
      (!plan.device.length && !plan.hostAdds.length && !plan.unbinds.length)
    )
      return;
    const nextProfile = [
      ...profile.filter(
        (b) =>
          !plan.unbinds.includes(b.index) &&
          !plan.hostAdds.some((add) => add.index === b.index),
      ),
      ...plan.hostAdds,
    ].sort((a, b) => a.index - b.index);
    writePlan.current = { mode, device: plan.device, plan, nextProfile };
    writeReturnFocus.current = document.querySelector<HTMLElement>(".nx-save-button");
    const items: NativeApplyItem[] = [
      ...plan.device.map((change) => ({
        index: change.index,
        name: name(change.index),
        before: currentLabel(change.index, snap, profile),
        after: currentDescription(change.target),
        route: "device" as const,
        status: "pending" as const,
      })),
      ...plan.hostAdds.map((binding) => ({
        index: binding.index,
        name: name(binding.index),
        before: currentLabel(binding.index, snap, profile),
        after: bindingLabel(binding),
        route: "host" as const,
        status: "pending" as const,
        fallback: deviceLabel(binding.index, snap),
      })),
      ...plan.unbinds
        .filter((index) => !plan.device.some((change) => change.index === index))
        .map((index) => ({
          index,
          name: name(index),
          before: currentLabel(index, snap, profile),
          after: deviceLabel(index, snap),
          route: "unbind" as const,
          status: "pending" as const,
        })),
    ];
    setWriteFlow({ ...base, canStart: plan.hostAdds.length > 0, items });
    if (plan.device.length) d.setConfirming("apply");
  }
  function closeWriteFlow() {
    if (writeFlow?.phase === "run" || d.busy || operationLock.current) return;
    d.setConfirming(null);
    setWriteFlow(null);
  }
  async function apply() {
    const prepared = writePlan.current;
    if (
      !writeFlow ||
      !prepared ||
      writeFlow.phase !== "review" ||
      host.blocked ||
      operationLock.current ||
      d.busy
    )
      return;
    const flow = writeFlow;
    const restore = prepared.mode === "restore";
    operationLock.current = true;
    setWriteFlow({ ...flow, phase: "run" });
    let outcome: BatchResult["outcome"] = "complete";
    let batchItems: BatchResult["items"] = [];
    let fresh: DeviceSnapshot | null = d.snapshot;
    let backupPath: string | undefined;
    let error: string | undefined;
    try {
      if (prepared.device.length) {
        const result = await d.operateBatch(prepared.device, restore, (event) => {
          setWriteFlow((current) =>
            current?.phase === "run"
              ? {
                  ...current,
                  backupPath: event.backupPath || current.backupPath,
                  items: current.items.map((item) =>
                    item.index === event.index && item.route === "device"
                      ? { ...item, status: event.status, error: event.error }
                      : item,
                  ),
                }
              : current,
          );
        });
        outcome = result.outcome;
        batchItems = result.items;
        fresh = result.outcome === "complete" ? result.snapshot : null;
        backupPath = result.backupPath;
        error = result.error;
        if (fresh) setLastGood(fresh);
      }
    } catch (cause) {
      d.setSnapshot(null);
      outcome = "failed";
      fresh = null;
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const verified = new Set(
      batchItems.filter((item) => item.status === "verified").map((item) => item.index),
    );
    const deviceStatus = (index: number): NativeApplyItem["status"] => {
      const item = batchItems.find((entry) => entry.index === index);
      if (!item) return outcome === "failed" ? "uncertain" : "not_applied";
      return item.status === "pending" ? "not_applied" : item.status;
    };
    let hostSaved = true;
    const savedHost = new Set<number>();
    if (!restore && prepared.plan) {
      const plan = prepared.plan;
      const unbinds = plan.unbinds.filter(
        (index) =>
          !prepared.device.some((change) => change.index === index) ||
          verified.has(index),
      );
      if (plan.hostAdds.length || unbinds.length) {
        const next = [
          ...profile.filter(
            (b) =>
              !unbinds.includes(b.index) &&
              !plan.hostAdds.some((add) => add.index === b.index),
          ),
          ...plan.hostAdds,
        ].sort((a, b) => a.index - b.index);
        hostSaved = host.saveProfile(next);
        if (hostSaved) {
          plan.hostAdds.forEach((b) => savedHost.add(b.index));
          unbinds.forEach((index) => savedHost.add(index));
          prepared.nextProfile = next;
        }
      }
    }
    setWriteFlow((current) =>
      current && {
        ...current,
        items: current.items.map((item) =>
          item.route === "device"
            ? { ...item, status: deviceStatus(item.index) }
            : { ...item, status: savedHost.has(item.index) ? "saved" : "failed" },
        ),
      },
    );
    let start: NativeApplyFlow["start"] = undefined;
    if (!restore && flow.canStart && flow.startAfter) {
      if (outcome === "complete" && hostSaved && fresh && prepared.nextProfile.length) {
        setWriteFlow((current) => current && { ...current, start: "running" });
        operationLock.current = false;
        const ok = await host.start(fresh, prepared.nextProfile, {
          confirm: false,
          fromSave: true,
        });
        operationLock.current = true;
        start = ok ? "done" : "failed";
      } else start = "skipped";
    }
    if (!restore) {
      setDrafts((prev) => {
        const copy = { ...prev };
        for (const index of [...verified, ...savedHost]) delete copy[index];
        return copy;
      });
      setHint("");
    }
    const allDone =
      outcome === "complete" &&
      prepared.device.every((change) => verified.has(change.index)) &&
      (restore ||
        !prepared.plan ||
        prepared.plan.hostAdds.every((b) => savedHost.has(b.index)));
    setWriteFlow((current) =>
      current && {
        ...current,
        phase: "result",
        outcome,
        success: allDone,
        start,
        backupPath: backupPath || current.backupPath,
        capturedAt: fresh?.capturedAt,
        error: error || (hostSaved ? undefined : "アプリ経由の設定を保存できませんでした。"),
      },
    );
    operationLock.current = false;
  }
  async function stopBatch() {
    if (writeFlow?.phase !== "run" || writeFlow.stopRequested) return;
    setWriteFlow((current) => current && { ...current, stopRequested: true });
    try {
      const accepted = await d.cancelBatch();
      if (!accepted)
        setWriteFlow((current) =>
          current?.phase === "run" ? { ...current, stopRequested: false } : current,
        );
    } catch (cause) {
      setWriteFlow((current) =>
        current?.phase === "run"
          ? {
              ...current,
              stopRequested: false,
              error: `中止要求を確認できませんでした。現在の処理の完了を待ってください。${String(cause)}`,
            }
          : current,
      );
    }
  }

  // ---- test --------------------------------------------------------------
  const sending = host.active && !host.observing;
  const expectedFor = (index: number) =>
    sending && macroFor(index) ? "マクロ（手順ごとの結果を確認）" : sending && bound(index)
      ? currentLabel(index, shown, profile)
      : deviceLabel(index, shown);
  function testDown(event: ReactKeyboardEvent) {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.repeat) return;
    testMask.current |= eventMask(event);
    if (!MODIFIER_KEYS.includes(event.key) && !testHeld.current.includes(event.code))
      testHeld.current = [...testHeld.current, event.code];
  }
  function testUp() {
    if (!testHeld.current.length) return;
    const combo = receivedLabel(testMask.current, testHeld.current);
    testHeld.current = [];
    testMask.current = 0;
    const want = expectedFor(sel);
    const keyExpected = !macroFor(sel) && ((sending && bound(sel)) || deviceIsKey(sel, shown));
    setHistory((list) =>
      [
        {
          time: new Date().toLocaleTimeString("ja-JP"),
          combo,
          ok: keyExpected && combo === want,
        },
        ...list,
      ].slice(0, 6),
    );
  }

  // ---- render ---------------------------------------------------------------
  const ready = !!shown;
  const header = (
    <header className="nx-header">
      <div className="nx-header-inner">
        <div className="nx-brand">
          <svg width="24" height="24" viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <circle cx="14" cy="15" r="9" stroke="currentColor" strokeWidth="2.5" />
            <rect x="10.5" y="2" width="7" height="6" rx="2" fill="currentColor" />
          </svg>
          <span>VANZY Manager</span>
        </div>
        <nav className="nx-nav" aria-label="画面">
          {(
            [
              ["assign", "割り当て"],
              ["test", "テスト"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="nx-tab"
              aria-current={view === value ? "page" : undefined}
              disabled={!ready || !!writeFlow}
              onClick={() => switchView(value)}
            >
              {label}
              {value === "assign" && host.active && (
                <span className="nx-tab-dot" aria-label={host.status?.phase === "listening" ? "送信中" : "準備・復元中"} />
              )}
            </button>
          ))}
        </nav>
        <span className="nx-spacer" />
        <div className="nx-header-actions">
          <div
            className={`nx-device ${d.snapshot || host.active ? "" : "is-stale"}`}
            role="status"
          >
            <span className="nx-dot" aria-hidden="true" />
            {d.busy ? (
              <span>通信中…</span>
            ) : shown ? (
              <>
                <strong>{shown.product}</strong>
                <span className="nx-meta">FW {shown.firmware}</span>
              </>
            ) : (
              <span>本体は未読取り</span>
            )}
          </div>
          {ready && (
            <button
              type="button"
              className="nx-btn nx-btn-sm"
              disabled={locked || !d.nativeSupported}
              onClick={() => void readDevice()}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="nx-stroke">
                <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
              読み直す
            </button>
          )}
          <div className="nx-menu-wrap" ref={menuRef}>
            <button
              type="button"
              className="nx-icon-btn"
              aria-label="そのほかのメニュー"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" className="nx-fill">
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
              </svg>
            </button>
            {menuOpen && (
              <div
                className="nx-menu"
                role="region"
                aria-label="そのほかのメニュー"
                onKeyDown={(event) => {
                  if (event.key === "Escape") setMenuOpen(false);
                }}
              >
                <section className="nx-menu-section">
                  <h2 className="nx-eyebrow">バックアップ</h2>
                  {shown ? (
                    <>
                      <p>{new Date(shown.capturedAt).toLocaleString("ja-JP")} に読み取り時に保存</p>
                      <code className="nx-path">{shown.backupPath}</code>
                    </>
                  ) : (
                    <p className="nx-meta">本体を読み取ると保存先を表示します。</p>
                  )}
                  {d.snapshot?.undo && (
                    <button
                      type="button"
                      className="nx-link"
                      disabled={locked || !d.writable}
                      onClick={() => openSave("restore")}
                    >
                      直前の保存を元に戻す…
                    </button>
                  )}
                </section>
                <section className="nx-menu-section">
                  <h2 className="nx-eyebrow" id="nx-theme-label">テーマ</h2>
                  <div className="nx-seg" role="group" aria-labelledby="nx-theme-label">
                    {(
                      [
                        ["system", "自動"],
                        ["light", "ライト"],
                        ["dark", "ダーク"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={theme === value}
                        onClick={() => setTheme(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </section>
                <section className="nx-menu-section">
                  <h2 className="nx-eyebrow">本体の設定（表示のみ）</h2>
                  <dl className="nx-facts">
                    <div>
                      <dt>タッチ反転</dt>
                      <dd>{shown ? (shown.touchInverted ? "有効" : "無効") : "未読取り"}</dd>
                    </div>
                    <div>
                      <dt>2台で使う（2ch）</dt>
                      <dd>本体のボタンで切り替え</dd>
                    </div>
                  </dl>
                </section>
                <section className="nx-menu-section">
                  <h2 className="nx-eyebrow">使い方</h2>
                  <ol className="nx-howto">
                    <li>本体を読み取り、左の一覧で動きを選ぶ</li>
                    <li>キーを押して記録し、「保存…」で反映する</li>
                    <li>「テスト」で実際の動きを確かめる</li>
                  </ol>
                  <p className="nx-meta">
                    キー1つ＋修飾キーは本体に保存され、アプリを閉じても動きます。同時押しはアプリ経由になり、送信中だけ動きます。
                  </p>
                </section>
                <button
                  type="button"
                  className="nx-menu-item"
                  disabled={locked && !host.restoreFailed}
                  onClick={() => {
                    setMenuOpen(false);
                    void host.recover();
                  }}
                >
                  中断した送信を復旧…
                </button>
                <p className="nx-meta nx-version">VANZY Manager 0.2.0</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );

  const notices = (
    <>
      {host.restoreFailed && (
        <div className="nx-banner is-warn" role="alert">
          <span>
            前回の送信のあと、本体の割り当てを元に戻せたか確認できていません。再開せずに確認してください。
          </span>
          <button type="button" className="nx-btn nx-btn-sm" onClick={() => void host.recheck()}>
            状態を再確認
          </button>
          <button type="button" className="nx-btn nx-btn-sm" onClick={() => void host.recover()}>
            復旧する…
          </button>
        </div>
      )}
      {host.native && !host.known && !host.busy && host.error && (
        <div className="nx-banner is-warn" role="alert">
          <span>送信の状態を確認できません。{host.error}</span>
          <button type="button" className="nx-btn nx-btn-sm" onClick={() => void host.recheck()}>
            状態を再確認
          </button>
        </div>
      )}
      {d.error && (
        <p className="nx-banner is-error" role="alert">
          {d.error} 本体を読み直してください。
        </p>
      )}
      {d.status && (
        <p className="nx-statusline" role="status">
          {d.status}
        </p>
      )}
    </>
  );

  if (!ready)
    return (
      <div className="nx-app">
        {header}
        <main className="nx-start">
          <div className="nx-start-notices">{notices}{host.permissionNotice && <p role="status" className="nx-meta">{host.permissionNotice}</p>}</div>
          <section className="nx-card nx-start-card" aria-labelledby="nx-start-title">
            <span className="nx-start-icon" aria-hidden="true">
              <svg width="44" height="44" viewBox="0 0 28 28" fill="none">
                <circle cx="14" cy="15" r="9" stroke="currentColor" strokeWidth="2.2" />
                <rect x="10.5" y="2" width="7" height="6" rx="2" fill="currentColor" />
              </svg>
            </span>
            <div className="nx-start-text">
              <h1 id="nx-start-title">VANZY の設定を読み取ります</h1>
              <p>
                いまの割り当てを読み取り、自動でバックアップします。
                <br />
                本体の設定は変わりません。
              </p>
            </div>
            {host.active && (
              <p className="nx-alert" role="status">
                アプリ経由の送信中です。停止・復元してから読み取ってください。
              </p>
            )}
            <div className="nx-start-actions">
              <button
                type="button"
                className="nx-btn nx-btn-primary nx-btn-lg"
                disabled={locked || !d.nativeSupported}
                onClick={() => void readDevice()}
              >
                {d.busy ? "読み取っています…" : "本体を読み取る"}
              </button>
              {host.active && (
                <button type="button" className="nx-btn" onClick={() => void host.stop()}>
                  送信を停止して元に戻す
                </button>
              )}
              <p className="nx-meta">
                {d.nativeSupported
                  ? `対応: VANZY A2 · FW 3.2.1（${mac ? "macOS・実機検証前" : "Windows・ペアリング済み1台"}）`
                  : "本体との通信は Windows・macOS のネイティブ版でのみ利用できます。"}
              </p>
            </div>
          </section>
        </main>
      </div>
    );

  const list = (valueFor: (index: number) => string, showChange: boolean) => (
    <nav className="nx-card nx-list" aria-label="ジェスチャー一覧">
      {[
        { title: "空中ジェスチャー", ids: AIR_IDS },
        { title: "タッチ操作", ids: TOUCH_IDS },
      ].map((group) => (
        <div key={group.title} className="nx-list-group">
          <h2 className="nx-eyebrow">{group.title}</h2>
          {group.ids.map((index) => {
            const draft = showChange ? changeOf(index) : null;
            const app = showChange ? appOf(index) : bound(index);
            return (
              <button
                key={index}
                type="button"
                className="nx-row"
                aria-pressed={sel === index}
                disabled={d.busy || !!writeFlow}
                onClick={() => selectGesture(index)}
              >
                <span className="nx-tile">
                  <GestureIcon kind={gestureIcon(index, labels)} size={18} />
                </span>
                <span className="nx-row-name">{name(index)} {macroFor(index) && <span className="nx-badge">マクロ {macroFor(index)!.steps.length}</span>}</span>
                <span
                  className={`nx-row-value nx-mono ${draft ? "is-changed" : app ? "is-app" : ""}`}
                >
                  {draft && <span className="nx-changed-dot" aria-label="未保存" />}
                  {app && <MonitorIcon size={14} label="アプリ経由" />}
                  <span className="nx-ellipsis">{valueFor(index)}</span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );

  const appCard = (
    <section className="nx-card nx-app-card" aria-labelledby="nx-app-title">
      <div className="nx-card-head">
        <h2 id="nx-app-title" className="nx-card-title">
          <MonitorIcon size={16} />
          アプリ経由の送信
        </h2>
        <span className={`nx-state ${host.active ? "is-on" : ""}`} role="status">
          <span className="nx-dot" aria-hidden="true" />
          {host.busy
            ? "処理中…"
            : host.active
              ? host.status?.phase !== "listening"
                ? `準備・復元中（${host.status?.phase ?? "確認中"}）`
                : host.observing
                ? "名前合わせ中"
                : "送信中"
              : host.known
                ? "停止中"
                : "確認中"}
        </span>
      </div>
      <p className="nx-meta">
        {hostCount
          ? `${Array.from(new Set([...profile.map(b => b.index), ...macros.profile.map(b => b.index)])).map(name).join("・")} の ${hostCount} 件は、送信中だけ動きます。`
          : "アプリ経由の割り当てはありません。同時押しを割り当てると使えます。"}
      </p>
      {host.permissionNotice && <p role="status" className="nx-meta">{host.permissionNotice}</p>}
      {host.status && (
        <p className="nx-meta">
          受信 {host.status.eventCount} 回
          {host.status.runtimeMode != null && ` · 最終確認モード: ${host.status.runtimeMode}`}
          {host.status.restored === true && " · 本体設定の復元確認済み"}
          {host.status.lastGesture != null && ` · 最後: ${name(host.status.lastGesture)}`}
        </p>
      )}
      {host.error && host.known && (
        <p className="nx-alert" role="alert">
          {host.error}
        </p>
      )}
      {host.active ? (
        <button
          type="button"
          className="nx-btn nx-btn-block"
          disabled={host.busy}
          onClick={() => void host.stop()}
        >
          停止して元に戻す
        </button>
      ) : (
        <>
          <button
            type="button"
            className="nx-btn nx-btn-block"
            disabled={locked || !d.snapshot || !hostCount}
            onClick={() => void host.start(d.snapshot, profile)}
          >
            送信を開始
          </button>
          {hostCount > 0 && !d.snapshot && !locked && (
            <p className="nx-meta">本体を読み直すと開始できます。</p>
          )}
        </>
      )}
    </section>
  );

  // ---- editor ---------------------------------------------------------------
  const draft = drafts[sel];
  const valid = !!changeOf(sel);
  const incomplete = !!draft && !draftComplete(draft);
  const base = editorBase();
  const display = draft ? draftLabel(sel, draft, shown) : currentLabel(sel, shown, profile);
  const defaultTarget = defaultTargetFor(sel, shown);
  const keyLike = draft
    ? isDefaultDraft(draft)
      ? draftComplete(draftFromMap(defaultTarget ?? undefined))
      : true
    : bound(sel) || deviceIsKey(sel, shown);
  const showsApp = draft && draftComplete(draft) ? draftRoute(draft) === "host" : bound(sel);
  const map = shown?.maps[String(sel)];
  const sameAsDefault =
    !!defaultTarget &&
    !!map &&
    !bound(sel) &&
    !draft &&
    defaultTarget.every((value, i) => value === map[i]);
  const note = unverifiedNote(sel, labels);
  const editor = (
    <section className="nx-card nx-editor" aria-label="割り当ての編集">
      <div className="nx-editor-head">
        <span className="nx-tile nx-tile-lg">
          <GestureIcon kind={gestureIcon(sel, labels)} size={24} />
        </span>
        <div>
          <h1 className="nx-h1">{name(sel)}</h1>
          <p className="nx-meta">
            {gestureGroup(sel)}
            {note && (
              <>
                {" · "}
                {note} —{" "}
                <button type="button" className="nx-link nx-inline" onClick={() => switchView("test")}>
                  テストで確かめる
                </button>
              </>
            )}
          </p>
        </div>
      </div>

      {host.active && (
        <div className="nx-lock" role="status">
          <span>
            {host.observing
              ? "名前合わせ中は、割り当てを変更できません。"
              : "アプリ経由の送信中は、割り当てを変更できません。"}
          </span>
          <button
            type="button"
            className="nx-btn nx-btn-sm"
            disabled={host.busy}
            onClick={() => void stopAndEdit()}
          >
            {host.observing ? "名前合わせを終了して編集" : "送信を停止して編集"}
          </button>
        </div>
      )}
      {!host.active && !d.snapshot && !d.busy && (
        <div className="nx-lock" role="status">
          <span>本体を読み直すと編集できます。表示は前回読み取った値です。</span>
          <button
            type="button"
            className="nx-btn nx-btn-sm"
            disabled={locked || !d.nativeSupported}
            onClick={() => void readDevice()}
          >
            読み直す
          </button>
        </div>
      )}
      {d.snapshot && !d.writable && (
        <p className="nx-alert" role="alert">
          このFWへの書き込みは未検証です（読み取りのみ）。
        </p>
      )}

      <div className="nx-macro-mode" role="group" aria-label="割り当ての種類">
        <button type="button" className="nx-btn" aria-pressed={!macroMode} disabled={locked} onClick={() => { stopCapture(); setMacroModes(m => ({ ...m, [sel]: false })); }}>キー送信</button>
        <button type="button" className="nx-btn" aria-pressed={macroMode} disabled={locked} onClick={() => { stopCapture(); setMacroModes(m => ({ ...m, [sel]: true })); setMacroInspect(true); }}>マクロ</button>
      </div>
      {macros.notice && <p className="nx-meta" role="status">{macros.notice}</p>}
      {!macroMode && savedMacro && <div className="nx-lock"><span>保存済みマクロが優先されます。キー割り当てに戻すには解除してください。</span><button type="button" className="nx-btn" disabled={locked || !macros.known} onClick={() => macros.save(sel, null)}>マクロを解除（このPCのみ）</button></div>}
      {macroMode ? <MacroEditor
        value={macroValue}
        onChange={value => setMacroDrafts(m => ({ ...m, [sel]: value }))}
        onSave={() => { if (macros.save(sel, macroValue)) setMacroDrafts(m => { const next = { ...m }; delete next[sel]; return next; }); }}
        onTest={() => { setMacroInspect(true); void appConfirm.ask("本体を操作せず、このマクロを一度だけ試します。対象アプリを開いたり、前面アプリへキーを送ります。準備できていますか？").then(ok => { if (ok) void macros.test(macroValue); }); }}
        onStop={() => void macros.stop()}
        disabled={locked || !identity || !macros.known}
        running={macros.status.running}
        supported={mac}
        dirty={JSON.stringify(macroValue) !== JSON.stringify(savedMacro)}
        status={macros.status.error ?? (macros.status.running ? `手順 ${macros.status.step ?? 0} を実行中` : "")}
      /> : <>
      <div className="nx-block">
        <h2 className="nx-eyebrow">割り当て</h2>
        <div
          className={`nx-value-panel ${valid ? "is-changed" : ""}`}
          title={map ? `本体の生データ: ${map.map((v) => v.toString(16).padStart(2, "0")).join(" ")}` : undefined}
        >
          {keyLike ? (
            display.split(" + ").map((part, i) => (
              <span key={`${part}-${i}`} className="nx-keycap-wrap">
                {i > 0 && (
                  <span className="nx-plus" aria-hidden="true">
                    +
                  </span>
                )}
                <kbd className="nx-keycap">{part}</kbd>
              </span>
            ))
          ) : (
            <span className="nx-action">{display}</span>
          )}
        </div>
        <div className="nx-value-meta">
          <div className="nx-grow">
            {valid ? (
              <p className="nx-meta nx-inline-row">
                <span className="nx-badge is-changed">未保存</span>
                いまの割り当ては
                <span className="nx-mono nx-strong">{currentLabel(sel, shown, profile)}</span>
              </p>
            ) : incomplete ? (
              <p className="nx-meta">
                キーを1つ以上選ぶと変更になります（いまの割り当ては{" "}
                <span className="nx-mono nx-strong">{currentLabel(sel, shown, profile)}</span>）
              </p>
            ) : (
              <p className="nx-ok-text">
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="nx-stroke">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                {bound(sel) ? "アプリ経由で動く設定です" : "本体に保存されている設定です"}
              </p>
            )}
          </div>
          <div className="nx-value-actions">
            {draft && (
              <button
                type="button"
                className="nx-link"
                disabled={!!writeFlow}
                onClick={() => {
                  setDraft(sel, null);
                  setHint("");
                }}
              >
                元に戻す
              </button>
            )}
            <button
              type="button"
              className="nx-link"
              title={defaultTarget ? `標準設定: ${currentDescription(defaultTarget)}` : undefined}
              disabled={!editable || !defaultTarget || sameAsDefault || (!!draft && isDefaultDraft(draft))}
              onClick={applyDefault}
            >
              {!defaultTarget
                ? "標準設定は未確認です"
                : sameAsDefault
                  ? "標準設定と同じです"
                  : "標準設定に戻す"}
            </button>
          </div>
        </div>
        {showsApp && (
          <div className="nx-app-band" role="note">
            <MonitorIcon size={20} />
            <div>
              <strong>アプリ経由で動きます</strong>
              <span>
                通常キーが2つ以上なので、送信中だけこのアプリがPCへ送ります。アプリを閉じている間は、本体の設定{" "}
                <span className="nx-mono nx-strong">{deviceLabel(sel, shown)}</span> が動きます。
              </span>
            </div>
          </div>
        )}
      </div>

      <KeyBindingEditor value={base} onChange={next => setDraft(sel, next)} editable={editable}
        onCaptureChange={setCapturing} resetKey={captureReset} hint={hint} onHintChange={setHint} />
      </>}
    </section>
  );

  const saveBar = changed.length > 0 && (
    <div className="nx-savebar" role="region" aria-label="未保存の変更">
      <span className="nx-savebar-title">
        <span className="nx-changed-dot" aria-hidden="true" />
        未保存の変更 {changed.length} 件
      </span>
      <div className="nx-savebar-items">
        {changed.map((index) => (
          <button
            key={index}
            type="button"
            className="nx-pill"
            disabled={d.busy || !!writeFlow}
            onClick={() => selectGesture(index)}
          >
            {name(index)}
            <span className="nx-mono nx-pill-value">{valueOf(index)}</span>
            {appOf(index) && <MonitorIcon size={14} label="アプリ経由" />}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="nx-btn-ghost"
        disabled={!!writeFlow}
        onClick={() => {
          setDrafts({});
          setHint("");
        }}
      >
        すべて取り消す
      </button>
      <button
        type="button"
        className="nx-btn nx-btn-primary nx-save-button"
        title={
          host.active
            ? "送信を停止すると保存できます"
            : !d.snapshot
              ? "本体を読み直すと保存できます"
              : undefined
        }
        disabled={locked || capturing || !d.snapshot || !d.writable}
        onClick={() => openSave("apply")}
      >
        保存…
      </button>
    </div>
  );

  // ---- test view -------------------------------------------------------------
  const expected = expectedFor(sel);
  const nonKey = !(sending && bound(sel)) && !deviceIsKey(sel, shown);
  const last = history[0];
  const calibrationCard = (
    <section className="nx-card nx-app-card" aria-labelledby="nx-cal-title">
      <div className="nx-card-head">
        <h2 id="nx-cal-title" className="nx-card-title">
          名前合わせ
        </h2>
        <span className="nx-meta">{Object.keys(labels).length} / 11 確認済み</span>
      </div>
      {host.observing ? (
        <>
          <p className="nx-meta">
            {host.status?.lastGesture != null
              ? `最後に届いた枠: ${slotReference(host.status.lastGesture)}`
              : "VANZY を動かしてください。届いた枠を表示します。"}
          </p>
          <label className="nx-stack">
            <span className="nx-label">実際に行った動き</span>
            <select
              className="nx-select"
              value={physicalName}
              onChange={(event) => setPhysicalName(event.target.value)}
            >
              {PHYSICAL_NAMES.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="nx-btn nx-btn-block"
            disabled={!host.canCalibrate}
            onClick={() => host.saveCalibration(physicalName)}
          >
            この名前で保存
          </button>
          {host.calibrationNotice && (
            <p className="nx-meta" role="status">
              {host.calibrationNotice}
            </p>
          )}
          <button
            type="button"
            className="nx-btn nx-btn-block"
            disabled={host.busy}
            onClick={() => void host.stop()}
          >
            終了して元に戻す
          </button>
        </>
      ) : (
        <>
          <p className="nx-meta">
            実際に動かして、届いた枠に名前を付けます。割り当ては変わりません。
          </p>
          <button
            type="button"
            className="nx-btn nx-btn-block"
            disabled={locked || !d.snapshot}
            onClick={() =>
              void host.start(
                d.snapshot,
                GESTURE_IDS.map((index) => ({ index, keys: [], modifiers: 0 })),
                { observe: true },
              )
            }
          >
            名前合わせを始める
          </button>
        </>
      )}
    </section>
  );
  const testView = (
    <section className="nx-card nx-editor" aria-label="実動作テスト">
      <div className="nx-editor-head">
        <span className="nx-tile nx-tile-lg">
          <GestureIcon kind={gestureIcon(sel, labels)} size={24} />
        </span>
        <div>
          <h1 className="nx-h1">{name(sel)} を試す</h1>
          <p className="nx-meta nx-inline-row">
            いま届くはずのキー <span className="nx-mono nx-strong">{expected}</span>
          </p>
        </div>
      </div>
      {bound(sel) && (
        <div className={`nx-app-band ${sending ? "is-on" : ""}`} role="note">
          <MonitorIcon size={20} />
          <div>
            <span>
              {sending
                ? host.status?.phase === "listening"
                  ? `アプリ経由の送信中です。${currentLabel(sel, shown, profile)} が届きます。`
                  : "送信の準備・復元中です。まだ動作テストを始めないでください。"
                : `アプリ経由の割り当て（${currentLabel(sel, shown, profile)}）です。いまは送信していないので、本体の設定 ${deviceLabel(sel, shown)} が届きます。`}
            </span>
          </div>
          {!host.observing && (
            <button
              type="button"
              className="nx-btn nx-btn-sm"
              disabled={host.busy || (!sending && (locked || !d.snapshot))}
              onClick={() =>
                void (sending ? host.stop() : host.start(d.snapshot, profile))
              }
            >
              {sending ? "送信を停止" : "送信を開始"}
            </button>
          )}
        </div>
      )}
      {nonKey && (
        <p className="nx-quiet-note">
          「{expected}」はキー入力ではないため、ここには表示されません。画面の動きで確かめてください。
        </p>
      )}
      <button
        type="button"
        className="nx-test-zone"
        aria-label="実動作テストの入力欄"
        aria-pressed={testFocus}
        onClick={(event) => event.currentTarget.focus()}
        onFocus={() => setTestFocus(true)}
        onBlur={() => {
          setTestFocus(false);
          testHeld.current = [];
          testMask.current = 0;
        }}
        onKeyDown={testDown}
        onKeyUp={testUp}
      >
        {last ? (
          <>
            <span className="nx-eyebrow">PCに届いたキー</span>
            <span className="nx-keycaps-center">
              {last.combo.split(" + ").map((part, i) => (
                <span key={`${part}-${i}`} className="nx-keycap-wrap">
                  {i > 0 && (
                    <span className="nx-plus" aria-hidden="true">
                      +
                    </span>
                  )}
                  <kbd className="nx-keycap">{part}</kbd>
                </span>
              ))}
            </span>
            <span className={`nx-badge-lg ${last.ok ? "is-ok" : "is-changed"}`} role="status">
              {last.ok ? "割り当てと一致" : "割り当てと違うキーです"}
            </span>
          </>
        ) : (
          <>
            <HandIcon />
            <span className="nx-zone-title">
              {testFocus ? "VANZY を動かしてください" : "ここをクリックしてから、VANZY を動かす"}
            </span>
            <span className="nx-meta">
              {testFocus
                ? "届いたキーをここに表示します。ほかのアプリには送りません。"
                : "この枠を選んでいる間だけ、キー入力を受け取ります"}
            </span>
          </>
        )}
      </button>
      {history.length > 0 && (
        <div className="nx-history">
          <div className="nx-history-head">
            <h2 className="nx-eyebrow">履歴</h2>
            <button type="button" className="nx-link" onClick={() => setHistory([])}>
              履歴を消す
            </button>
          </div>
          <ul>
            {history.map((entry, i) => (
              <li key={`${entry.time}-${i}`}>
                <span className="nx-mono nx-meta">{entry.time}</span>
                <span className="nx-mono nx-strong nx-grow">{entry.combo}</span>
                <span className={entry.ok ? "nx-ok-text" : "nx-warn-text"}>
                  {entry.ok ? "一致" : "不一致"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );

  return (
    <div className="nx-app">
      {header}
      <main className="nx-main">
        {notices}
        <div className="nx-side">
          {view === "assign"
            ? list(valueOf, true)
            : list((index) => expectedFor(index), false)}
          {view === "assign" ? appCard : calibrationCard}
        </div>
        <div className="nx-content">{view === "assign" ? editor : testView}</div>
        {view === "assign" && saveBar}
      </main>
      {appConfirm.confirmation}
      {writeFlow && (
        <NativeApplyDialog
          flow={writeFlow}
          error={d.error}
          blocked={d.busy || host.blocked}
          returnFocus={writeReturnFocus.current}
          onConfirm={() => void apply()}
          onStop={() => void stopBatch()}
          onClose={closeWriteFlow}
          onToggleStart={(value) =>
            setWriteFlow((current) => current && { ...current, startAfter: value })
          }
          onTest={() => {
            if (writeFlow.phase !== "result") return;
            const first = writeFlow.items.find(
              (item) => item.status === "verified" || item.status === "saved",
            );
            closeWriteFlow();
            if (first) setSel(first.index);
            setHistory([]);
            switchView("test");
          }}
        />
      )}
    </div>
  );
}

function GestureIcon({ kind, size }: { kind: GestureIconKind; size: number }) {
  const rotation: Partial<Record<GestureIconKind, number>> = {
    left: 180,
    right: 0,
    up: -90,
    down: 90,
  };
  let body: ReactNode;
  if (kind in rotation)
    body = (
      <g transform={`rotate(${rotation[kind]} 12 12)`}>
        <path d="M5 12h14" />
        <path d="m13 6 6 6-6 6" />
      </g>
    );
  else if (kind === "ccw")
    body = (
      <>
        <path d="M3 12a9 9 0 1 0 2.64-6.36L3 8" />
        <path d="M3 3v5h5" />
      </>
    );
  else if (kind === "cw")
    body = (
      <>
        <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
        <path d="M21 3v5h-5" />
      </>
    );
  else if (kind === "push")
    body = (
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="2.5" className="nx-fill-current" />
      </>
    );
  else if (kind === "tapA" || kind === "tapB")
    body = (
      <>
        <rect x="2" y="8" width="20" height="8" rx="4" />
        <circle cx={kind === "tapA" ? 7.5 : 16.5} cy="12" r="1.6" className="nx-fill-current" />
      </>
    );
  else if (kind === "swipeLeft" || kind === "swipeRight")
    body = (
      <>
        <rect x="2" y="8" width="20" height="8" rx="4" />
        {kind === "swipeLeft" ? (
          <path d="M16 12H8m2.5-2.2L8 12l2.5 2.2" />
        ) : (
          <path d="M8 12h8m-2.5-2.2L16 12l-2.5 2.2" />
        )}
      </>
    );
  else
    body = (
      <>
        <rect x="2" y="8" width="20" height="8" rx="4" />
        <path d="M8.5 12h7M10 10.4 8.5 12l1.5 1.6M14 10.4l1.5 1.6-1.5 1.6" />
      </>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="nx-stroke">
      {body}
    </svg>
  );
}
function HandIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" aria-hidden="true" className="nx-stroke nx-faint">
      <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M12 10.5V4.5a1.5 1.5 0 0 1 3 0v6" />
      <path d="M15 10.5V6.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3.6 14.6a1.5 1.5 0 0 1 2.4-1.8L9 15" />
    </svg>
  );
}
