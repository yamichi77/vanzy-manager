// @vitest-environment jsdom
// Representative user journeys for the UI-only demo. No physical-device claims.
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App";
import { DesignTest, type TestLogRow } from "../src/DesignTest";
import { BASELINE, GESTURE_CATALOG } from "../src/domain";
const api = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));
vi.mock("@tauri-apps/api/core", () => api);
beforeEach(() => api.invoke.mockReset());
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  expect(api.invoke).not.toHaveBeenCalled();
});
async function setupApp() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("ブラウザプレビュー", { exact: true });
  return user;
}
it("opens all eleven APK-derived gestures for demo editing and keeps hardware disabled", async () => {
  const user = await setupApp();
  expect(screen.getByText("これはサンプルです")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "確認して反映する" }),
  ).toBeDisabled();
  expect(screen.getByText("未検証・無効")).toBeVisible();
  expect(
    within(screen.getByRole("navigation")).getAllByRole("button"),
  ).toHaveLength(11);
  for (const item of GESTURE_CATALOG) {
    await user.click(
      within(screen.getByRole("navigation")).getByRole("button", {
        name: new RegExp("^" + item.name),
      }),
    );
    expect(screen.getByRole("heading", { name: item.name })).toBeVisible();
    expect(screen.getByRole("button", { name: /キーを記録/ })).toBeEnabled();
    if (!["left", "right"].includes(item.id)) {
      expect(
        document.querySelector(".assigned-value .keycaps"),
      ).toHaveTextContent("デモ未割当");
      await user.click(screen.getByRole("button", { name: "キー Enter" }));
      expect(
        document.querySelector(".assigned-value .keycaps"),
      ).toHaveTextContent("Enter");
    }
  }
  expect(document.querySelectorAll(".change-item")).toHaveLength(10);
  expect(
    screen.getByText(/タッチ命令と物理操作・実機IDの対応は未確定/),
  ).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "変更をすべて取り消す" }),
  );
  expect(document.querySelector(".assigned-value .keycaps")).toHaveTextContent(
    "デモ未割当",
  );
});
it("records keys only after opt-in and can cancel or undo the draft", async () => {
  const user = await setupApp();
  await user.keyboard("q");
  expect(screen.getByRole("button", { name: "キー PgDn" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await user.click(screen.getByRole("button", { name: /キーを記録/ }));
  await user.keyboard("{Control>}k{/Control}");
  expect(
    screen.getByText("下書きに記録しました。実機には送信していません。"),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: /キーを記録/ }));
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: /キーを記録/ })).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "変更をすべて取り消す" }),
  );
  expect(screen.getByRole("button", { name: "キー →" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    screen.getByRole("button", { name: "反映フローをプレビュー" }),
  ).toBeDisabled();
});
it("changes display preferences without losing the draft", async () => {
  const user = await setupApp();
  await user.click(screen.getByRole("button", { name: "Windows" }));
  await user.click(screen.getByRole("radio", { name: "macOS" }));
  expect(screen.getByRole("button", { name: "⌘ Command" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await user.click(screen.getByRole("radio", { name: "ライト" }));
  expect(document.documentElement).toHaveAttribute("data-theme", "light");
  await user.click(
    within(screen.getByRole("radiogroup", { name: "テーマ" })).getByRole(
      "radio",
      { name: "自動" },
    ),
  );
  expect(document.documentElement).not.toHaveAttribute("data-theme");
  expect(screen.getByRole("button", { name: "キー PgDn" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
it("compares test input with the baseline, separates verdicts, and clears history", async () => {
  const user = await setupApp();
  await user.click(screen.getByRole("tab", { name: "テスト" }));
  const input = screen.getByRole("textbox", { name: /キー入力テストエリア/ });
  await user.click(input);
  await user.keyboard("{PageDown}");
  expect(
    screen.getByText(
      /届いたキー PgDn は、試した動きのサンプル基準値 → と異なります/,
    ),
  ).toBeVisible();
  expect(screen.getByText(/変更トレイの下書き（PgDn）/)).toBeVisible();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "デモ：うまく認識された" }),
  ).toHaveFocus();
  await user.click(
    screen.getByRole("button", { name: "デモ：うまく認識された" }),
  );
  expect(screen.getByText("割当どおり")).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "デモ：別の動きと認識された" }),
  );
  expect(screen.getByText("別の動きとして認識されました")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "記録を消す" }));
  expect(screen.getByText("まだ記録はありません。")).toBeVisible();
});
it("restores both draft entries after partial failure and opens apply confirmation without auto-applying", async () => {
  render(<App />);
  await screen.findByText("ブラウザプレビュー", { exact: true });
  fireEvent.click(
    within(screen.getByRole("navigation")).getByRole("button", {
      name: /左ジェスチャー/,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "キー PgUp" }));
  fireEvent.click(
    screen.getByRole("button", { name: "反映フローをプレビュー" }),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "途中失敗を再現する" }));
  vi.useFakeTimers();
  fireEvent.click(
    screen.getByRole("button", { name: "2件を反映する（デモ）" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5500);
  });
  fireEvent.click(screen.getByRole("button", { name: "バックアップから戻す" }));
  const comparison = screen.getByRole("region", {
    name: "バックアップの内容と比較",
  });
  expect(within(comparison).getByText("PgDn")).toBeVisible();
  expect(within(comparison).getByText("PgUp")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "2件を下書きに戻す" }));
  expect(
    screen.getByRole("group", { name: "下書き全体の復元確認" }),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "下書きを保存して復元へ進む" }),
  );
  expect(
    screen.getByRole("dialog", { name: "反映する前に（デモ）" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "1件を反映する（デモ）" }),
  ).toBeEnabled();
  expect(
    within(screen.getByRole("dialog")).queryByText("PgDn"),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
  expect(document.querySelectorAll(".change-item")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "バックアップ" }));
  fireEvent.click(
    screen.getByRole("button", { name: /復元前の下書き（退避）/ }),
  );
  expect(
    within(
      screen.getByRole("region", { name: "バックアップの内容と比較" }),
    ).getByText("PgDn"),
  ).toBeVisible();
  expect(api.invoke).not.toHaveBeenCalled();
});

