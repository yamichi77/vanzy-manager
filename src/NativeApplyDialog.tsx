import { useEffect, useId, useRef } from "react";

export type NativeApplyItem = {
  index: number;
  name: string;
  before: string;
  after: string;
  /** device: written to VANZY. host: sent by this app. unbind: stop sending, keep the device value. */
  route: "device" | "host" | "unbind";
  status:
    | "pending"
    | "running"
    | "verified"
    | "uncertain"
    | "not_applied"
    | "saved"
    | "failed";
  error?: string;
  /** Device value that runs while the app is closed (host items only). */
  fallback?: string;
};

export type NativeApplyFlow = {
  phase: "review" | "run" | "result";
  mode: "apply" | "restore";
  items: NativeApplyItem[];
  product: string;
  firmware: string;
  canStart: boolean;
  startAfter: boolean;
  start?: "pending" | "running" | "done" | "failed" | "skipped";
  success?: boolean;
  outcome?: "complete" | "stopped" | "failed";
  stopRequested?: boolean;
  backupPath?: string;
  capturedAt?: string;
  error?: string;
};

const statusText: Record<NativeApplyItem["status"], string> = {
  pending: "待機中",
  running: "書き込み中…",
  verified: "読み戻し一致",
  uncertain: "結果未確認",
  not_applied: "未反映",
  saved: "保存済み",
  failed: "保存できません",
};
const startText = {
  pending: "待機中",
  running: "開始中…",
  done: "送信中",
  failed: "開始できません",
  skipped: "開始していません",
};

