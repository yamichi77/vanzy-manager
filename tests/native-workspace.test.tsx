// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { NativeApp } from "../src/NativeApp";
import type { DeviceSnapshot } from "../src/DevicePanel";
import { firmwareDefaultMap } from "../src/firmware-defaults";
const api = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({
  ...api,
  Channel: class {
    onmessage = (_message: unknown) => {};
  },
}));
const raw = (usage: number) => [5, 0, usage, ...Array<number>(12).fill(0)];
const before: DeviceSnapshot = {
  snapshotId: "native-1",
  deviceId: "device",
  product: "VANZY-test",
  firmware: "3.2.1",
  capturedAt: "2026-11-11T00:00:00Z",
  touchInverted: false,
  backupPath: "C:\\backups\\native.json",
  maps: Object.fromEntries(
    Array.from({ length: 11 }, (_, i) => [
      String(i + 1),
      raw(i === 0 ? 0x50 : i === 1 ? 0x4f : 4 + i),
    ]),
  ),
  undo: null,
};
const stopped = { active: false, phase: "stopped", eventCount: 0 };
const profileKey = "vanzy-host-profile:device:false";
beforeEach(() => {
  api.invoke.mockReset();
  api.isTauri.mockReturnValue(true);
  localStorage.clear();
  Object.defineProperty(navigator, "platform", {
    value: "Win32",
    configurable: true,
  });
  Object.defineProperty(navigator, "userAgent", {
    value: "Windows test",
    configurable: true,
  });
  api.invoke.mockImplementation(async (command) =>
    command === "macro_status" ? { running: false, step: null, error: null } : command === "host_status" ? stopped : command === "host_input_permission" ? false : before,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function read() {
  const button = screen.getAllByRole("button", {
    name: /^(本体を読み取る|読み直す)$/,
  })[0];
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByText("実機から読み取り、バックアップを保存しました。");
}
function headerRead() {
  return screen.getAllByRole("button", { name: "読み直す" })[0];
}
function select(name: string) {
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "ジェスチャー一覧" }),
    ).getByRole("button", { name: new RegExp(`^${name}`) }),
  );
}
function other(value: string) {
  fireEvent.change(screen.getByLabelText("その他のキー"), {
    target: { value },
  });
}
function captureButton() {
  return screen.getByRole("button", { name: /ここをクリックして、割り当てたいキーを押す/ });
}
function chord(...codes: string[]) {
  const capture = captureButton();
  fireEvent.click(capture);
  for (const code of codes)
    fireEvent.keyDown(capture, { key: code.replace("Key", "").toLowerCase(), code });
  fireEvent.keyUp(capture, { key: "x", code: codes[codes.length - 1] });
}
function saveButton() {
  return screen.getByRole("button", { name: "保存…" });
}
function saveBar() {
  return screen.queryByRole("region", { name: "未保存の変更" });
}
function batchCalls() {
  return api.invoke.mock.calls.filter(([command]) => command === "device_apply_batch");
}
function calls(command: string) {
  return api.invoke.mock.calls.filter(([name]) => name === command);
}
function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "そのほかのメニュー" }));
}

it("opens the start screen without samples or automatic device reads", async () => {
  render(<NativeApp />);
  expect(screen.getByRole("button", { name: "本体を読み取る" })).toBeInTheDocument();
  expect(
    screen.queryByRole("navigation", { name: "ジェスチャー一覧" }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(api.invoke).toHaveBeenCalledWith("host_status"));
  expect(api.invoke.mock.calls.every(([command]) => command === "host_status")).toBe(true);
  expect(screen.queryByText("サンプルの初期割り当て")).not.toBeInTheDocument();
});

it("shows all eleven gestures after a verified read", async () => {
  render(<NativeApp />);
  await read();
  expect(
    within(screen.getByRole("navigation", { name: "ジェスチャー一覧" })).getAllByRole(
      "button",
    ),
  ).toHaveLength(11);
  expect(saveBar()).not.toBeInTheDocument();
});

it("keeps per-gesture drafts across selection and never writes during edit or cancel", async () => {
  render(<NativeApp />);
  await read();
  other("KeyA");
  select("右へ");
  other("KeyB");
  select("左へ");
  expect(screen.getByLabelText("その他のキー")).toHaveValue("KeyA");
  expect(saveBar()).toHaveTextContent("未保存の変更 2 件");
  fireEvent.click(saveButton());
  expect(screen.getByRole("dialog", { name: "2件を保存" })).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "戻る" }));
  expect(batchCalls()).toHaveLength(0);
  expect(screen.getByLabelText("その他のキー")).toHaveValue("KeyA");
});

