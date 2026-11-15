import { KeyBindingEditor } from "./KeyBindingEditor";
import { macroKeyDraft, updateMacroKey } from "./macro-key-adapter";
import { isMacHost } from "./native-platform";
import {
  MAX_MACRO_STEPS,
  moveMacroStep,
  newMacroStep,
  validateMacro,
  type MacroDefinition,
  type MacroStep,
} from "./macro-model";
import "./macro-editor.css";

export type MacroEditorProps = {
  value: MacroDefinition;
  onChange: (value: MacroDefinition) => void;
  onSave: () => void | Promise<unknown>;
  onTest: () => void | Promise<unknown>;
  onStop: () => void | Promise<unknown>;
  disabled?: boolean;
  running?: boolean;
  supported?: boolean;
  status?: string;
  dirty?: boolean;
};
const names: Record<MacroStep["type"], string> = {
  key: "キー送信",
  wait: "待機",
  openApp: "アプリを開く",
  openUrl: "URLを開く",
};
export function MacroEditor({
  value,
  onChange,
  onSave,
  onTest,
  onStop,
  disabled = false,
  running = false,
  supported = true,
  status = "",
  dirty = true,
}: MacroEditorProps) {
  const error = validateMacro(value);
  const locked = disabled || running;
  const mac = isMacHost();
  const replace = (index: number, step: MacroStep) =>
    onChange({
      ...value,
      steps: value.steps.map((s, i) => (i === index ? step : s)),
    });
  const add = (type: MacroStep["type"]) =>
    onChange({ ...value, steps: [...value.steps, newMacroStep(type)] });
  const waits = value.steps.reduce(
    (sum, step) => sum + (step.type === "wait" ? step.ms : 0),
    0,
  );
  return (
    <section className="nx-macro" aria-label="マクロの編集">
      <div className="nx-macro-heading">
        <h2 className="nx-eyebrow">マクロ · {value.steps.length}手順</h2>
        <span className="nx-meta">PC内だけに保存</span>
      </div>
      <p className="nx-meta">
        1回のジェスチャーで上から順に1回実行します。実行中の追加操作は捨て、失敗時は再試行せず停止します。本体の書き込み対象には入りません。
      </p>
      <p className="nx-meta">
        アプリが最前面になっても、画面や入力欄の準備完了は保証されません。必要な待機時間は手順で設定できます。
      </p>
      {!supported && (
        <p className="nx-alert" role="status">
          この環境のマクロ実行は未対応です。編集とPC内保存のみ利用できます。
        </p>
      )}
      <ol className="nx-macro-steps">
        {value.steps.map((step, index) => (
          <li className="nx-macro-step" key={index}>
            <fieldset disabled={locked}>
              <legend>
                手順{index + 1} · {names[step.type]}
              </legend>
              <div className="nx-macro-step-actions">
                <label>
                  種類
                  <select
                    aria-label={`手順${index + 1}の種類`}
                    value={step.type}
                    onChange={(e) =>
                      replace(
                        index,
                        newMacroStep(e.target.value as MacroStep["type"]),
                      )
                    }
                  >
                    {Object.entries(names).map(([type, label]) => (
                      <option value={type} key={type}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="nx-btn nx-btn-sm"
                  aria-label={`手順${index + 1}を上へ`}
                  disabled={index === 0}
                  onClick={() =>
                    onChange(moveMacroStep(value, index, index - 1))
                  }
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="nx-btn nx-btn-sm"
                  aria-label={`手順${index + 1}を下へ`}
                  disabled={index === value.steps.length - 1}
                  onClick={() =>
                    onChange(moveMacroStep(value, index, index + 1))
                  }
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="nx-btn nx-btn-sm"
                  aria-label={`手順${index + 1}を複製`}
                  disabled={value.steps.length >= MAX_MACRO_STEPS}
                  onClick={() =>
                    onChange({
                      ...value,
                      steps: [
                        ...value.steps.slice(0, index + 1),
                        structuredClone(step),
                        ...value.steps.slice(index + 1),
                      ],
                    })
                  }
                >
                  複製
                </button>
                <button
                  type="button"
                  className="nx-btn nx-btn-sm"
                  aria-label={`手順${index + 1}を削除`}
                  onClick={() =>
                    onChange({
                      ...value,
                      steps: value.steps.filter((_, i) => i !== index),
                    })
                  }
                >
                  削除
                </button>
              </div>
              {step.type === "key" && (
                <>
                  <KeyBindingEditor
                    value={macroKeyDraft(step)}
                    onChange={(draft) =>
                      replace(index, updateMacroKey(step, draft))
                    }
                    editable={!locked}
                    resetKey={`${index}:${JSON.stringify(step)}`}
                    showValue
                    captureMessage="記録しました。PC内に保存するとこのマクロへ反映されます。"
                    description="同時押しもそのまま記録できます。この手順のキーはPC内だけに保存します。"
                  />
                  <label className="nx-macro-condition">
                    <input
                      type="checkbox"
                      checked={step.targetApp !== undefined}
                      onChange={(e) => {
                        if (e.target.checked)
                          replace(index, { ...step, targetApp: "" });
                        else {
                          const { targetApp: _targetApp, ...ordinary } = step;
                          replace(index, ordinary);
                        }
                      }}
                    />
                    特定のアプリが最前面のときだけ送信
                  </label>
                  {step.targetApp !== undefined && (
                    <label>
                      送信条件のアプリ識別子
                      <input
                        type="text"
                        aria-label={`手順${index + 1}の送信条件アプリ`}
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={255}
                        value={step.targetApp}
                        onChange={(e) =>
                          replace(index, { ...step, targetApp: e.target.value })
                        }
                      />
                      <small className="nx-meta">
                        キー送信の直前に確認し、一致しなければ停止します。未設定なら通常どおり送信します。
                      </small>
                    </label>
                  )}
                  <small className="nx-meta">
                    1個ならタップ、複数なら同時押し。次の手順へ進む前にキーを離します。
                  </small>
                </>
              )}
              {step.type === "wait" && (
                <label>
                  待機時間（ms）
                  <input
                    type="number"
                    aria-label={`手順${index + 1}の待機時間`}
                    min={0}
                    max={10000}
                    step={1}
                    value={step.ms}
                    onChange={(e) =>
                      replace(index, { ...step, ms: e.target.valueAsNumber })
                    }
                  />
                </label>
              )}
              {(step.type === "openApp" || step.type === "openUrl") && (
                <>
                  <label>
                    {mac ? "対象アプリのバンドルID" : "対象アプリの識別子"}
                    <input
                      type="text"
                      aria-label={`手順${index + 1}の対象アプリ`}
                      autoComplete="off"
                      spellCheck={false}
                      value={step.app}
                      maxLength={255}
                      onChange={(e) =>
                        replace(index, { ...step, app: e.target.value })
                      }
                    />
                  </label>
                  {step.type === "openUrl" && (
                    <label>
                      URL
                      <input
                        type="text"
                        aria-label={`手順${index + 1}のURL`}
                        autoComplete="off"
                        spellCheck={false}
                        value={step.url}
                        maxLength={4096}
                        onChange={(e) =>
                          replace(index, { ...step, url: e.target.value })
                        }
                      />
                    </label>
                  )}
                  <label>
                    最前面になるまでの待機上限（ms）
                    <input
                      type="number"
                      aria-label={`手順${index + 1}の起動待機上限`}
                      min={100}
                      max={10000}
                      step={100}
                      value={step.timeoutMs}
                      onChange={(e) =>
                        replace(index, {
                          ...step,
                          timeoutMs: e.target.valueAsNumber,
                        })
                      }
                    />
                  </label>
                </>
              )}
            </fieldset>
          </li>
        ))}
      </ol>
      <div className="nx-macro-add" aria-label="手順を追加">
        {Object.entries(names).map(([type, label]) => (
          <button
            type="button"
            className="nx-btn nx-btn-sm"
            disabled={locked || value.steps.length >= MAX_MACRO_STEPS}
            key={type}
            onClick={() => add(type as MacroStep["type"])}
          >
            ＋{label}
          </button>
        ))}
      </div>
      <p className="nx-meta">
        待機合計: {Number.isFinite(waits) ? waits : "—"}ms / 10000ms ·
        最大32手順
      </p>
      {error && (
        <p className="nx-alert" role="alert">
          {error}
        </p>
      )}
      <p className="nx-meta">
        「試す」でキーを送るには、その前に「アプリを開く」または「URLを開く」で対象を指定してください。実際に対象アプリを操作するため、入力先を確認してください。
      </p>
      <div className="nx-macro-footer">
        <button
          type="button"
          className="nx-btn nx-btn-primary"
          disabled={locked || !!error || !dirty}
          onClick={() => void onSave()}
        >
          PC内に保存
        </button>
        <button
          type="button"
          className="nx-btn"
          disabled={locked || !!error || !supported}
          onClick={() => void onTest()}
        >
          試す
        </button>
        <button
          type="button"
          className="nx-btn"
          disabled={!running}
          onClick={() => void onStop()}
        >
          マクロを停止
        </button>
      </div>
      {status && (
        <p className="nx-meta" role="status">
          {status}
        </p>
      )}
    </section>
  );
}