it("cancels discarding a draft from the state preview", async () => {
  const user = await setupApp();
  await user.click(
    screen.getByRole("button", { name: "空・エラー状態をプレビュー" }),
  );
  await user.click(screen.getByRole("button", { name: "変更を捨てる" }));
  await user.click(screen.getByRole("button", { name: "変更を残す" }));
  await user.click(screen.getByRole("button", { name: "メイン画面に戻る" }));
  expect(screen.getByRole("button", { name: "キー PgDn" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
function SameKeyTestHarness() {
  const [logs, setLogs] = useState<TestLogRow[]>([]);
  return (
    <DesignTest
      selected="left"
      logs={logs}
      setLogs={setLogs}
      allBaselines={{ ...BASELINE, left: BASELINE.left, right: BASELINE.left }}
      baseline={BASELINE.left}
      draft={BASELINE.left}
      os="windows"
    />
  );
}
// Retain this specific observed bug, rather than a matrix of presentation variants.
it("distinguishes wrong recognition even when both gestures share the same key", () => {
  render(<SameKeyTestHarness />);
  fireEvent.click(
    screen.getByRole("button", { name: "デモ：別の動きと認識された" }),
  );
  const status = document.querySelector(".test-verdict[role=status]")!;
  expect(status).toHaveTextContent("別の動きとして認識されました");
  expect(status).toHaveTextContent(
    "試した動きは左ジェスチャー、認識された動きは右ジェスチャー",
  );
  expect(status).toHaveTextContent(
    "届いたキー ← は、試した動きのサンプル基準値 ← と一致しました",
  );
  expect(status).not.toHaveTextContent("割当と違うキー");
  const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
  expect(cells.map((cell) => cell.textContent)).toEqual([
    "1",
    "左",
    "右ジェスチャー",
    "←",
    "誤認識",
  ]);
});

it("adds and removes ordinary keys, records a chord once, and cancels interrupted capture", async () => {
  const user = await setupApp();
  await user.selectOptions(
    screen.getByLabelText("組み合わせるキーを追加"),
    "KeyA",
  );
  await user.click(screen.getByRole("button", { name: "キーを追加" }));
  expect(
    screen.getByRole("button", { name: "A を組合せから外す" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "PgDn を組合せから外す" }),
  ).toBeEnabled();
  await user.click(
    screen.getByRole("button", { name: "PgDn を組合せから外す" }),
  );
  expect(
    screen.getByRole("button", { name: "A を組合せから外す" }),
  ).toBeDisabled();
  await user.click(screen.getByRole("button", { name: /キーを記録/ }));
  await user.keyboard("{Control>}[KeyB>][KeyA>]{Shift>}");
  expect(screen.getByText(/記録中：Ctrl \+ Shift \+ A \+ B/)).toBeVisible();
  await user.keyboard("[/KeyA][/KeyB]{/Shift}{/Control}");
  expect(document.querySelector(".assigned-value .keycaps")).toHaveTextContent(
    "CtrlShiftAB",
  );
  await user.click(screen.getByRole("radio", { name: "macOS" }));
  expect(document.querySelector(".assigned-value .keycaps")).toHaveTextContent(
    "⌃⇧AB",
  );
  await user.click(screen.getByRole("button", { name: /キーを記録/ }));
  await user.keyboard("[KeyX>]{Escape}[/KeyX]");
  expect(document.querySelector(".assigned-value .keycaps")).toHaveTextContent(
    "⌃⇧AB",
  );
  await user.click(screen.getByRole("button", { name: /キーを記録/ }));
  fireEvent.keyDown(window, { key: "q", code: "KeyQ" });
  fireEvent.blur(window);
  fireEvent.keyUp(window, { key: "q", code: "KeyQ" });
  expect(document.querySelector(".assigned-value .keycaps")).toHaveTextContent(
    "⌃⇧AB",
  );
  await user.click(
    screen.getByRole("button", { name: "変更をすべて取り消す" }),
  );
  expect(document.querySelector(".assigned-value .keycaps")).toHaveTextContent(
    "→",
  );
});
function ChordTestHarness() {
  const [logs, setLogs] = useState<TestLogRow[]>([]);
  const binding = { codes: ["KeyA", "KeyB"], modifiers: [] };
  return (
    <DesignTest
      selected="left"
      logs={logs}
      setLogs={setLogs}
      allBaselines={{ ...BASELINE, left: binding, right: BASELINE.right }}
      baseline={binding}
      draft={binding}
      os="windows"
    />
  );
}
it("tests simultaneous keys as one order-independent chord and resets on blur", async () => {
  const user = userEvent.setup();
  render(<ChordTestHarness />);
  const input = screen.getByRole("textbox", { name: /キー入力テストエリア/ });
  await user.click(input);
  await user.keyboard("[KeyB>][KeyA>]");
  expect(screen.getByText("まだ記録はありません。")).toBeVisible();
  await user.keyboard("[/KeyA][/KeyB]");
  expect(screen.getByText("割当どおり")).toBeVisible();
  expect(screen.getAllByRole("row")).toHaveLength(2);
  await user.keyboard("[KeyA>]");
  fireEvent.blur(input);
  await user.keyboard("[/KeyA]");
  expect(screen.getAllByRole("row")).toHaveLength(2);
});
