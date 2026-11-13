import { useRef, useState } from "react";
import { Bluetooth, Check, X, Unplug } from "lucide-react";
import { Button } from "@astryxdesign/core";
type StateProps = {
  pendingCount: number;
  safe: boolean;
  onSample: () => void;
  onDiscard: () => void;
  onApply: () => void;
  onBackups: () => void;
  onNotice: (s: string) => void;
};
export function DesignStates(p: StateProps) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const discardTrigger = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const finishDiscard = () => {
    setConfirmDiscard(false);
    requestAnimationFrame(() => {
      const trigger = discardTrigger.current?.querySelector("button");
      if (trigger && !trigger.disabled) trigger.focus();
      else heading.current?.focus();
    });
  };
  return (
    <main className="design-states">
      <div className="states-title">
        <h1 ref={heading} tabIndex={-1}>
          うまくいかないときの画面
        </h1>
        <p>
          どの状態でも「いま何が起きているか」「本体は今どうなっているか」「次に何ができるか」の3つを出します。
        </p>
        <div className="info-strip">
          <span className="demo-tag">DEMO</span>
          すべて表示サンプルです。実際の接続・読取り・書込みは行いません。
        </div>
      </div>
      <div className="state-grid">
        <section>
          <span className="state-tag dashed">
            <i aria-hidden="true" />
            未接続
          </span>
          <Bluetooth size={48} className="state-device-icon" />
          <h3>VANZYが見つかりません</h3>
          <p>
            OSのBluetooth設定で、VANZYがペアリングされているか確かめてから、もう一度探してください。
          </p>
          <small>
            サンプルで画面を見ることもできます。サンプルの値は点線で表示され、反映はできません。
          </small>
          <div className="state-actions">
            <Button
              className="state-primary"
              label="もう一度探す（未実装）"
              isDisabled
            />
            <Button label="サンプルで見る" onClick={p.onSample} />
          </div>
        </section>
        <section>
          <span className="state-tag success reading-tag">
            <i aria-hidden="true" />
            読み取り中
          </span>
          <h3>設定を読み取っています</h3>
          <ol className="read-progress">
            <li>
              <Check />
              接続
            </li>
            <li>
              <Check />
              ファームウェアの確認 <small>FW [見本]</small>
            </li>
            <li className="success active-read">
              <span className="spinner" />
              設定の読み取り <small>2 / [項目数]</small>
            </li>
            <li className="read-wait">
              <span className="wait-circle" />
              バックアップ
            </li>
          </ol>
          <small>
            読み取りが終わるまで編集はできません。読み取った値は、終わったらまとめて表示します。
          </small>
          <div className="state-actions">
            <Button label="キャンセル" onClick={p.onSample} />
          </div>
        </section>
        <section className="warning-border">
          <span className="state-tag warning">対応表にないFW</span>
          <h3>このファームウェアは、まだ対応表にありません</h3>
          <p>
            FW [見本]
            の設定項目は確かめられていないので、読み取り専用で開きます。本体への書き込みはしません。
          </p>
          <div className="state-detail">対応表にあるFW：[未検証]</div>
          <div className="state-actions">
            <Button label="読み取り専用で開く（未実装）" isDisabled />
            <Button label="診断ログを保存（未実装）" isDisabled />
          </div>
        </section>
        <section className="error-border">
          <span className="state-tag error">読み取り失敗</span>
          <h3>設定を読み取れませんでした</h3>
          <p>
            設定用のサービスから応答がない場合の表示例です。本体の設定は何も変えていません。
          </p>
          <div>
            <small>考えられること</small>
            <p>
              ・ほかのアプリ（公式アプリなど）がVANZYに接続している
              <br />
              ・PCから離れていて、電波が届きにくい
            </p>
          </div>
          <div className="state-actions">
            <Button
              className="state-primary"
              label="もう一度読み取る（未実装）"
              isDisabled
            />
            <Button label="診断ログを保存（未実装）" isDisabled />
          </div>
        </section>
        <section className="error-border">
          <span className="state-tag error disconnected-tag">
            <Unplug size={13} />
            切断
          </span>
          <h3>接続が切れました</h3>
          <p>
            {p.pendingCount > 0
              ? `編集中の変更（${p.pendingCount}件）は、このアプリの中にそのまま残っています。本体にはまだ書き込んでいません。`
              : "編集中の変更はありません。本体には何も書き込んでいません。"}
          </p>
          <small>
            再接続すると本体の値を読み直して、変更トレイを作り直します。そのあいだに本体の値が変わっていたら、その項目をお知らせする予定です。
          </small>
          <div className="state-actions">
            <Button
              className="state-primary"
              label="再接続する（未実装）"
              isDisabled
            />
            <div ref={discardTrigger}>
              <Button
                label="変更を捨てる"
                isDisabled={!p.safe || !p.pendingCount || confirmDiscard}
                onClick={() => setConfirmDiscard(true)}
              />
            </div>
          </div>
          {confirmDiscard && (
            <div
              className="state-discard-confirm"
              role="group"
              aria-labelledby="discard-confirm-title"
            >
              <strong id="discard-confirm-title">
                編集中の下書き{p.pendingCount}件を捨てますか？
              </strong>
              <p>
                この操作は表示例ではなく、現在のサンプルの下書きを取り消します。
              </p>
              <div className="state-actions">
                <button
                  type="button"
                  className="astryx-button"
                  autoFocus
                  onClick={finishDiscard}
                >
                  変更を残す
                </button>
                <Button
                  label="下書きを捨てる"
                  isDisabled={!p.safe || !p.pendingCount}
                  onClick={() => {
                    if (!p.safe || !p.pendingCount) return;
                    p.onDiscard();
                    p.onNotice("サンプルの下書きを取り消しました。");
                    finishDiscard();
                  }}
                />
              </div>
            </div>
          )}
        </section>
        <section className="warning-border">
          <span className="state-tag warning">
            <span className="mono">1/2</span>　一部だけ反映
          </span>
          <h3>1件だけ反映されたとき</h3>
          <div className="partial-example">
            <div>
              <Check size={16} />
              <strong>左ジェスチャー</strong>
              <span className="success">反映済み</span>
            </div>
            <div>
              <X size={16} className="error" />
              <strong>右ジェスチャー</strong>
              <span className="error">変更前のまま</span>
            </div>
          </div>
          <small>
            これは表示例です。実際のサンプル差分は反映プレビューで確認できます。実機通信は行っていません。
          </small>
          <div className="state-actions">
            <Button
              className="state-primary"
              label="反映プレビューへ"
              onClick={p.onApply}
              isDisabled={!p.safe || !p.pendingCount}
            />
            <Button
              label="バックアップから戻す"
              onClick={p.onBackups}
              isDisabled={!p.safe}
            />
            <Button label="このまま" onClick={p.onSample} />
          </div>
        </section>
      </div>
    </main>
  );
}