it("sends every device draft once in one batch", async () => {
  api.invoke.mockImplementation(async (command) => {
    if (command === "host_status") return stopped;
    if (command === "device_apply_batch")
      return {
        outcome: "complete",
        items: [
          { index: 1, status: "verified" },
          { index: 2, status: "verified" },
        ],
        snapshot: {
          ...before,
          snapshotId: "native-2",
          maps: { ...before.maps, "1": raw(4), "2": raw(5) },
        },
      };
    return before;
  });
  render(<NativeApp />);
  await read();
  other("KeyA");
  select("右へ");
  other("KeyB");
  select("上へ");
  expect(saveButton()).toBeEnabled();
  fireEvent.click(saveButton());
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByLabelText("本体に書き込む変更")).toHaveTextContent("左へ");
  expect(within(dialog).getByLabelText("本体に書き込む変更")).toHaveTextContent("右へ");
  fireEvent.click(within(dialog).getByRole("button", { name: "2件を保存" }));
  await screen.findByRole("dialog", { name: "2件を保存しました" });
  expect(batchCalls()).toHaveLength(1);
  expect(batchCalls()[0][1]).toEqual({
    request: {
      snapshotId: "native-1",
      restore: false,
      changes: [
        { index: 1, expected: before.maps["1"], target: raw(4) },
        { index: 2, expected: before.maps["2"], target: raw(5) },
      ],
    },
    progress: expect.objectContaining({ onmessage: expect.any(Function) }),
  });
  expect(calls("host_start")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "編集画面へ戻る" }));
  expect(saveBar()).not.toBeInTheDocument();
});

it("reviews every staged firmware default and ordinary draft in one batch", async () => {
  let current: DeviceSnapshot = {
    ...before,
    product: "VANZY#1-0000/A2",
    maps: { ...before.maps, "5": Array<number>(15).fill(0) },
  };
  api.invoke.mockImplementation(async (command, args) => {
    if (command === "host_status") return stopped;
    if (command === "device_apply_batch") {
      current = {
        ...current,
        snapshotId: "default-written",
        maps: {
          ...current.maps,
          ...Object.fromEntries(
            args.request.changes.map((change: { index: number; target: number[] }) => [
              change.index,
              change.target,
            ]),
          ),
        },
      };
      return {
        outcome: "complete",
        items: args.request.changes.map((change: { index: number }) => ({
          index: change.index,
          status: "verified",
        })),
        snapshot: current,
      };
    }
    return current;
  });
  render(<NativeApp />);
  await read();
  other("KeyB");
  select("上へ");
  fireEvent.click(screen.getByRole("button", { name: "標準設定に戻す" }));
  expect(saveBar()).toHaveTextContent("Win + Tab");
  select("左回り");
  fireEvent.click(screen.getByRole("button", { name: "標準設定に戻す" }));
  fireEvent.click(saveButton());
  expect(screen.getByRole("dialog")).toHaveTextContent("未割当");
  expect(screen.getByRole("dialog")).toHaveTextContent("音量を下げる");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "戻る" }));
  expect(batchCalls()).toHaveLength(0);
  fireEvent.click(saveButton());
  fireEvent.click(screen.getByRole("button", { name: "3件を保存" }));
  await screen.findByRole("dialog", { name: "3件を保存しました" });
  expect(batchCalls()).toHaveLength(1);
  expect(batchCalls()[0][1].request).toEqual({
    snapshotId: before.snapshotId,
    restore: false,
    changes: [
      { index: 1, expected: before.maps["1"], target: raw(5) },
      { index: 3, expected: before.maps["3"], target: firmwareDefaultMap(3) },
      { index: 5, expected: Array(15).fill(0), target: firmwareDefaultMap(5) },
    ],
  });
});

it("does not offer firmware defaults for an unverified device model", async () => {
  render(<NativeApp />);
  await read();
  expect(screen.getByRole("button", { name: "標準設定は未確認です" })).toBeDisabled();
});

