import { useCallback, useEffect, useRef, useState } from "react";

/** A visible, cancellable confirmation for WebViews without window.confirm. */
export function useAppConfirm() {
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef<((answer: boolean) => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const finish = useCallback((answer: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    dialog.current?.close?.();
    setMessage(null);
    returnFocus.current?.focus();
    resolve?.(answer);
  }, []);
  const ask = useCallback((text: string): Promise<boolean> => {
    if (pending.current) return Promise.resolve(false);
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return new Promise((resolve) => { pending.current = resolve; setMessage(text); });
  }, []);
  useEffect(() => {
    if (message && dialog.current) {
      if (typeof dialog.current.showModal === "function") dialog.current.showModal();
      else dialog.current.setAttribute("open", "");
    }
  }, [message]);
  useEffect(() => () => { pending.current?.(false); pending.current = null; }, []);
  const confirmation = message ? (
    <dialog ref={dialog} aria-label="操作の確認" className="nx-card" style={{maxWidth: 520, padding: 24}}
      onCancel={(event) => { event.preventDefault(); finish(false); }}>
      <h2>操作の確認</h2>
      <p>{message}</p>
      <div style={{display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 24}}>
        <button type="button" className="nx-btn" autoFocus onClick={() => finish(false)}>キャンセル</button>
        <button type="button" className="nx-btn" onClick={() => finish(true)}>確認して実行</button>
      </div>
    </dialog>
  ) : null;
  return { ask, confirmation };
}
