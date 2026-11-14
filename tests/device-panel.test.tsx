// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { DevicePanel, type DeviceSnapshot } from "../src/DevicePanel";
const api = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => api);
// This suite isolates device transactions; host lifecycle is covered by native-workspace.
vi.mock("../src/HostPanel", () => ({ default: () => null }));
const raw = (usage: number) => [5, 0, usage, ...Array<number>(12).fill(0)];
const before: DeviceSnapshot = {
  snapshotId: "snapshot-1",
  deviceId: "test-device",
  product: "VANZY-test",
  firmware: "3.2.1",
  capturedAt: "2026-11-10T12:00:00Z",
  backupPath: "C:\\backups\\original.json",
  maps: {
    "1": raw(0x50),
    "2": raw(0x4f),
    "3": raw(0x52),
    "4": raw(0x51),
    ...Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [String(i + 5), raw(4 + i)]),
    ),
  },
  touchInverted: false,
  undo: null,
};
beforeEach(() => {
  api.invoke.mockReset();
  api.isTauri.mockReturnValue(true);
  Object.defineProperty(navigator, "platform", {
    value: "Win32",
    configurable: true,
  });
});
afterEach(cleanup);
it("keeps browser mode read-only and never invokes native operations", () => {
  api.isTauri.mockReturnValue(false);
  render(<DevicePanel />);
  expect(screen.getByText(/実機機能はWindows・macOSネイティブ版/)).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(api.invoke).not.toHaveBeenCalled();
});
it.each([
  { code: "KeyA", target: raw(4) },
  { code: "WindowsOnly", target: [5, 8, 0, ...Array<number>(12).fill(0)] },
])(
  "confirms and restores $code with exact raw readback",
  async ({ code, target }) => {
    const changed = {
      ...before,
      snapshotId: "snapshot-2",
      maps: { ...before.maps, "1": target },
      undo: { index: 1, target: before.maps["1"] },
    };
    api.invoke
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce({ ...before, snapshotId: "snapshot-3" });
    render(<DevicePanel />);
    expect(api.invoke).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "本体から読み取り・バックアップ" }),
    );
    await screen.findByText(before.backupPath);
    expect(
      screen.getByRole("button", { name: "本体への変更を確認" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("変更先のキー"), {
      target: { value: code },
    });
    fireEvent.click(screen.getByRole("button", { name: "本体への変更を確認" }));
    expect(api.invoke).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(api.invoke).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "本体への変更を確認" }));
    fireEvent.click(
      screen.getByRole("button", { name: "この1件を本体へ書き込む" }),
    );
    await screen.findByText("書込み後の読戻しが一致しました。");
    expect(api.invoke).toHaveBeenNthCalledWith(2, "device_apply_map", {
      request: {
        snapshotId: "snapshot-1",
        index: 1,
        expected: before.maps["1"],
        target,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "直前の割当へ戻す" }));
    expect(api.invoke).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "この1件を復元する" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "直前の割当へ戻す" }),
      ).not.toBeInTheDocument(),
    );
    expect(api.invoke).toHaveBeenNthCalledWith(3, "device_restore_previous", {
      snapshotId: "snapshot-2",
    });
  },
);
it("does not retry uncertain writes and requires a fresh read after readback mismatch", async () => {
  api.invoke.mockResolvedValueOnce(before).mockResolvedValueOnce(before);
  render(<DevicePanel />);
  fireEvent.click(
    screen.getByRole("button", { name: "本体から読み取り・バックアップ" }),
  );
  await screen.findByText(before.backupPath);
  fireEvent.change(screen.getByLabelText("変更先のキー"), {
    target: { value: "KeyB" },
  });
  fireEvent.click(screen.getByRole("button", { name: "本体への変更を確認" }));
  fireEvent.click(
    screen.getByRole("button", { name: "この1件を本体へ書き込む" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "読戻しが一致しません",
  );
  expect(screen.queryByLabelText("変更先のキー")).not.toBeInTheDocument();
  expect(api.invoke).toHaveBeenCalledTimes(2);
});
it("blocks repeated reads while pending and rejects malformed snapshots", async () => {
  let resolve!: (value: unknown) => void;
  api.invoke.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<DevicePanel />);
  const button = screen.getByRole("button", {
    name: "本体から読み取り・バックアップ",
  });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.invoke).toHaveBeenCalledTimes(1);
  expect(button).toBeDisabled();
  resolve({ ...before, maps: { ...before.maps, "1": [5] } });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "読取り結果またはバックアップ",
  );
  expect(screen.queryByLabelText("変更先のキー")).not.toBeInTheDocument();
});