it("ends local capture when focus, gesture, view or busy state changes", async () => {
  render(<NativeApp />);
  await read();
  const start = () => {
    const button = captureButton();
    fireEvent.click(button);
    return button;
  };
  let capture = start();
  expect(capture).toHaveAttribute("aria-pressed", "true");
  fireEvent.blur(capture);
  expect(capture).toHaveAttribute("aria-pressed", "false");
  capture = start();
  select("右へ");
  expect(capture).toHaveAttribute("aria-pressed", "false");
  start();
  fireEvent.click(screen.getByRole("button", { name: "テスト" }));
  fireEvent.click(screen.getByRole("button", { name: "割り当て" }));
  expect(captureButton()).toHaveAttribute("aria-pressed", "false");
  let finish: (value: unknown) => void = () => {};
  api.invoke.mockImplementation(async (command) =>
    command === "host_status"
      ? stopped
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  capture = start();
  fireEvent.click(headerRead());
  await waitFor(() => expect(capture).toBeDisabled());
  expect(capture).toHaveAttribute("aria-pressed", "false");
  finish(before);
  await screen.findByText("実機から読み取り、バックアップを保存しました。");
  expect(batchCalls()).toHaveLength(0);
});

it("captures only an opted-in local key, and a chord becomes an app binding draft", async () => {
  render(<NativeApp />);
  await read();
  expect(
    within(screen.getByRole("group", { name: "修飾キー" }))
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Ctrl", "Alt", "Shift", "Win"]);
  const capture = captureButton();
  fireEvent.keyDown(capture, { key: "k", code: "KeyK", ctrlKey: true });
  fireEvent.keyUp(capture, { key: "k", code: "KeyK" });
  expect(screen.getByLabelText("その他のキー")).toHaveValue("");
  fireEvent.click(capture);
  fireEvent.keyDown(capture, { key: "K", code: "KeyK", ctrlKey: true, shiftKey: true });
  fireEvent.keyUp(capture, { key: "K", code: "KeyK" });
  expect(screen.getByLabelText("その他のキー")).toHaveValue("KeyK");
  const mods = within(screen.getByRole("group", { name: "修飾キー" }));
  expect(mods.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
  expect(mods.getByRole("button", { name: "Shift" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByText("アプリ経由で動きます")).not.toBeInTheDocument();
  select("右へ");
  chord("KeyA", "KeyB");
  expect(screen.getByText("アプリ経由で動きます")).toBeInTheDocument();
  expect(saveBar()).toHaveTextContent("A + B");
  expect(batchCalls()).toHaveLength(0);
  expect(calls("host_start")).toHaveLength(0);
});

it("cancels local capture on Escape or Tab without changing the draft or sending", async () => {
  render(<NativeApp />);
  await read();
  other("KeyA");
  const capture = captureButton();
  fireEvent.click(capture);
  fireEvent.keyDown(capture, { key: "Escape", code: "Escape" });
  expect(capture).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByLabelText("その他のキー")).toHaveValue("KeyA");
  fireEvent.click(capture);
  expect(fireEvent.keyDown(capture, { key: "Tab", code: "Tab" })).toBe(true);
  expect(capture).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByLabelText("その他のキー")).toHaveValue("KeyA");
  expect(batchCalls()).toHaveLength(0);
});

it("blocks reads and writes while app sending is active", async () => {
  api.invoke.mockResolvedValue({ ...stopped, active: true, phase: "listening" });
  render(<NativeApp />);
  await screen.findByText("アプリ経由の送信中です。停止・復元してから読み取ってください。");
  expect(screen.getByRole("button", { name: "本体を読み取る" })).toBeDisabled();
  expect(api.invoke.mock.calls.every(([command]) => command === "host_status")).toBe(true);
});

it("saves a chord as an app binding without writing the device, and starts only when asked", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<NativeApp />);
  await read();
  select("上へ");
  chord("KeyA", "KeyB");
  fireEvent.click(saveButton());
  const dialog = screen.getByRole("dialog", { name: "1件を保存" });
  expect(within(dialog).getByLabelText("アプリ経由にする変更")).toHaveTextContent("A + B");
  const startAfter = within(dialog).getByRole("checkbox", {
    name: /保存したら、アプリ経由の送信を開始する/,
  });
  expect(startAfter).toBeChecked();
  fireEvent.click(startAfter);
  fireEvent.click(within(dialog).getByRole("button", { name: "1件を保存" }));
  await screen.findByRole("dialog", { name: "1件を保存しました" });
  expect(batchCalls()).toHaveLength(0);
  expect(calls("host_start")).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem(profileKey)!)).toEqual([
    { index: 3, keys: [4, 5], modifiers: 0 },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "編集画面へ戻る" }));
  expect(saveBar()).not.toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: /アプリ経由の送信/ }),
  ).toHaveTextContent("上へ の 1 件は、送信中だけ動きます。");
  fireEvent.click(screen.getByRole("button", { name: "送信を開始" }));
  await waitFor(() => expect(calls("host_start")).toHaveLength(1));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(calls("host_start")[0][1]).toEqual({
    snapshotId: "native-1",
    bindings: [{ index: 3, keys: [4, 5], modifiers: 0 }],
    observeOnly: false,
  });
});

it("writes the device first and starts app sending with the fresh snapshot when checked", async () => {
  let host = stopped;
  api.invoke.mockImplementation(async (command) => {
    if (command === "host_status") return host;
    if (command === "host_start") {
      host = { ...stopped, active: true, phase: "listening" };
      return host;
    }
    if (command === "device_apply_batch")
      return {
        outcome: "complete",
        items: [{ index: 1, status: "verified" }],
        snapshot: {
          ...before,
          snapshotId: "native-2",
          maps: { ...before.maps, "1": raw(4) },
        },
      };
    return before;
  });
  render(<NativeApp />);
  await read();
  other("KeyA");
  select("上へ");
  chord("KeyA", "KeyB");
  fireEvent.click(saveButton());
  fireEvent.click(screen.getByRole("button", { name: "2件を保存" }));
  await screen.findByRole("dialog", { name: "2件を保存しました" });
  const order = api.invoke.mock.calls
    .map(([command]) => command)
    .filter((command) => command === "device_apply_batch" || command === "host_start");
  expect(order).toEqual(["device_apply_batch", "host_start"]);
  expect(calls("host_start")[0][1]).toEqual({
    snapshotId: "native-2",
    bindings: [{ index: 3, keys: [4, 5], modifiers: 0 }],
    observeOnly: false,
  });
  expect(screen.getByRole("dialog")).toHaveTextContent("送信中");
  fireEvent.click(screen.getByRole("button", { name: "編集画面へ戻る" }));
  await screen.findByText("アプリ経由の送信中は、割り当てを変更できません。");
  expect(captureButton()).toBeDisabled();
  expect(headerRead()).toBeDisabled();
});

