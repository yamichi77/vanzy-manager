// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import {
  DesignApply,
  DesignBackups,
  parseDemoBackup,
} from "../src/DesignDialogs";
import { App } from "../src/App";
import {
  BASELINE,
  GESTURES,
  GESTURE_CATALOG,
  makeBackup,
  changes,
  restoreBindings,
} from "../src/domain";
import type { Bindings } from "../src/domain";
const api = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));
vi.mock("@tauri-apps/api/core", () => api);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  expect(api.invoke).not.toHaveBeenCalled();
});
const allAssigned = (): Bindings =>
  Object.fromEntries(
    GESTURES.map((id, i) => [
      id,
      { codes: ["F" + (i + 1), "KeyA"], modifiers: ["ctrl"] },
    ]),
  ) as Bindings;
const legacyBackup = () =>
  parseDemoBackup(
    JSON.stringify({
      source: "demo",
      firmware: "demo-v1",
      name: "旧版の左右",
      createdAt: "2026-11-09T00:00:00Z",
      bindings: {
        left: { code: "KeyL", modifiers: [] },
        right: { codes: ["KeyR"], modifiers: [] },
      },
    }),
  );
it("uses eleven distinct UI IDs in the APK-derived air and touch groups", () => {
  expect(GESTURES).toHaveLength(11);
  expect(new Set(GESTURES).size).toBe(11);
  expect(GESTURE_CATALOG.filter((g) => g.group === "air")).toHaveLength(7);
  expect(GESTURE_CATALOG.filter((g) => g.group === "touch")).toHaveLength(4);
  expect(GESTURES.slice(2).every((id) => BASELINE[id].codes.length === 0)).toBe(
    true,
  );
});
it("round-trips eleven assignments and explicit unassigned slots without aliasing", () => {
  const bindings = allAssigned();
  bindings["touch-left"] = { codes: [], modifiers: [] };
  const backup = makeBackup(bindings);
  const imported = parseDemoBackup(JSON.stringify(backup));
  expect(imported.schemaVersion).toBe(2);
  expect(imported.bindings).toEqual(bindings);
  imported.bindings.up.codes.push("KeyZ");
  expect(backup.bindings.up).not.toEqual(imported.bindings.up);
  expect(
    parseDemoBackup(JSON.stringify(makeBackup(BASELINE))).bindings,
  ).toEqual(BASELINE);
});
it("preserves nine additional assignments when restoring and re-exporting a legacy backup", () => {
  const current = allAssigned();
  const old = legacyBackup();
  for (const backup of [old, parseDemoBackup(JSON.stringify(old))]) {
    const restored = restoreBindings(current, backup);
    expect(restored.left.codes).toEqual(["KeyL"]);
    expect(restored.right.codes).toEqual(["KeyR"]);
    for (const id of GESTURES.slice(2))
      expect(restored[id]).toEqual(current[id]);
    expect(changes(current, restored).map((c) => c.gesture)).toEqual([
      "left",
      "right",
    ]);
  }
});
it("rejects incomplete catalogs, future versions, unknown fields and modifier-only data", () => {
  const full = makeBackup(BASELINE);
  const missing = { ...full.bindings };
  delete (missing as Partial<Bindings>).up;
  for (const input of [
    { ...full, bindings: missing },
    { ...full, schemaVersion: 3 },
    {
      ...full,
      bindings: { ...full.bindings, unexpected: { codes: [], modifiers: [] } },
    },
    {
      ...full,
      bindings: { ...full.bindings, up: { codes: [], modifiers: ["ctrl"] } },
    },
    { ...full, legacyLeftRightOnly: "yes" },
  ]) {
    expect(() => parseDemoBackup(JSON.stringify(input))).toThrow();
  }
});
it("applies all eleven slots and backs up their original empty demo values", async () => {
  vi.useFakeTimers();
  const onApplyResult = vi.fn(),
    onBackupCreated = vi.fn();
  const draft = allAssigned();
  render(
    <Theme theme={neutralTheme} mode="dark">
      <DesignApply
        baseline={BASELINE}
        draft={draft}
        os="windows"
        onApplyResult={onApplyResult}
        onBackupCreated={onBackupCreated}
        onRestart={vi.fn()}
        onOpenBackups={vi.fn()}
        onClose={vi.fn()}
      />
    </Theme>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "11件を反映する（デモ）" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(onApplyResult).toHaveBeenCalledExactlyOnceWith({
    baseline: draft,
    applied: GESTURES,
    failed: null,
    stopped: false,
  });
  expect(onBackupCreated).toHaveBeenCalledWith(
    expect.objectContaining({ schemaVersion: 2, bindings: BASELINE }),
  );
});
it("restores a legacy backup through confirmation without clearing new drafts", () => {
  const draft = allAssigned(),
    backup = legacyBackup(),
    onRestoreDraft = vi.fn(),
    onAddBackup = vi.fn();
  render(
    <Theme theme={neutralTheme} mode="dark">
      <DesignBackups
        baseline={BASELINE}
        draft={draft}
        backups={[backup]}
        os="windows"
        onRestoreDraft={onRestoreDraft}
        onAddBackup={onAddBackup}
        onClose={vi.fn()}
      />
    </Theme>,
  );
  expect(screen.getByText(/追加の9項目は現在の下書きを保ちます/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "2件を下書きに戻す" }));
  expect(onRestoreDraft).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "下書きを保存して復元へ進む" }),
  );
  expect(onAddBackup).toHaveBeenCalledWith(
    expect.objectContaining({ schemaVersion: 2, bindings: draft }),
  );
  expect(onRestoreDraft).toHaveBeenCalledExactlyOnceWith(
    restoreBindings(draft, backup),
    backup,
  );
});
it("shows unassigned inputs as ungraded and isolates each gesture's latest result", async () => {
  render(<App />);
  await screen.findByText("ブラウザプレビュー", { exact: true });
  fireEvent.click(screen.getByRole("tab", { name: "テスト" }));
  fireEvent.click(
    screen.getByRole("button", { name: "デモ：うまく認識された" }),
  );
  expect(screen.getByText("割当どおり")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: /^上ジェスチャー/ }),
  );
  expect(screen.getByText("まだ試していません")).toBeVisible();
  const input = screen.getByRole("textbox", { name: /キー入力テストエリア/ });
  fireEvent.keyDown(input, { key: "x", code: "KeyX" });
  fireEvent.keyUp(input, { key: "x", code: "KeyX" });
  expect(screen.getByText("デモ未割当のため判定できません")).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "割当" }));
  fireEvent.click(screen.getByRole("button", { name: "キー Enter" }));
  fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
  fireEvent.click(screen.getByRole("button", { name: "デモの割当を空にする" }));
  expect(document.querySelector(".assigned-value .keycaps")).toHaveTextContent(
    "デモ未割当",
  );
  expect(screen.getByRole("button", { name: "Ctrl" })).toBeDisabled();
});
it("marks later slots unexecuted after failure and retries only remaining changes", async () => {
  vi.useFakeTimers();
  const onApplyResult = vi.fn(),
    onBackupCreated = vi.fn();
  const draft = allAssigned();
  render(
    <Theme theme={neutralTheme} mode="dark">
      <DesignApply
        baseline={BASELINE}
        draft={draft}
        os="windows"
        onApplyResult={onApplyResult}
        onBackupCreated={onBackupCreated}
        onRestart={vi.fn()}
        onOpenBackups={vi.fn()}
        onClose={vi.fn()}
      />
    </Theme>,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "途中失敗を再現する" }));
  fireEvent.click(
    screen.getByRole("button", { name: "11件を反映する（デモ）" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(onApplyResult).toHaveBeenCalledExactlyOnceWith({
    baseline: { ...BASELINE, left: draft.left },
    applied: ["left"],
    failed: "right",
    stopped: true,
  });
  expect(screen.queryByText("待機中")).not.toBeInTheDocument();
  expect(screen.getAllByText("停止したため未実行")).toHaveLength(9);
  for (const row of document.querySelectorAll(".vz-progress-row.status-skip"))
    expect(row).toHaveTextContent("デモ未割当");
  fireEvent.click(
    screen.getByRole("button", { name: "反映されていない10件をもう一度" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(onApplyResult).toHaveBeenLastCalledWith({
    baseline: draft,
    applied: GESTURES,
    failed: null,
    stopped: false,
  });
  expect(onBackupCreated).toHaveBeenCalledTimes(1);
});
