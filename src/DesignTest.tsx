import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button } from "@astryxdesign/core";
import {
  createChordCapture,
  supportedCode,
  bindingLabel,
  equalBinding,
  MODIFIERS,
  modifierLabel,
  gestureName as name,
  gestureInfo,
  GESTURES,
} from "./domain";
import type { Binding, Bindings, Gesture, OS } from "./domain";
export type TestLogRow = {
  gesture: Gesture;
  title: string;
  body: string;
  got: Binding;
  recognition: Gesture | null;
  n: number;
  tried: string;
  recognized: string;
  received: string;
  verdict: string;
  tone: string;
};
export function DesignTest({
  selected,
  logs,
  setLogs,
  allBaselines,
  baseline,
  draft,
  os,
}: {
  selected: Gesture;
  logs: TestLogRow[];
  setLogs: Dispatch<SetStateAction<TestLogRow[]>>;
  allBaselines: Bindings;
  baseline: Binding;
  draft: Binding;
  os: OS;
}) {
  const other =
    GESTURES.find(
      (id) => id !== selected && allBaselines[id].codes.length > 0,
    ) ?? GESTURES.find((id) => id !== selected)!;
  const chord = useRef(createChordCapture());
  useEffect(() => {
    chord.current.clear();
    const clear = () => chord.current.clear();
    window.addEventListener("blur", clear);
    return () => {
      clear();
      window.removeEventListener("blur", clear);
    };
  }, [selected, baseline]);
  const selectedLog = logs.find((row) => row.gesture === selected);
  const received = selectedLog?.got;
  const recognized = selectedLog?.recognition;
  function classify(got: Binding, recognition: Gesture | null) {
    if (!baseline.codes.length)
      return {
        title: "デモ未割当のため判定できません",
        body: "この項目のサンプル基準値は空です。割当を編集してデモ反映すると比較できます。本体の割当や認識状態を表してはいません。",
        verdict: "判定対象外",
        tone: "neutral",
      };
    const keyMatches = equalBinding(got, baseline);
    const keyComparison = `届いたキー ${bindingLabel(got, os)} は、試した動きのサンプル基準値 ${bindingLabel(baseline, os)} と${keyMatches ? "一致しました" : "異なります"}。`;
    if (recognition && recognition !== selected)
      return {
        title: "別の動きとして認識されました",
        body: `試した動きは${name(selected)}、認識された動きは${name(recognition)}です。${keyComparison}認識とキーの割当は分けて確認します。実機の検証結果ではありません。`,
        verdict: "誤認識",
        tone: "error",
      };
    return keyMatches
      ? {
          title: "割当どおり",
          body: `${keyComparison}実機の検証結果ではありません。`,
          verdict: "一致",
          tone: "success",
        }
      : {
          title: "割当と違うキー",
          body: `${keyComparison}未反映の下書きとは比較しません。実機の検証結果ではありません。`,
          verdict: "キー不一致",
          tone: "error",
        };
  }
  function record(
    got: Binding,
    recognition: Gesture | null,
    unsupportedLabel?: string,
  ) {
    const result = unsupportedLabel
      ? {
          title: "割当編集に未対応のキー",
          body: "この画面で受け取った入力を表示しています。割当デモの対応キーではないため、基準値との判定はしません。",
          verdict: "判定対象外",
          tone: "neutral",
        }
      : classify(got, recognition);
    setLogs((old) =>
      [
        {
          gesture: selected,
          title: result.title,
          body: result.body,
          got,
          recognition,
          n: (old[0]?.n ?? 0) + 1,
          tried: gestureInfo(selected).short,
          recognized: recognition ? name(recognition) : "—（通知未検証）",
          received: unsupportedLabel
            ? [
                ...got.modifiers.map((m) => modifierLabel(m, os)),
                unsupportedLabel,
              ].join(os === "mac" ? "" : " + ")
            : bindingLabel(got, os),
          verdict: result.verdict,
          tone: result.tone,
        },
        ...old,
      ].slice(0, 6),
    );
  }
  const verdict = selectedLog
    ? selectedLog
    : {
        title: "まだ試していません",
        body: "下の受け取り欄を選んで、キーを入力してください。",
        tone: "neutral",
      };
  return (
    <div className="design-test">
      <div className="info-strip">
        <span className="demo-tag">DEMO</span>
        <span>
          「認識された動き」は見本の表示です。本体の認識結果をPCで受け取れるかは、まだ確かめていません。
        </span>
      </div>
      <div className="test-three">
        <div>
          <span>1　試す動き</span>
          <strong>{name(selected)}</strong>
          <small>サンプルの動作を確かめます</small>
        </div>
        <div className="unverified">
          <span>
            2　認識された動き <b className="mini-tag">未検証</b>
          </span>
          <strong>{recognized ? name(recognized) : "—"}</strong>
          <small>本体からの通知で表示する予定の欄</small>
        </div>
        <div>
          <span>3　PCに届いたキー</span>
          <strong className="mono">
            {received ? selectedLog!.received : "—"}
          </strong>
          <small>このウィンドウが受け取ったキー</small>
        </div>
      </div>
      <div className={`test-verdict ${verdict.tone}`} role="status">
        <strong>{verdict.title}</strong>
        <span>{verdict.body}</span>
      </div>
      <label className="test-key-field">
        <span>キーの受け取り欄</span>
        <input
          aria-label="キーの受け取り欄（キー入力テストエリア）"
          readOnly
          value=""
          placeholder="ここを選んだ状態で、キーボードでも試せます（サンプル基準値との比較です）"
          onKeyDown={(e) => {
            if (e.code === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey)
              return;
            if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
              chord.current.press(e.nativeEvent);
              return;
            }
            if (
              e.nativeEvent.isComposing ||
              e.repeat ||
              [
                "Control",
                "Shift",
                "Alt",
                "Meta",
                "Dead",
                "Unidentified",
              ].includes(e.key)
            )
              return;
            e.preventDefault();
            if (supportedCode(e.code)) chord.current.press(e.nativeEvent);
            else {
              chord.current.clear();
              record(
                {
                  codes: [e.code || e.key],
                  modifiers: MODIFIERS.filter(
                    (m) =>
                      ({
                        ctrl: e.ctrlKey,
                        alt: e.altKey,
                        shift: e.shiftKey,
                        gui: e.metaKey,
                      })[m],
                  ),
                },
                null,
                e.key || e.code,
              );
            }
          }}
          onKeyUp={(e) => {
            const b = chord.current.release(e.code);
            if (b) {
              e.preventDefault();
              record(b, null);
            }
          }}
          onBlur={() => chord.current.clear()}
        />
      </label>
      <div className="test-actions">
        <Button
          label="デモ：うまく認識された"
          onClick={() => record(baseline, selected)}
        />
        <Button
          label="デモ：別の動きと認識された"
          onClick={() => record(allBaselines[other], other)}
        />
        <span className="spacer" />
        <Button
          className="undo-button"
          label="記録を消す"
          onClick={() => {
            setLogs([]);
          }}
        />
      </div>
      <div className="test-log-scroll">
        <table className="test-log">
          <thead>
            <tr>
              <th>#</th>
              <th>試した動き</th>
              <th>認識（デモ）</th>
              <th>届いたキー</th>
              <th>判定</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((r) => (
              <tr key={r.n}>
                <td className="mono">{r.n}</td>
                <td>{r.tried}</td>
                <td>{r.recognized}</td>
                <td className="mono">{r.received}</td>
                <td className={r.tone}>{r.verdict}</td>
              </tr>
            ))}
            {!logs.length && (
              <tr>
                <td colSpan={5}>まだ記録はありません。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="test-notes">
        <span>
          ・判定は、サンプル基準値（{bindingLabel(baseline, os)}）と比べます。
          {!equalBinding(baseline, draft) &&
            `変更トレイの下書き（${bindingLabel(draft, os)}）は、まだ反映されていません。`}
        </span>
        <span>
          ・OSにペアリング済みのVANZYのキー入力も届く場合があります。本体の設定を読み取った結果ではないため、不一致でも実機の不具合とは限りません。
        </span>
        <span>
          ・複数キーは押したまま組み合わせ、最初のキーを離した時点で1件として記録します。届いたキーはこのウィンドウだけで受け取ります。ただし
          Alt+Tab や ⌘Tab
          のようなOSのショートカットは、アプリより先にOSが処理します。TabとShift+Tabはフォーカス移動に使います。
        </span>
      </div>
    </div>
  );
}