it("does not start app sending when the device write is not confirmed", async () => {
  api.invoke.mockImplementation(async (command) => {
    if (command === "host_status") return stopped;
    if (command === "device_apply_batch")
      return {
        outcome: "failed",
        items: [{ index: 1, status: "uncertain", error: "読戻しが一致しません" }],
        snapshot: null,
        error: "読戻しが一致しません",
      };
    return before;
  });
  render(<NativeApp />);
  await read();
  other("KeyA");
  select("上へ");
  chord("KeyA", "KeyB");
  fireEvent.click(saveButton());
  fireEvent.click(screen.getByRole("button", { name: "2件を保存" }));
  await screen.findByRole("dialog", { name: "保存結果を確認できませんでした" });
  expect(calls("host_start")).toHaveLength(0);
  expect(screen.getByRole("dialog")).toHaveTextContent("開始していません");
});

it("never starts app sending automatically after a read", async () => {
  localStorage.setItem(profileKey, JSON.stringify([{ index: 3, keys: [4, 5], modifiers: 0 }]));
  render(<NativeApp />);
  await read();
  // The stored profile is loaded for the device identity right after the verified read.
  await waitFor(() =>
    expect(
      within(screen.getByRole("navigation", { name: "ジェスチャー一覧" })).getByRole("button", {
        name: /^上へ/,
      }),
    ).toHaveTextContent("A + B"),
  );
  expect(screen.getByRole("button", { name: "送信を開始" })).toBeEnabled();
  expect(calls("host_start")).toHaveLength(0);
});

it("excludes device reads while app sending start is pending", async () => {
  localStorage.setItem(profileKey, JSON.stringify([{ index: 3, keys: [4, 5], modifiers: 0 }]));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  let finish!: () => void;
  api.invoke.mockImplementation(async (command) => {
    if (command === "host_status") return stopped;
    if (command === "host_start")
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    return before;
  });
  render(<NativeApp />);
  await read();
  await waitFor(() => expect(screen.getByRole("button", { name: "送信を開始" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "送信を開始" }));
  await waitFor(() => expect(calls("host_start")).toHaveLength(1));
  expect(headerRead()).toBeDisabled();
  fireEvent.click(headerRead());
  expect(calls("device_read_snapshot")).toHaveLength(1);
  finish();
  await waitFor(() => expect(headerRead()).toBeEnabled());
});

it("excludes recovery while device reading is pending", async () => {
  let finish!: (value: DeviceSnapshot) => void;
  api.invoke.mockImplementation(async (command) =>
    command === "host_status"
      ? stopped
      : new Promise<DeviceSnapshot>((resolve) => {
          finish = resolve;
        }),
  );
  render(<NativeApp />);
  const button = screen.getByRole("button", { name: "本体を読み取る" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  openMenu();
  expect(screen.getByRole("button", { name: "中断した送信を復旧…" })).toBeDisabled();
  finish(before);
  await screen.findByText("実機から読み取り、バックアップを保存しました。");
});

it("fails closed when the recovery outcome cannot be confirmed by a status refresh", async () => {
  let recovered = false,
    statusRecovered = false;
  vi.spyOn(window, "confirm").mockReturnValue(true);
  api.invoke.mockImplementation(async (command) => {
    if (command === "host_recover") {
      recovered = true;
      return;
    }
    if (command === "host_status") {
      if (recovered && !statusRecovered) throw new Error("status unavailable");
      return stopped;
    }
    return before;
  });
  render(<NativeApp />);
  await read();
  openMenu();
  fireEvent.click(screen.getByRole("button", { name: "中断した送信を復旧…" }));
  await screen.findByText(/status unavailable/);
  expect(headerRead()).toBeDisabled();
  statusRecovered = true;
  fireEvent.click(screen.getByRole("button", { name: "状態を再確認" }));
  await waitFor(() => expect(headerRead()).toBeEnabled());
});

it("clears all drafts when the device or touch inversion identity changes", async () => {
  let changed = false;
  api.invoke.mockImplementation(async (command) =>
    command === "host_status"
      ? stopped
      : changed
        ? { ...before, snapshotId: "inverted", touchInverted: true }
        : before,
  );
  render(<NativeApp />);
  await read();
  other("KeyA");
  select("右へ");
  other("KeyB");
  changed = true;
  await read();
  await waitFor(() => expect(saveBar()).not.toBeInTheDocument());
  expect(screen.getByLabelText("その他のキー")).toHaveValue("");
  select("左へ");
  expect(screen.getByLabelText("その他のキー")).toHaveValue("");
});

it("retains drafts after a failed reread but blocks their use until a verified snapshot", async () => {
  let fail = false;
  api.invoke.mockImplementation(async (command) => {
    if (command === "host_status") return stopped;
    if (fail) throw new Error("read unavailable");
    return before;
  });
  render(<NativeApp />);
  await read();
  other("KeyA");
  fail = true;
  fireEvent.click(headerRead());
  await screen.findByRole("alert");
  expect(screen.getByLabelText("その他のキー")).toHaveValue("KeyA");
  expect(screen.getByLabelText("その他のキー")).toBeDisabled();
  expect(saveButton()).toBeDisabled();
});

it("groups before and after values and highlights only the primary action", async () => {
  render(<NativeApp />);
  await read();
  other("KeyA");
  fireEvent.click(saveButton());
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByLabelText("変更前: ←")).toBeInTheDocument();
  expect(within(dialog).getByLabelText("変更後: A")).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "1件を保存" })).toHaveClass(
    "nx-btn-primary",
  );
  expect(within(dialog).getByRole("button", { name: "戻る" })).not.toHaveClass(
    "nx-btn-primary",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "戻る" }));
  expect(batchCalls()).toHaveLength(0);
});

