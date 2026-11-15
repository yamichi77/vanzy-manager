import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { validateMacro, type MacroDefinition } from "./macro-model";
export type MacroBinding = { index: number; macro: MacroDefinition };
export type MacroStatus = {
  running: boolean;
  step: number | null;
  error: string | null;
};
export function validMacroProfile(raw: unknown): raw is MacroBinding[] {
  return (
    Array.isArray(raw) &&
    raw.length <= 11 &&
    new Set(raw.map((x) => x?.index)).size === raw.length &&
    raw.every(
      (x) =>
        x &&
        Number.isInteger(x.index) &&
        x.index >= 1 &&
        x.index <= 11 &&
        validateMacro(x.macro) === null,
    )
  );
}
export function useMacroProfile(identity: string, inspect: boolean) {
  const [profile, setProfile] = useState<MacroBinding[]>([]);
  const [known, setKnown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState<MacroStatus>({
    running: false,
    step: null,
    error: null,
  });
  const key = useRef("");
  useEffect(() => {
    key.current = identity ? `vanzy-host-macros:v1:${identity}` : "";
    setProfile([]);
    setNotice("");
    if (!key.current) return;
    try {
      const raw: unknown = JSON.parse(
        localStorage.getItem(key.current) ?? "[]",
      );
      if (!validMacroProfile(raw)) throw new Error();
      setProfile(raw);
    } catch {
      setNotice(
        "保存済みマクロを読み込めません。実行せず、既存のキー割り当てを保持しています。",
      );
    }
  }, [identity]);
  useEffect(() => {
    if (!inspect && profile.length === 0) return;
    let alive = true;
    const refresh = async () => {
      try {
        const raw = await invoke<MacroStatus>("macro_status");
        if (
          typeof raw?.running !== "boolean" ||
          (raw.step !== null && !Number.isInteger(raw.step))
        )
          throw new Error();
        if (alive) {
          setStatus(raw);
          setKnown(true);
        }
      } catch {
        if (alive) {
          setKnown(false);
          setNotice(
            "マクロの実行状態を確認できません。再実行しないでください。",
          );
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 300);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [inspect, profile.length]);
  function save(index: number, macro: MacroDefinition | null) {
    if (!key.current || !known || busy || status.running) return false;
    const next = [
      ...profile.filter((x) => x.index !== index),
      ...(macro ? [{ index, macro }] : []),
    ];
    if (!validMacroProfile(next)) return false;
    try {
      localStorage.setItem(key.current, JSON.stringify(next));
      setProfile(next);
      setNotice(
        macro
          ? "マクロをこのPCだけに保存しました。本体設定は変更していません。"
          : "マクロを解除しました。元のキー割り当ては変更していません。",
      );
      return true;
    } catch {
      setNotice("マクロを保存できませんでした。");
      return false;
    }
  }
  async function test(macro: MacroDefinition) {
    if (!known || busy || status.running || validateMacro(macro)) return;
    setBusy(true);
    try {
      setNotice("");
      await invoke("macro_test", { macro });
      setStatus({ running: true, step: null, error: null });
    } catch {
      setNotice(
        "マクロを開始できませんでした。状態と対応OSを確認してください。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    try {
      await invoke("macro_cancel");
    } catch {
      setNotice("マクロ停止の確認に失敗しました。再実行しないでください。");
    }
  }
  return { profile, save, notice, status, known, busy, test, stop };
}
