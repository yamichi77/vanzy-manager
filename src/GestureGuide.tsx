import { gestureInfo } from "./domain";
import type { Gesture } from "./domain";

const GUIDE = {
  left: {
    name: "左ジェスチャー",
    posture: "手を開き、親指を上に向ける",
    movement: "手を左へ押すように動かす",
  },
  right: {
    name: "右ジェスチャー",
    posture: "手のひらを下に向け、人差し指を伸ばす",
    movement: "手を右へ押すように動かす",
  },
} as const;

/** Independently drawn, static schematics, not traced manufacturer artwork. */
function HandDiagram({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      className="gesture-guide-art"
      viewBox="0 0 260 180"
      aria-hidden="true"
      focusable="false"
      data-gesture={direction}
    >
      <g
        fill="var(--gesture-hand)"
        stroke="var(--gesture-line)"
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        data-pose={
          direction === "left"
            ? "open-hand-thumb-up"
            : "palm-down-index-forward"
        }
      >
        {direction === "left" ? (
          <>
            <path d="M228 117 L193 117 Q179 117 166 108 L143 91 L142 52 Q142 39 132 39 Q121 39 121 52 L121 82 L67 77 Q56 76 55 85 Q54 94 65 95 L104 99 L51 100 Q40 100 40 109 Q40 118 51 118 L103 117 L56 125 Q45 127 47 136 Q49 144 60 142 L112 132 L76 145 Q66 149 70 157 Q73 163 83 160 L132 143 Q150 138 172 140 L228 147 Z" />
            <path
              d="M121 82 Q132 88 143 91 M112 111 Q124 112 132 120"
              fill="none"
              opacity=".6"
            />
            <path
              d="M100 81 L98 98 L111 100 L114 82 Z"
              fill="var(--gesture-band)"
            />
            <rect
              x="91"
              y="78"
              width="34"
              height="13"
              rx="5"
              fill="var(--gesture-device)"
            />
            <path
              d="M99 83 H117"
              stroke="var(--gesture-surface)"
              strokeWidth="3"
            />
          </>
        ) : (
          <>
            <path d="M165 160 L162 141 Q176 126 175 111 L172 83 Q171 73 163 73 Q156 73 154 83 L151 102 L149 72 Q148 62 140 63 Q132 64 132 73 L132 98 L127 61 Q126 51 118 52 Q111 53 111 64 L112 98 L102 30 Q100 18 90 20 Q81 22 83 34 L91 113 L74 100 Q65 93 59 101 Q54 108 62 116 L96 146 L98 160 Z" />
            <path
              d="M91 113 Q104 115 111 128 M132 98 L132 113 M151 102 L150 116"
              fill="none"
              opacity=".6"
            />
            <path
              d="M88 77 L108 74 L112 91 L90 95 Z"
              fill="var(--gesture-band)"
            />
            <rect
              x="81"
              y="77"
              width="40"
              height="15"
              rx="5"
              fill="var(--gesture-device)"
            />
            <path
              d="M89 83 H112"
              stroke="var(--gesture-surface)"
              strokeWidth="3"
            />
          </>
        )}
      </g>
      <g
        stroke="var(--accent)"
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        data-movement={direction}
        aria-hidden="true"
      >
        {direction === "left" ? (
          <path d="M90 39 H39 M51 27 L39 39 L51 51" />
        ) : (
          <path d="M183 42 H231 M219 30 L231 42 L219 54" />
        )}
      </g>
    </svg>
  );
}

function DeviceDiagram() {
  return (
    <svg
      className="gesture-device-art"
      viewBox="0 0 280 150"
      role="img"
      aria-label="人差し指のバンドと、その上の横長のタッチパネルを区別した独自模式図。形状・寸法は簡略化しています。"
    >
      <title>横長のタッチパネルと人差し指のバンド（独自模式図）</title>
      <g stroke="var(--gesture-line)" strokeWidth="2" strokeLinejoin="round">
        <path
          d="M24 84 H218 Q246 84 246 102 Q246 120 218 120 H24"
          fill="var(--gesture-hand)"
        />
        <path
          d="M104 80 V126 H130 V80"
          fill="var(--gesture-band)"
          data-device-part="band"
        />
        <rect
          x="84"
          y="69"
          width="67"
          height="24"
          rx="9"
          fill="var(--gesture-device)"
          data-device-part="touch-panel"
        />
        <path
          d="M96 79 H139"
          stroke="var(--gesture-surface)"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <path
          d="M117 65 V43 H171 M132 125 L164 138 H186"
          fill="none"
          stroke="var(--muted)"
          strokeWidth="1.5"
        />
      </g>
      <g fill="var(--text2)" fontSize="15" fontFamily="inherit">
        <text x="156" y="32">
          横長のタッチ面
        </text>
        <text x="191" y="142">
          バンド
        </text>
        <text x="29" y="105">
          人差し指
        </text>
      </g>
    </svg>
  );
}

export function GestureGuide({ direction }: { direction: Gesture }) {
  if (direction !== "left" && direction !== "right") {
    const info = gestureInfo(direction);
    const touch = info.group === "touch";
    return (
      <figure className="gesture-guide" aria-label={info.name + "の説明"}>
        <div className="gesture-guide-visual">
          <span className="gesture-catalog-symbol" aria-hidden="true">
            {info.symbol}
          </span>
          <span className="gesture-guide-tag">
            一覧用の記号・操作図ではありません
          </span>
        </div>
        <figcaption>
          <strong>
            {info.name} · {touch ? "タッチ操作" : "空中ジェスチャー"}
          </strong>
          <p>
            Androidアプリの解析で確認された項目です。キー割当をデモ内で編集できます。
          </p>
          <small>
            {touch
              ? "タッチ命令と物理操作・実機IDの対応は未確定です。左右の基準や触り方は実機確認前のため図示していません。"
              : "手の姿勢・向きの基準・認識の条件は実機未検証です。推測の動作図は表示していません。"}
          </small>
          <span className="gesture-guide-credit">
            本体の設定は未読取りです。この割当を実機へ送信することはできません。
          </span>
        </figcaption>
      </figure>
    );
  }
  const guide = GUIDE[direction];
  return (
    <figure className="gesture-guide" aria-label={guide.name + "の操作ガイド"}>
      <div className="gesture-guide-visual">
        <HandDiagram direction={direction} />
        <span className="gesture-view-label">
          {direction === "left" ? "横から見た模式図" : "上から見た模式図"}
        </span>
      </div>
      <figcaption>
        <strong>{guide.posture}</strong>
        <p>{guide.movement}</p>
        <details className="gesture-device-reference">
          <summary>本体の形と装着位置</summary>
          <DeviceDiagram />
        </details>
      </figcaption>
    </figure>
  );
}