it("keeps the dialog through real pending and success states without duplicate writes", async () => {
  let finish!: (value: unknown) => void;
  api.invoke.mockImplementation(async (command) => {
    if (command === "host_status") return stopped;
    if (command === "device_apply_batch")
      return new Promise<unknown>((resolve) => {
        finish = resolve;
      });
    return before;
  });
  render(<NativeApp />);
  await read();
  other("KeyA");
  fireEvent.click(saveButton());
  const dialog = screen.getByRole("dialog", { name: "1件を保存" });
  const send = within(dialog).getByRole("button", { name: "1件を保存" });
  fireEvent.click(send);
  fireEvent.click(send);
  await screen.findByRole("dialog", { name: "保存しています" });
  expect(dialog).toHaveAttribute("open");
  expect(within(dialog).getByRole("button", { name: "閉じる" })).toBeDisabled();
  fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
  expect(dialog).toHaveAttribute("open");
  expect(screen.getByRole("button", { name: "残りを中止" })).toBeEnabled();
  expect(batchCalls()).toHaveLength(1);
  finish({
    outcome: "complete",
    items: [{ index: 1, status: "verified" }],
    snapshot: {
      ...before,
      snapshotId: "native-success",
      maps: { ...before.maps, "1": raw(4) },
      backupPath: "C:\\backups\\actual-before-write.json",
    },
    backupPath: "C:\\backups\\actual-before-write.json",
  });
  await screen.findByRole("dialog", { name: "1件を保存しました" });
  expect(dialog).toHaveTextContent("読み戻し一致");
  expect(dialog).toHaveTextContent("C:\\backups\\actual-before-write.json");
  fireEvent.click(within(dialog).getByRole("button", { name: "動きを試す" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "テスト" })).toHaveAttribute("aria-current", "page");
});

it("cancels the review on Escape with drafts intact and no native command", async () => {
  render(<NativeApp />);
  await read();
  other("KeyB");
  fireEvent.click(saveButton());
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("その他のキー")).toHaveValue("KeyB");
  expect(batchCalls()).toHaveLength(0);
});

it("keeps an uncertain failure visible without false backup success, retry, or draft loss", async () => {
  api.invoke.mockImplementation(async (command) => {
    if (command === "host_status") return stopped;
    if (command === "device_apply_batch")
      throw new Error("Readback mismatch; setting write outcome uncertain");
    return before;
  });
  render(<NativeApp />);
  await read();
  other("KeyA");
  fireEvent.click(saveButton());
  fireEvent.click(screen.getByRole("button", { name: "1件を保存" }));
  const dialog = await screen.findByRole("dialog", { name: "保存結果を確認できませんでした" });
  expect(dialog).toHaveTextContent("すでに書き込まれている可能性");
  expect(dialog).toHaveTextContent("結果未確認");
  expect(dialog).not.toHaveTextContent("変更前のバックアップ");
  expect(
    within(dialog).queryByRole("button", { name: /再試行|もう一度|復元/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "編集画面へ戻る" }));
  expect(screen.getByLabelText("その他のキー")).toHaveValue("KeyA");
  expect(saveButton()).toBeDisabled();
  expect(batchCalls()).toHaveLength(1);
  await read();
  expect(screen.getByLabelText("その他のキー")).toHaveValue("KeyA");
  expect(saveButton()).toBeEnabled();
});