function StatusMark({ state }: { state: string }) {
  if (state === "verified" || state === "saved" || state === "done")
    return (
      <svg className="nx-mark is-ok" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  if (state === "running")
    return <span className="nx-mark-spin" aria-hidden="true" />;
  if (state === "pending")
    return <span className="nx-mark-wait" aria-hidden="true" />;
  return (
    <svg className="nx-mark is-warn" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8v5M12 16.5h.01" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

function ChangeRow({ item, showStatus }: { item: NativeApplyItem; showStatus: boolean }) {
  return (
    <div className={`nx-change ${showStatus ? `is-${item.status}` : ""}`}>
      <div className="nx-change-line">
        {showStatus && <StatusMark state={item.status} />}
        <strong className="nx-change-name">{item.name}</strong>
        <span className="nx-change-values">
          <span className="nx-mono nx-before" aria-label={`変更前: ${item.before}`}>
            {item.before}
          </span>
          <svg className="nx-arrow" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
          <span className="nx-mono nx-after" aria-label={`変更後: ${item.after}`}>
            {item.after}
          </span>
        </span>
        {showStatus && <span className="nx-change-status">{statusText[item.status]}</span>}
      </div>
      {item.fallback && !showStatus && (
        <p className="nx-meta nx-change-note">
          アプリを閉じている間は、本体の設定 <span className="nx-mono">{item.fallback}</span> が動きます。
        </p>
      )}
      {item.error && <p className="nx-change-error">{item.error}</p>}
      {item.status === "uncertain" && (
        <p className="nx-change-error">
          すでに書き込まれている可能性があります。読み直して確認してください。
        </p>
      )}
    </div>
  );
}

/** Presentation only: device and host work is done by NativeApp. */
export function NativeApplyDialog({
  flow,
  error,
  blocked,
  returnFocus,
  onConfirm,
  onClose,
  onTest,
  onStop,
  onToggleStart,
}: {
  flow: NativeApplyFlow;
  error: string;
  blocked: boolean;
  returnFocus: HTMLElement | null;
  onConfirm: () => void;
  onClose: () => void;
  onTest: () => void;
  onStop: () => void;
  onToggleStart: (value: boolean) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const running = flow.phase === "run";
  const result = flow.phase === "result";
  const review = flow.phase === "review";
  const restore = flow.mode === "restore";
  const count = flow.items.length;
  const device = flow.items.filter((item) => item.route === "device");
  const hostAdds = flow.items.filter((item) => item.route === "host");
  const unbinds = flow.items.filter((item) => item.route === "unbind");
  const done = flow.items.filter(
    (item) => item.status === "verified" || item.status === "saved",
  ).length;
  const uncertain = flow.items.filter((item) => item.status === "uncertain").length;
  const remaining = flow.items.filter(
    (item) => item.status === "pending" || item.status === "not_applied",
  ).length;
  const success = result && flow.success === true;
  const stopped = result && flow.outcome === "stopped";
  const backupSaved = Boolean(flow.backupPath);
  const showStart = !restore && flow.canStart && flow.startAfter && !review;

  useEffect(() => {
    const previous = returnFocus;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => {
      if (element?.open) element.close();
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        !previous.matches(":disabled,[aria-disabled='true']")
      )
        previous.focus();
    };
  }, []);
  useEffect(() => {
    if (!review) title.current?.focus();
  }, [review]);

  const heading = result
    ? success
      ? restore
        ? "直前の保存を元に戻しました"
        : `${count}件を保存しました`
      : stopped
        ? "残りの保存を中止しました"
        : "保存結果を確認できませんでした"
    : running
      ? restore
        ? "元に戻しています"
        : "保存しています"
      : restore
        ? "直前の保存を元に戻す"
        : `${count}件を保存`;
  const confirmLabel = restore
    ? count === 1
      ? "この1件を元に戻す"
      : `${count}件を元に戻す`
    : `${count}件を保存`;

  return (
    <dialog
      ref={dialog}
      className="nx-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!running) onClose();
      }}
    >
      <div className="nx-dialog-head">
        {result && (
          <span className={`nx-result-icon ${success ? "is-ok" : "is-warn"}`} aria-hidden="true">
            <StatusMark state={success ? "done" : "failed"} />
          </span>
        )}
        <div className="nx-dialog-title">
          <h2 id={titleId} ref={title} tabIndex={-1} className="nx-h1">
            {heading}
          </h2>
          <p className="nx-meta">
            {flow.product} · FW {flow.firmware}
          </p>
        </div>
        <button
          type="button"
          className="nx-icon-btn"
          aria-label="閉じる"
          disabled={running}
          onClick={onClose}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {review ? (
        <div className="nx-dialog-body">
          {device.length > 0 && (
            <section className="nx-dialog-group" aria-label={restore ? "元に戻す変更" : "本体に書き込む変更"}>
              <h3 className="nx-eyebrow">
                {restore ? "元に戻す" : "本体に書き込む"} · {device.length}件
              </h3>
              <div className="nx-change-list">
                {device.map((item) => (
                  <ChangeRow key={item.index} item={item} showStatus={false} />
                ))}
              </div>
            </section>
          )}
          {hostAdds.length > 0 && (
            <section className="nx-dialog-group" aria-label="アプリ経由にする変更">
              <h3 className="nx-eyebrow nx-eyebrow-app">
                <MonitorIcon size={14} />
                アプリ経由にする · {hostAdds.length}件
              </h3>
              <div className="nx-change-list is-app">
                {hostAdds.map((item) => (
                  <ChangeRow key={item.index} item={item} showStatus={false} />
                ))}
              </div>
            </section>
          )}
          {unbinds.length > 0 && (
            <section className="nx-dialog-group" aria-label="アプリ経由をやめる変更">
              <h3 className="nx-eyebrow">アプリ経由をやめる · {unbinds.length}件</h3>
              <div className="nx-change-list">
                {unbinds.map((item) => (
                  <ChangeRow key={item.index} item={item} showStatus={false} />
                ))}
              </div>
            </section>
          )}
          {!restore && flow.canStart && (
            <label className="nx-check">
              <input
                type="checkbox"
                checked={flow.startAfter}
                onChange={(event) => onToggleStart(event.target.checked)}
              />
              <span>
                <strong>保存したら、アプリ経由の送信を開始する</strong>
                <span className="nx-meta">
                  送信中は、対象の動きの本体設定を一時的に通知用へ切り替えます。停止すると元に戻します。
                </span>
              </span>
            </label>
          )}
          <div className="nx-dialog-notes">
            {device.length > 0 ? (
              <>
                <p className="nx-meta">
                  書き込みの前に自動でバックアップし、1件ずつ読み戻して確かめます。失敗したらそこで止まります。
                </p>
                <p className="nx-warn-text">完了するまで VANZY の接続を切らないでください。</p>
              </>
            ) : (
              <p className="nx-meta">本体には書き込みません。このアプリの設定として保存します。</p>
            )}
            {blocked && (
              <p role="alert" className="nx-warn-text">
                送信中や別の操作が終わるまで保存できません。
              </p>
            )}
          </div>
          <div className="nx-dialog-actions">
            <button type="button" className="nx-btn" onClick={onClose}>
              戻る
            </button>
            <button
              type="button"
              className="nx-btn nx-btn-primary"
              disabled={blocked || count === 0}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      ) : (
        <div className="nx-dialog-body">
          <p className="nx-meta" role="status">
            {[
              `完了 ${done}/${count}件`,
              uncertain > 0 && `結果未確認 ${uncertain}件`,
              result && remaining > 0 && `未反映 ${remaining}件`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="nx-change-list" aria-label="保存の進行状況" aria-live="polite">
            {device.length > 0 && (
              <div className="nx-change">
                <div className="nx-change-line">
                  <StatusMark
                    state={backupSaved ? "verified" : running ? "running" : "failed"}
                  />
                  <span className="nx-change-name is-wide nx-meta">変更前の設定をバックアップ</span>
                  <span className="nx-change-status">
                    {backupSaved ? "保存済み" : running ? "保存中…" : "確認できません"}
                  </span>
                </div>
              </div>
            )}
            {flow.items.map((item) => (
              <ChangeRow key={item.index} item={item} showStatus />
            ))}
            {showStart && flow.start && (
              <div className="nx-change">
                <div className="nx-change-line">
                  <StatusMark state={flow.start === "skipped" ? "failed" : flow.start} />
                  <span className="nx-change-name is-wide">アプリ経由の送信を開始</span>
                  <span className="nx-change-status">{startText[flow.start]}</span>
                </div>
              </div>
            )}
          </div>
          {running && flow.error && (
            <p className="nx-alert" role="alert">
              {flow.error}
            </p>
          )}
          {running ? (
            <div className="nx-dialog-actions">
              <span className="nx-meta nx-grow">処理中の1件を終えてから止めます</span>
              <button
                type="button"
                className="nx-btn"
                disabled={flow.stopRequested === true || device.length === 0}
                onClick={onStop}
              >
                {flow.stopRequested ? "中止を待っています…" : "残りを中止"}
              </button>
            </div>
          ) : (
            <>
              {backupSaved && (
                <div className="nx-backup-line">
                  <span className="nx-eyebrow">変更前のバックアップ</span>
                  <code>{flow.backupPath}</code>
                  <span className="nx-meta">
                    {flow.capturedAt
                      ? new Date(flow.capturedAt).toLocaleString("ja-JP")
                      : "日時不明"}
                  </span>
                </div>
              )}
              {success && showStart && flow.start === "done" && (
                <p className="nx-meta">
                  アプリ経由の送信も始まっています。止めるときは、割り当て画面の左下から停止できます。
                </p>
              )}
              {showStart && (flow.start === "failed" || flow.start === "skipped") && (
                <p className="nx-alert" role="alert">
                  アプリ経由の送信は開始していません。割り当て画面の左下から開始できます。
                </p>
              )}
              {!success &&
                (flow.error || error || uncertain > 0 || !stopped) && (
                  <p className="nx-alert" role="alert">
                    {flow.error ||
                      error ||
                      "変更済みの可能性があります。本体を読み直して確認してください。"}
                  </p>
                )}
              <div className="nx-dialog-actions">
                <button type="button" className="nx-btn" onClick={onClose}>
                  編集画面へ戻る
                </button>
                {done > 0 && (
                  <button type="button" className="nx-btn nx-btn-primary" onClick={onTest}>
                    動きを試す
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </dialog>
  );
}

export function MonitorIcon({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <svg
      className="nx-monitor"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}
