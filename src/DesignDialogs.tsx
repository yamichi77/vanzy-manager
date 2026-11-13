import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { Button } from "@astryxdesign/core";
import {
  Archive,
  ArrowRight,
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  FlaskConical,
  Info,
  LockKeyhole,
  Minus,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  GESTURES,
  BASELINE,
  gestureName,
  restoreBindings,
  MODIFIERS,
  bindingLabel,
  canRestore,
  changes,
  cloneBindings,
  equalBinding,
  makeBackup,
  normalize,
  supportedCode,
} from "./domain";
import type { Binding, Bindings, DemoBackup, Gesture, OS } from "./domain";
import "./design-dialogs.css";

export function DesignDialog({
  titleId,
  className = "",
  onClose,
  children,
}: {
  titleId: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className={`vz-dialog ${className}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}

function DemoCaption() {
  return (
    <span className="vz-demo-caption">
      <FlaskConical size={13} aria-hidden="true" />
      DEMO · 実機への接続・書込みは行いません
    </span>
  );
}

function DiffRow({
  gesture,
  before,
  after,
  os,
}: {
  gesture: Gesture;
  before: Binding;
  after: Binding;
  os: OS;
}) {
  const changed = !equalBinding(before, after);
  return (
    <div className={`vz-diff-row ${changed ? "" : "is-unchanged"}`}>
      <strong className="vz-row-name">{gestureName(gesture)}</strong>
      {changed ? (
        <>
          <span className="vz-value vz-before">{bindingLabel(before, os)}</span>
          <ArrowRight size={16} className="vz-diff-arrow" aria-hidden="true" />
          <span className="vz-value vz-after">{bindingLabel(after, os)}</span>
        </>
      ) : (
        <>
          <span className="vz-value">{bindingLabel(after, os)}</span>
          <span className="vz-unchanged-label">変わりません</span>
        </>
      )}
    </div>
  );
}

type RowStatus =
  "wait" | "write" | "verify" | "recheck" | "ok" | "fail" | "skip";
type ApplyPhase = "review" | "run" | "result";

const statusLabels: Record<RowStatus, string> = {
  wait: "待機中",
  write: "書き込み中…（デモ）",
  verify: "読み戻して確認中…（デモ）",
  recheck: "応答なし。サンプル値を再確認中…",
  ok: "確認済み（デモ）",
  fail: "反映されていません",
  skip: "停止したため未実行",
};

function StatusIcon({ status }: { status: RowStatus }) {
  if (status === "ok") return <Check size={18} aria-hidden="true" />;
  if (status === "fail") return <X size={18} aria-hidden="true" />;
  if (status === "skip") return <Minus size={18} aria-hidden="true" />;
  return (
    <span
      aria-hidden="true"
      className={`vz-status-circle ${status === "wait" ? "" : "is-spinning"}`}
    />
  );
}

export type DesignApplyResult = {
  baseline: Bindings;
  applied: Gesture[];
  failed: Gesture | null;
  stopped: boolean;
};

export type DesignApplyProps = {
  baseline: Bindings;
  draft: Bindings;
  os: OS;
  onApplyResult: (result: DesignApplyResult) => void;
  onBackupCreated: (backup: DemoBackup) => void;
  onRestart: (baseline: Bindings, draft: Bindings) => void;
  onOpenBackups: () => void;
  onClose: () => void;
};

/** A timer-driven UI demonstration. It has no device transport or native calls. */
export function DesignApply(props: DesignApplyProps) {
  const titleId = useId();
  const [original] = useState(() => ({
    baseline: cloneBindings(props.baseline),
    draft: cloneBindings(props.draft),
  }));
  const [items] = useState(() => changes(original.baseline, original.draft));
  const [phase, setPhase] = useState<ApplyPhase>("review");
  const [statuses, setStatuses] = useState<RowStatus[]>(() =>
    items.map(() => "wait"),
  );
  const [backup, setBackup] = useState<DemoBackup | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [failSimulation, setFailSimulation] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [runError, setRunError] = useState("");
  useEffect(() => {
    document.getElementById(titleId)?.focus();
  }, [phase, titleId]);
  const statusRef = useRef(statuses);
  const stopRef = useRef(false);
  const busyRef = useRef(false);
  const generationRef = useRef(0);
  const timers = useRef(new Set<number>());
  const callbacks = useRef(props);
  useEffect(() => {
    callbacks.current = props;
  }, [props]);
  useEffect(
    () => () => {
      generationRef.current += 1;
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    },
    [],
  );

  function later(delay: number, action: () => void) {
    const generation = generationRef.current;
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      if (generation === generationRef.current) {
        try {
          action();
        } catch {
          generationRef.current += 1;
          timers.current.forEach((pending) => window.clearTimeout(pending));
          timers.current.clear();
          busyRef.current = false;
          setBackupBusy(false);
          updateStatuses(
            statusRef.current.map((status) =>
              status === "ok" ? status : "skip",
            ),
          );
          setRunError(
            "デモ処理に失敗しました。下書きは保持しています。閉じてやり直してください。",
          );
          setPhase("result");
        }
      }
    }, delay);
    timers.current.add(timer);
  }

  function updateStatuses(next: RowStatus[]) {
    statusRef.current = next;
    setStatuses(next);
  }

  function updateStatus(index: number, value: RowStatus) {
    updateStatuses(
      statusRef.current.map((status, i) => (i === index ? value : status)),
    );
  }

  function finish() {
    busyRef.current = false;
    const nextBaseline = cloneBindings(original.baseline);
    const applied: Gesture[] = [];
    let failed: Gesture | null = null;
    items.forEach((item, index) => {
      if (statusRef.current[index] === "ok") {
        nextBaseline[item.gesture] = normalize(item.after);
        applied.push(item.gesture);
      } else if (statusRef.current[index] === "fail") failed = item.gesture;
    });
    setPhase("result");
    callbacks.current.onApplyResult({
      baseline: nextBaseline,
      applied,
      failed,
      stopped: statusRef.current.includes("skip"),
    });
  }

  function runFrom(index: number, simulateFailure: boolean) {
    if (index >= items.length) {
      finish();
      return;
    }
    if (stopRef.current) {
      updateStatuses(
        statusRef.current.map((status, i) =>
          i >= index && status !== "ok" ? "skip" : status,
        ),
      );
      finish();
      return;
    }
    updateStatus(index, "write");
    later(800, () => {
      const willFail = simulateFailure && index === (items.length > 1 ? 1 : 0);
      updateStatus(index, willFail ? "recheck" : "verify");
      later(willFail ? 1300 : 800, () => {
        updateStatus(index, willFail ? "fail" : "ok");
        if (willFail) {
          updateStatuses(
            statusRef.current.map((status, i) =>
              i > index && status !== "ok" ? "skip" : status,
            ),
          );
          finish();
          return;
        }
        later(400, () => runFrom(index + 1, simulateFailure));
      });
    });
  }

  function start() {
    if (busyRef.current || items.length === 0) return;
    busyRef.current = true;
    stopRef.current = false;
    setStopRequested(false);
    setRetrying(false);
    setRunError("");
    setPhase("run");
    setBackupBusy(true);
    updateStatuses(items.map(() => "wait"));
    later(900, () => {
      const saved = {
        ...makeBackup(original.baseline),
        name: "反映前の自動保存（デモ）",
      };
      setBackup(saved);
      setBackupBusy(false);
      callbacks.current.onBackupCreated(saved);
      later(400, () => runFrom(0, failSimulation));
    });
  }

  function requestStop() {
    if (!busyRef.current) return;
    stopRef.current = true;
    setStopRequested(true);
  }

  function retry() {
    if (busyRef.current) return;
    const index = statusRef.current.findIndex((status) => status !== "ok");
    if (index < 0) return;
    busyRef.current = true;
    stopRef.current = false;
    setStopRequested(false);
    setRetrying(true);
    updateStatuses(
      statusRef.current.map((status) => (status === "ok" ? status : "wait")),
    );
    setPhase("run");
    later(300, () => runFrom(index, false));
  }

  function restart() {
    if (busyRef.current) return;
    generationRef.current += 1;
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.clear();
    updateStatuses(items.map(() => "wait"));
    setBackup(null);
    setBackupBusy(false);
    stopRef.current = false;
    setStopRequested(false);
    setRetrying(false);
    setFailSimulation(false);
    setRunError("");
    setPhase("review");
    callbacks.current.onRestart(
      cloneBindings(original.baseline),
      cloneBindings(original.draft),
    );
  }

  function closeOrStop() {
    if (busyRef.current) requestStop();
    else props.onClose();
  }

  const okCount = statuses.filter((status) => status === "ok").length;
  const remaining = items.length - okCount;
  const allOk = remaining === 0 && !runError;
  const anyFail = statuses.includes("fail");
  const title = runError
    ? "デモ処理を停止しました"
    : phase === "review"
      ? "反映する前に（デモ）"
      : phase === "run"
        ? "反映しています（デモ）"
        : allOk
          ? retrying
            ? "残りの変更も反映できました"
            : `${items.length}件を反映しました（デモ）`
          : anyFail
            ? `${remaining}件が反映されていません（${okCount}/${items.length}件 反映済み）`
            : `途中で中止しました（${okCount}/${items.length}件 反映済み）`;

  return (
    <DesignDialog
      titleId={titleId}
      onClose={closeOrStop}
      className="vz-apply-dialog"
    >
      <div className="vz-dialog-topline">
        <DemoCaption />
        <Button
          className="vz-close"
          label={phase === "run" ? "中止して結果を確認" : "閉じる"}
          variant="ghost"
          isIconOnly
          icon={<X size={18} aria-hidden="true" />}
          isDisabled={phase === "run" && stopRequested}
          onClick={closeOrStop}
        />
      </div>

      {phase === "result" ? (
        <div
          className={`vz-result-banner ${allOk ? "is-success" : "is-partial"}`}
          role="status"
        >
          {allOk ? (
            <CircleCheck size={28} aria-hidden="true" />
          ) : (
            <CircleAlert size={28} aria-hidden="true" />
          )}
          <div>
            <h2 id={titleId} tabIndex={-1}>
              {title}
            </h2>
            <p>
              {allOk
                ? "サンプル値の書込みと読戻しを再現しました。実機の検証結果ではありません。"
                : "サンプル基準値はいま、下の状態です。反映済みの項目はそのまま残っています。"}
            </p>
          </div>
        </div>
      ) : (
        <div className="vz-dialog-title">
          <h2 id={titleId} tabIndex={-1}>
            {title}
          </h2>
          <p>
            {phase === "review"
              ? `次の${items.length}件を、サンプル基準値に反映します。`
              : "1件ずつ書き込み、読み戻して確かめる流れを再現しています。"}
          </p>
        </div>
      )}

      {runError && (
        <p className="vz-warning" role="alert">
          {runError}
        </p>
      )}
      {phase === "review" ? (
        <>
          <div className="vz-diff-table" aria-label="反映する変更">
            {items.length === 0 ? (
              <p className="vz-empty">変更はありません。</p>
            ) : (
              items.map((item) => (
                <DiffRow key={item.gesture} {...item} os={props.os} />
              ))
            )}
          </div>
          <ol className="vz-apply-steps">
            <li>
              <span className="vz-step-number">01</span>
              <strong>バックアップ</strong>
              <p>今のサンプル基準値を、先に保存します</p>
            </li>
            <li>
              <span className="vz-step-number">02</span>
              <strong>1件ずつ書込み</strong>
              <p>書込みと読戻しの照合を、デモで再現します</p>
            </li>
            <li>
              <span className="vz-step-number">03</span>
              <strong>失敗したら停止</strong>
              <p>どこまで反映したかを、そのまま表示します</p>
            </li>
          </ol>
          <div className="vz-warning">
            <TriangleAlert size={18} aria-hidden="true" />
            <p>
              これはデモです。VANZYには接続しません。途中で中止・失敗しても、反映済みと未反映を分けて表示します。反映したサンプル値は自動では元に戻りません。
            </p>
          </div>
          <label className="vz-failure-toggle">
            <input
              type="checkbox"
              checked={failSimulation}
              onChange={(event) => setFailSimulation(event.target.checked)}
            />
            途中失敗を再現する
          </label>
          <div className="vz-dialog-actions">
            <Button
              className="vz-action"
              label="キャンセル"
              onClick={props.onClose}
            />
            <Button
              className="vz-action vz-primary"
              label={`${items.length}件を反映する（デモ）`}
              isDisabled={!items.length}
              onClick={start}
            />
          </div>
        </>
      ) : (
        <>
          <div
            className="vz-progress-table"
            aria-label="デモ反映の進行状況"
            aria-live="polite"
          >
            <div
              className={`vz-backup-progress ${backupBusy ? "status-write" : backup ? "status-ok" : "status-skip"}`}
            >
              <StatusIcon
                status={backupBusy ? "write" : backup ? "ok" : "skip"}
              />
              <strong className="vz-row-name">バックアップ</strong>
              <span>
                {backupBusy
                  ? "今のサンプル基準値を保存しています…"
                  : backup
                    ? `セッション内に保存しました：${formatDate(backup.createdAt)}`
                    : "バックアップを保存できませんでした"}
              </span>
            </div>
            {items.map((item, index) => {
              const status = statuses[index];
              const applied = status === "ok";
              const unchanged = status === "fail" || status === "skip";
              return (
                <div
                  key={item.gesture}
                  className={`vz-progress-row status-${status}`}
                >
                  <div className="vz-progress-line">
                    <StatusIcon status={status} />
                    <strong className="vz-row-name">
                      {gestureName(item.gesture)}
                    </strong>
                    <span
                      className={`vz-value ${applied ? "is-applied" : unchanged ? "is-current" : "vz-after"}`}
                    >
                      {bindingLabel(
                        unchanged ? item.before : item.after,
                        props.os,
                      )}
                    </span>
                    <span className="vz-progress-status">
                      {statusLabels[status]}
                    </span>
                  </div>
                  {status === "fail" && (
                    <p className="vz-failure-detail">
                      応答がない状況を再現しました。サンプル値は変更前の「
                      {bindingLabel(item.before, props.os)}
                      」のままです。変更後の値は下書きに残っています。
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {phase === "run" ? (
            <div className="vz-stop-row">
              <p>
                {stopRequested
                  ? "中止を受け付けました。処理中の項目の確認が終わるまでお待ちください。"
                  : "中止すると、いま処理している項目の読戻し確認を終えてから止めます。反映済みの項目は元に戻りません。"}
              </p>
              <Button
                className="vz-action"
                label={stopRequested ? "中止します…" : "残りを中止"}
                isDisabled={stopRequested}
                onClick={requestStop}
              />
            </div>
          ) : allOk ? (
            <div className="vz-dialog-actions">
              <Button
                className="vz-action vz-mock-action"
                label="モック用：最初から"
                onClick={restart}
              />
              <Button
                className="vz-action vz-primary"
                label="編集画面へ戻る"
                onClick={props.onClose}
              />
            </div>
          ) : (
            <>
              <p className="vz-result-note">
                未反映の変更は下書きに残っています。バックアップから戻す場合も、まず差分を確認して下書きへ取り込み、同じ反映フローをデモで試せます。
              </p>
              <div className="vz-dialog-actions">
                <Button
                  className="vz-action"
                  label="このままにする"
                  onClick={props.onClose}
                />
                <Button
                  className="vz-action"
                  label="バックアップから戻す"
                  onClick={props.onOpenBackups}
                />
                <Button
                  className="vz-action vz-primary"
                  label={
                    anyFail
                      ? `反映されていない${remaining}件をもう一度`
                      : `残り${remaining}件を続けて反映`
                  }
                  isDisabled={!!runError}
                  onClick={retry}
                />
              </div>
            </>
          )}
        </>
      )}
    </DesignDialog>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "日時不明"
    : date.toLocaleString("ja-JP", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function parseBinding(value: unknown, allowEmpty = false): Binding | null {
  if (!value || typeof value !== "object") return null;
  const binding = value as Partial<Binding> & { code?: unknown };
  // Read old 0.1.5 single-key demo exports as one-key combinations.
  const codes = Object.hasOwn(binding, "codes")
    ? binding.codes
    : [binding.code];
  if (
    !Array.isArray(codes) ||
    (!allowEmpty && codes.length === 0) ||
    !codes.every(
      (code): code is string => typeof code === "string" && supportedCode(code),
    ) ||
    new Set(codes).size !== codes.length ||
    !Array.isArray(binding.modifiers) ||
    (codes.length === 0 && binding.modifiers.length > 0) ||
    binding.modifiers.length > MODIFIERS.length ||
    !binding.modifiers.every((modifier) => MODIFIERS.includes(modifier)) ||
    new Set(binding.modifiers).size !== binding.modifiers.length
  )
    return null;
  return normalize({ codes, modifiers: binding.modifiers });
}

/** Accept only this UI's sample format, never a real hardware backup. */
export function parseDemoBackup(text: string): DemoBackup {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object")
    throw new Error("デモJSONの形式ではありません。");
  const value = parsed as Partial<DemoBackup>;
  const legacy = value.schemaVersion === undefined;
  if (
    value.source !== "demo" ||
    (!legacy && value.schemaVersion !== 2) ||
    (value.firmware !== "demo-v1" && value.firmware !== "unknown") ||
    typeof value.name !== "string" ||
    value.name.length > 160 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !value.bindings ||
    typeof value.bindings !== "object" ||
    Array.isArray(value.bindings) ||
    (value.legacyLeftRightOnly !== undefined &&
      typeof value.legacyLeftRightOnly !== "boolean")
  ) {
    throw new Error(
      "対応するデモJSONだけ読み込めます。実機のバックアップは読み込めません。",
    );
  }
  const expected: Gesture[] = legacy ? ["left", "right"] : GESTURES;
  const keys = Object.keys(value.bindings);
  if (
    keys.length !== expected.length ||
    keys.some((id) => !expected.includes(id as Gesture))
  ) {
    throw new Error(
      "ジェスチャーの項目が不足しているか、未対応の項目が含まれています。",
    );
  }
  const bindings = cloneBindings(BASELINE);
  for (const id of expected) {
    const binding = parseBinding(value.bindings[id], !legacy);
    if (!binding) throw new Error("デモのキー割当形式が不正です。");
    bindings[id] = binding;
  }
  return {
    schemaVersion: 2,
    legacyLeftRightOnly: legacy || value.legacyLeftRightOnly === true,
    id: crypto.randomUUID(),
    name: value.name || "読み込んだサンプル",
    createdAt: value.createdAt,
    firmware: value.firmware,
    source: "demo",
    kind: "imported",
    bindings,
  };
}

export type DesignBackupsProps = {
  baseline: Bindings;
  draft: Bindings;
  backups: DemoBackup[];
  os: OS;
  onAddBackup: (backup: DemoBackup) => void;
  onRestoreDraft: (nextDraft: Bindings, backup: DemoBackup) => void;
  onClose: () => void;
};

export function DesignBackups(props: DesignBackupsProps) {
  const titleId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(
    () => props.backups[0]?.id ?? null,
  );
  const [notice, setNotice] = useState("");
  const [confirmRestore, setConfirmRestore] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (confirmRestore) confirmRef.current?.focus();
  }, [confirmRestore]);
  const alive = useRef(true);
  const downloads = useRef(new Map<string, number>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      downloads.current.forEach((timer, url) => {
        window.clearTimeout(timer);
        URL.revokeObjectURL(url);
      });
      downloads.current.clear();
    };
  }, []);
  const selected =
    props.backups.find((backup) => backup.id === selectedId) ??
    props.backups[0];
  const compatible = selected ? canRestore(selected) : false;
  const restoreTarget = selected
    ? restoreBindings(props.draft, selected)
    : props.draft;
  const restoreChanges = changes(props.draft, restoreTarget);
  const replacedDraftCount = restoreChanges.filter(
    (change) =>
      !equalBinding(
        props.draft[change.gesture],
        props.baseline[change.gesture],
      ) && !equalBinding(props.draft[change.gesture], change.after),
  ).length;

  function saveCurrent() {
    const backup = {
      ...makeBackup(props.baseline),
      name: "手動で保存（デモ）",
      kind: "manual" as const,
    };
    props.onAddBackup(backup);
    setSelectedId(backup.id);
    setNotice(
      "現在のサンプル基準値を保存しました。未反映の下書きは含めていません。",
    );
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 256 * 1024) {
      setNotice(
        "ファイルが大きすぎます。256 KB以下のデモJSONを選んでください。",
      );
      return;
    }
    try {
      const imported = parseDemoBackup(await file.text());
      if (!alive.current) return;
      props.onAddBackup(imported);
      setSelectedId(imported.id);
      setNotice(
        imported.legacyLeftRightOnly
          ? "旧版の左右デモJSONを読み込みました。復元しても追加の9項目は変更しません。下書きや基準値はまだ変更していません。"
          : "デモJSONを読み込みました。下書きや基準値はまだ変更していません。",
      );
    } catch (error) {
      if (alive.current)
        setNotice(
          error instanceof SyntaxError
            ? "JSONを読み取れませんでした。ファイルの形式を確認してください。"
            : error instanceof Error
              ? error.message
              : "読み込みに失敗しました。",
        );
    }
  }

  function exportSelected() {
    if (!selected) return;
    try {
      const blob = new Blob(
        [
          JSON.stringify(
            {
              ...selected,
              warning:
                "UI sample only. Not a device backup. Do not write to hardware.",
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `vanzy-demo-${selected.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
      link.click();
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(url);
        downloads.current.delete(url);
      }, 1000);
      downloads.current.set(url, timer);
      setNotice(
        "デモJSONの書き出しを開始しました。実機への復元には使えません。",
      );
    } catch {
      setNotice("この環境ではファイルを書き出せませんでした。");
    }
  }

  function restoreDraft() {
    if (!selected || !compatible || restoreChanges.length === 0) return;
    try {
      const savedDraft: DemoBackup = {
        ...makeBackup(props.draft),
        kind: "draft",
        name: "復元前の下書き（退避）",
      };
      props.onAddBackup(savedDraft);
      props.onRestoreDraft(cloneBindings(restoreTarget), selected);
    } catch {
      setNotice(
        "下書きの退避または復元準備に失敗しました。下書きを確認し、変更せずに閉じることができます。",
      );
    }
  }

  return (
    <DesignDialog
      titleId={titleId}
      onClose={props.onClose}
      className="vz-backups-dialog"
    >
      <div className="vz-dialog-topline">
        <DemoCaption />
        <Button
          className="vz-close"
          label="閉じる"
          variant="ghost"
          isIconOnly
          icon={<X size={18} aria-hidden="true" />}
          onClick={props.onClose}
        />
      </div>
      <div className="vz-backups-heading">
        <div className="vz-dialog-title">
          <h2 id={titleId} tabIndex={-1}>
            バックアップ
          </h2>
          <p>
            デモの反映前には自動保存します。戻す前に、何が変わるかを必ず確認します。
          </p>
        </div>
        <div className="vz-backup-header-actions">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            aria-label="デモJSONを選択"
            className="vz-file-input"
            tabIndex={-1}
            onChange={importFile}
          />
          <Button
            className="vz-action vz-small"
            label="ファイルから読み込む"
            onClick={() => fileRef.current?.click()}
          />
          <Button
            className="vz-action vz-small vz-save"
            label="今の設定を保存"
            onClick={saveCurrent}
          />
        </div>
      </div>
      <ul className="vz-backup-list" aria-label="保存済みのバックアップ">
        {props.backups.map((backup) => {
          const allowed = canRestore(backup);
          const active = selected?.id === backup.id;
          return (
            <li key={backup.id}>
              <button
                type="button"
                className={`vz-backup-choice ${active ? "is-selected" : ""} ${allowed ? "" : "is-incompatible"}`}
                aria-pressed={active}
                onClick={() => {
                  setConfirmRestore(false);
                  setSelectedId(backup.id);
                  setNotice("");
                }}
              >
                {allowed ? (
                  backup.kind === "auto" ? (
                    <Clock3 size={20} aria-hidden="true" />
                  ) : (
                    <Archive size={20} aria-hidden="true" />
                  )
                ) : (
                  <LockKeyhole size={20} aria-hidden="true" />
                )}
                <span className="vz-backup-description">
                  <strong>{backup.name}</strong>
                  <span>
                    {formatDate(backup.createdAt)} · FW {backup.firmware} ·
                    {backup.legacyLeftRightOnly ? 2 : GESTURES.length}項目
                  </span>
                </span>
                {allowed ? (
                  <span className="vz-fw-badge">デモ互換</span>
                ) : (
                  <span className="vz-incompatible-label">
                    互換性不明のため戻せません
                    <br />
                    <span>中身を見る</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {props.backups.length === 0 && (
          <li className="vz-empty">保存済みのバックアップはありません。</li>
        )}
      </ul>
      <section
        className="vz-backup-comparison"
        aria-label="バックアップの内容と比較"
      >
        <div className="vz-comparison-heading">
          <h3>
            {compatible
              ? "このバックアップに戻すと変わる項目"
              : selected
                ? "バックアップの内容（閲覧のみ）"
                : "バックアップを選択"}
          </h3>
          <span>
            {compatible
              ? "現在の下書き全体と比べた結果です"
              : "現在のサンプル基準値と比べた結果です"}
          </span>
        </div>
        {selected && (
          <div className="vz-diff-table">
            {(selected.legacyLeftRightOnly
              ? (["left", "right"] as Gesture[])
              : GESTURES
            ).map((gesture) => (
              <DiffRow
                key={gesture}
                gesture={gesture}
                before={
                  compatible ? props.draft[gesture] : props.baseline[gesture]
                }
                after={restoreTarget[gesture]}
                os={props.os}
              />
            ))}
          </div>
        )}
        <div className="vz-restore-info">
          {compatible ? (
            <Info size={18} aria-hidden="true" />
          ) : (
            <LockKeyhole size={18} aria-hidden="true" />
          )}
          <p>
            {compatible
              ? `${selected?.legacyLeftRightOnly ? "旧版の左右2項目だけを復元し、追加の9項目は現在の下書きを保ちます。" : "11項目の下書き全体を、このバックアップの値に戻します。"}確認後に現在の下書きを退避保存し、反映確認へ進みます。基準値はまだ変えず、実機には書き込みません。`
              : selected
                ? "互換性を確認できないため、下書きへの取り込みはできません。内容の閲覧とデモJSONの書き出しだけ行えます。"
                : "保存または読み込んだデモデータを、ここで確認できます。"}
          </p>
        </div>
        {replacedDraftCount > 0 && compatible && (
          <p className="vz-restore-draft-warning">
            対象の{replacedDraftCount}
            件には未反映の編集があります。復元すると置き換わりますが、現在の下書きは「復元前の下書き（退避）」に保存し、戻せるようにします。
          </p>
        )}
        {selected && compatible && !restoreChanges.length && (
          <p className="vz-no-restore-changes">
            現在の下書きと同じです。戻す項目はありません。
          </p>
        )}
        <div className="vz-dialog-actions">
          <Button
            className="vz-action"
            label="ファイルに書き出す（.json）"
            isDisabled={!selected}
            onClick={exportSelected}
          />
          <Button
            className="vz-action vz-primary"
            label={
              compatible
                ? restoreChanges.length
                  ? `${restoreChanges.length}件を下書きに戻す`
                  : "戻す項目はありません"
                : "復元できません"
            }
            isDisabled={!compatible || !restoreChanges.length}
            onClick={() => setConfirmRestore(true)}
          />
        </div>
      </section>
      {confirmRestore && selected && compatible && (
        <div
          className="vz-warning"
          role="group"
          aria-label="下書き全体の復元確認"
          tabIndex={-1}
          ref={confirmRef}
        >
          <div>
            <h3>
              {selected.legacyLeftRightOnly
                ? "左右2項目の下書きを戻しますか？"
                : "下書き全体を戻しますか？"}
            </h3>
            <p>
              上の比較にある{restoreChanges.length}
              件を置き換えます。今の下書きは退避保存します。次の確認画面で実行するまで、サンプル基準値も実機も変わりません。
            </p>
            <div className="vz-dialog-actions">
              <Button
                className="vz-action"
                label="復元をキャンセル"
                onClick={() => {
                  setConfirmRestore(false);
                  document.getElementById(titleId)?.focus();
                }}
              />
              <Button
                className="vz-action vz-primary"
                label="下書きを保存して復元へ進む"
                onClick={restoreDraft}
              />
            </div>
          </div>
        </div>
      )}
      <p className="vz-backup-footnote">
        デモの保存はこのセッション内だけです。再読込み・終了で消えます。実機のバックアップではありません。
      </p>
      <p className="vz-dialog-notice" role="status">
        {notice}
      </p>
    </DesignDialog>
  );
}