it("shows actual per-item progress, then retains only unresolved drafts until reread", async () => {
  let finish!: (value: unknown) => void;
  let progress!: { onmessage: (value: unknown) => void };
  let current = before;
  api.invoke.mockImplementation(async (command, args) => {
    if (command === "host_status") return stopped;
    if (command === "device_apply_batch") {
      progress = args.progress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return current;
  });
  render(<NativeApp />);
  await read();
  other("KeyA");
  select("右へ");
  other("KeyB");
  select("上へ");
  other("KeyZ");
  fireEvent.click(saveButton());
  fireEvent.click(screen.getByRole("button", { name: "3件を保存" }));
  await waitFor(() => expect(progress).toBeDefined());
  act(() =>
    progress.onmessage({
      index: 1,
      status: "verified",
      completed: 1,
      total: 3,
      backupPath: "C:\\backups\\batch.json",
    }),
  );
  const running = screen.getByRole("dialog", { name: "保存しています" });
  const rows = within(running).getByLabelText("保存の進行状況");
  expect(within(rows).getAllByText("読み戻し一致")).toHaveLength(1);
  act(() => progress.onmessage({ index: 2, status: "running", completed: 1, total: 3 }));
  expect(within(rows).getAllByText("読み戻し一致")).toHaveLength(1);
  finish({
    outcome: "failed",
    items: [
      { index: 1, status: "verified" },
      { index: 2, status: "uncertain", error: "Readback mismatch" },
      { index: 3, status: "pending" },
    ],
    snapshot: null,
    backupPath: "C:\\backups\\batch.json",
    error: "Readback mismatch",
  });
  await screen.findByRole("dialog", { name: "保存結果を確認できませんでした" });
  fireEvent.click(screen.getByRole("button", { name: "編集画面へ戻る" }));
  expect(saveButton()).toBeDisabled();
  expect(screen.getByLabelText("その他のキー")).toHaveValue("KeyZ");
  select("右へ");
  expect(screen.getByLabelText("その他のキー")).toHaveValue("KeyB");
  select("左へ");
  expect(screen.getByLabelText("その他のキー")).toHaveValue("");
  expect(batchCalls()).toHaveLength(1);
  // A reread shows the uncertain second write did reach the device.
  current = {
    ...before,
    snapshotId: "reread",
    maps: { ...before.maps, "1": raw(4), "2": raw(5) },
  };
  await read();
  expect(saveBar()).toHaveTextContent("未保存の変更 1 件");
  fireEvent.click(saveButton());
  expect(screen.getByRole("button", { name: "1件を保存" })).toBeEnabled();
  expect(within(screen.getByRole("dialog")).getByLabelText("本体に書き込む変更")).toHaveTextContent(
    "上へ",
  );
});

it("requests cancellation once and waits for the current item before showing stopped", async () => {
  let finish!: (value: unknown) => void;
  let progress!: { onmessage: (value: unknown) => void };
  api.invoke.mockImplementation(async (command, args) => {
    if (command === "host_status") return stopped;
    if (command === "device_cancel_batch") return true;
    if (command === "device_apply_batch") {
      progress = args.progress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return before;
  });
  render(<NativeApp />);
  await read();
  other("KeyA");
  select("右へ");
  other("KeyB");
  fireEvent.click(saveButton());
  fireEvent.click(screen.getByRole("button", { name: "2件を保存" }));
  await waitFor(() => expect(progress).toBeDefined());
  act(() => progress.onmessage({ index: 1, status: "verified", completed: 1, total: 2 }));
  const cancel = screen.getByRole("button", { name: "残りを中止" });
  fireEvent.click(cancel);
  fireEvent.click(cancel);
  await waitFor(() => expect(calls("device_cancel_batch")).toHaveLength(1));
  expect(screen.getByRole("button", { name: "中止を待っています…" })).toBeDisabled();
  expect(screen.getByRole("dialog", { name: "保存しています" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "閉じる" })).toBeDisabled();
  finish({
    outcome: "stopped",
    items: [
      { index: 1, status: "verified" },
      { index: 2, status: "pending" },
    ],
    snapshot: null,
  });
  await screen.findByRole("dialog", { name: "残りの保存を中止しました" });
  fireEvent.click(screen.getByRole("button", { name: "編集画面へ戻る" }));
  expect(screen.getByLabelText("その他のキー")).toHaveValue("KeyB");
  expect(saveButton()).toBeDisabled();
  select("左へ");
  expect(screen.getByLabelText("その他のキー")).toHaveValue("");
  expect(batchCalls()).toHaveLength(1);
});

it("restores all previous batch targets while preserving unrelated drafts", async () => {
  const undo = {
    index: 1,
    target: before.maps["1"],
    entries: [
      { index: 1, target: before.maps["1"] },
      { index: 2, target: before.maps["2"] },
    ],
  };
  const written = {
    ...before,
    snapshotId: "written",
    maps: { ...before.maps, "1": raw(4), "2": raw(5) },
    undo,
  };
  api.invoke.mockImplementation(async (command) => {
    if (command === "host_status") return stopped;
    if (command === "device_apply_batch")
      return {
        outcome: "complete",
        items: [
          { index: 1, status: "verified" },
          { index: 2, status: "verified" },
        ],
        snapshot: { ...before, snapshotId: "restored" },
      };
    return written;
  });
  render(<NativeApp />);
  await read();
  select("上へ");
  other("KeyZ");
  openMenu();
  fireEvent.click(screen.getByRole("button", { name: "直前の保存を元に戻す…" }));
  expect(screen.getByRole("dialog", { name: "直前の保存を元に戻す" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "2件を元に戻す" }));
  await screen.findByRole("dialog", { name: "直前の保存を元に戻しました" });
  expect(batchCalls()).toHaveLength(1);
  expect(batchCalls()[0][1].request).toEqual({
    snapshotId: "written",
    restore: true,
    changes: [
      { index: 1, expected: raw(4), target: before.maps["1"] },
      { index: 2, expected: raw(5), target: before.maps["2"] },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "動きを試す" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "割り当て" }));
  select("上へ");
  expect(screen.getByLabelText("その他のキー")).toHaveValue("KeyZ");
  expect(saveBar()).toHaveTextContent("未保存の変更 1 件");
});

it("uses calibrated physical names, shortened, instead of the default gesture names", async () => {
  localStorage.setItem(
    "vanzy-physical-labels:device:false",
    JSON.stringify({ "1": "上", "10": "○印側へスワイプ", "11": "○印と反対側へスワイプ" }),
  );
  render(<NativeApp />);
  await read();
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "上へ", level: 1 })).toBeInTheDocument(),
  );
  expect(screen.queryByText("左へ")).not.toBeInTheDocument();
  const list = within(screen.getByRole("navigation", { name: "ジェスチャー一覧" }));
  expect(list.getByText("○側へスワイプ")).toBeInTheDocument();
  expect(list.getByText("反対側へスワイプ")).toBeInTheDocument();
  expect(list.queryByText("○印と反対側へスワイプ")).not.toBeInTheDocument();
});

it("records local test chords, matches the device key, and clears history on gesture change", async () => {
  render(<NativeApp />);
  await read();
  fireEvent.click(screen.getByRole("button", { name: "テスト" }));
  const input = screen.getByLabelText("実動作テストの入力欄");
  fireEvent.keyDown(input, { key: "ArrowLeft", code: "ArrowLeft" });
  fireEvent.keyUp(input, { key: "ArrowLeft", code: "ArrowLeft" });
  const region = screen.getByRole("region", { name: "実動作テスト" });
  expect(region).toHaveTextContent("割り当てと一致");
  fireEvent.keyDown(input, { key: "a", code: "KeyA", ctrlKey: true });
  fireEvent.keyUp(input, { key: "a", code: "KeyA" });
  expect(region).toHaveTextContent("Ctrl + A");
  expect(region).toHaveTextContent("割り当てと違うキーです");
  expect(fireEvent.keyDown(input, { key: "Tab", code: "Tab" })).toBe(true);
  select("右へ");
  expect(screen.getByRole("region", { name: "実動作テスト" })).not.toHaveTextContent("Ctrl + A");
  expect(batchCalls()).toHaveLength(0);
});


it("Mac native workspace enables read without automatic device access or writes", async () => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  Object.defineProperty(navigator, "userAgent", { value: "Macintosh test", configurable: true });
  render(<NativeApp />);
  const button = screen.getAllByRole("button", { name: "本体を読み取る" })[0];
  await waitFor(() => expect(button).toBeEnabled());
  expect(screen.getByText(/macOS・実機検証前/)).toBeInTheDocument();
  expect(screen.queryByText(/Bluetoothとキー送信用アクセシビリティ/)).not.toBeInTheDocument();
  expect(calls("device_read_snapshot")).toHaveLength(0);
  expect(calls("host_start")).toHaveLength(0);
  expect(batchCalls()).toHaveLength(0);
  await read();
  expect(calls("device_read_snapshot")).toHaveLength(1);
  expect(screen.getByText(/キー送信は未許可です/)).toBeInTheDocument();
  expect(batchCalls()).toHaveLength(0);
  expect(calls("host_start")).toHaveLength(0);
});


it("Mac checks permission on Read, continues when denied, and only sends after explicit allowed start", async () => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let granted = false;
  vi.spyOn(window, "confirm").mockReturnValue(true);
  localStorage.setItem(profileKey, JSON.stringify([{ index: 1, keys: [4, 5], modifiers: 0 }]));
  api.invoke.mockImplementation(async (command) => command === "macro_status" ? { running: false, step: null, error: null } : command === "host_status" ? stopped : command === "host_input_permission" ? granted : before);
  render(<NativeApp />);
  await waitFor(() => expect(api.invoke).toHaveBeenCalledWith("host_status"));
  expect(calls("host_input_permission")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "キー送信の許可をリクエスト" })).not.toBeInTheDocument();
  await read();
  expect(calls("host_input_permission")).toEqual([["host_input_permission", { request: false }], ["host_input_permission", { request: true }]]);
  expect(calls("device_read_snapshot")).toHaveLength(1);
  expect(calls("host_start")).toHaveLength(0);
  const start = screen.getByRole("button", { name: "送信を開始" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  expect(calls("host_start")).toHaveLength(0);
  fireEvent.click(await screen.findByRole("button", { name: "確認して実行" }));
  await waitFor(() => expect(calls("host_input_permission")).toHaveLength(3));
  await waitFor(() => expect(start).toBeEnabled());
  expect(calls("host_start")).toHaveLength(0);
  expect(batchCalls()).toHaveLength(0);
  granted = true;
  fireEvent.focus(window);
  expect(calls("host_start")).toHaveLength(0);
  fireEvent.click(start);
  expect(calls("host_start")).toHaveLength(0);
  fireEvent.click(await screen.findByRole("button", { name: "確認して実行" }));
  await waitFor(() => expect(calls("host_start")).toHaveLength(1));
  expect(calls("host_input_permission").filter(([, args]) => args.request)).toHaveLength(1);
});

it("Mac read proceeds when the Accessibility check errors", async () => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  api.invoke.mockImplementation(async (command) => {
    if (command === "host_input_permission") throw new Error("permission unavailable");
    return command === "host_status" ? stopped : before;
  });
  render(<NativeApp />);
  await read();
  expect(calls("device_read_snapshot")).toHaveLength(1);
  expect(calls("host_start")).toHaveLength(0);
  expect(screen.getByText(/キー送信の許可を確認できません/)).toBeInTheDocument();
});

it("Windows never invokes Mac permission checks, including Read", async () => {
  render(<NativeApp />);
  await read();
  expect(calls("host_input_permission")).toHaveLength(0);
});


it("explicitly focuses capture and test buttons on click for macOS WebView", async () => {
  render(<NativeApp />);
  await read();
  const capture = captureButton();
  fireEvent.click(capture);
  expect(capture).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: /^テスト$/ }));
  const test = screen.getByRole("button", { name: "実動作テストの入力欄" });
  fireEvent.click(test);
  expect(test).toHaveFocus();
  expect(api.invoke.mock.calls.some(([command]) => command === "host_start")).toBe(false);
});

it("keeps stopped-session mode and receive count visible for diagnosis", async () => {
  api.invoke.mockImplementation(async (command) => command === "host_status"
    ? { ...stopped, eventCount: 3, runtimeMode: 1, restored: true }
    : command === "host_input_permission" ? false : before);
  render(<NativeApp />);
  await read();
  expect(screen.getByText(/受信 3 回/)).toHaveTextContent("最終確認モード: 1");
  expect(screen.getByText(/受信 3 回/)).toHaveTextContent("本体設定の復元確認済み");
  expect(calls("host_start")).toHaveLength(0);
});


it("Mac confirmation cancellation never starts or writes, without window.confirm", async () => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  localStorage.setItem(profileKey, JSON.stringify([{ index: 1, keys: [4, 5], modifiers: 0 }]));
  render(<NativeApp />);
  await read();
  const start = screen.getByRole("button", { name: "送信を開始" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  const confirmation = await screen.findByRole("dialog", { name: "操作の確認" });
  expect(confirmation).toHaveTextContent("1件の動きを一時的に通知用");
  expect(calls("host_start")).toHaveLength(0);
  fireEvent.click(within(confirmation).getByRole("button", { name: "キャンセル" }));
  expect(screen.queryByRole("dialog", { name: "操作の確認" })).not.toBeInTheDocument();
  expect(calls("host_start")).toHaveLength(0);
  expect(batchCalls()).toHaveLength(0);
  expect(nativeConfirm).not.toHaveBeenCalled();
});

it("keeps macro editing local and preserves the existing chord profile", async () => {
  const original = [{ index: 1, keys: [4, 5], modifiers: 0 }];
  localStorage.setItem(profileKey, JSON.stringify(original));
  render(<NativeApp />);
  await read();
  fireEvent.click(screen.getByRole("button", { name: /^マクロ$/ }));
  expect(screen.queryByLabelText("その他のキー")).not.toBeInTheDocument();
  expect(localStorage.getItem(profileKey)).toBe(JSON.stringify(original));
  expect(batchCalls()).toHaveLength(0);
  expect(calls("host_start")).toHaveLength(0);
});

it("shows a saved macro badge and restores original key behavior when disabled locally", async () => {
  const original = [{ index: 1, keys: [4, 5], modifiers: 0 }];
  localStorage.setItem(profileKey, JSON.stringify(original));
  const macroKey = "vanzy-host-macros:v1:device:false";
  localStorage.setItem(macroKey, JSON.stringify([{ index: 1, macro: { version: 1, steps: [{ type: "wait", ms: 100 }] } }]));
  render(<NativeApp />);
  await read();
  expect(await screen.findByText("マクロ 1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^キー送信$/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "マクロを解除（このPCのみ）" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "マクロを解除（このPCのみ）" }));
  expect(localStorage.getItem(macroKey)).toBe("[]");
  expect(localStorage.getItem(profileKey)).toBe(JSON.stringify(original));
  expect(batchCalls()).toHaveLength(0);
  expect(calls("host_start")).toHaveLength(0);
});

it("appends a macro key using the same capture controls and saves only the macro profile", async () => {
  const original = [{ index: 1, keys: [4,5], modifiers: 0 }];
  localStorage.setItem(profileKey, JSON.stringify(original));
  render(<NativeApp />);
  await read();
  fireEvent.click(screen.getByRole("button", { name: /^マクロ$/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "＋キー送信" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "＋キー送信" }));
  chord("KeyA", "KeyB");
  expect(screen.getByRole("group", { name: "修飾キー" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "よく使うキー" })).toBeInTheDocument();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "PC内に保存" }));
  expect(JSON.parse(localStorage.getItem("vanzy-host-macros:v1:device:false")!)[0].macro.steps[0]).toEqual({ type: "key", keys: [4,5], modifiers: 0 });
  expect(localStorage.getItem(profileKey)).toBe(JSON.stringify(original));
  expect(batchCalls()).toHaveLength(0);
  expect(calls("host_start")).toHaveLength(0);
});
