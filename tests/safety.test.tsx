// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { App } from "../src/App";
const api = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => api);
const safe = {
  hardware_enabled: false,
  demo_only: true,
  platform: "windows",
  protocol_status: "unverified",
  supported_operations: [],
};
beforeEach(() => {
  api.invoke.mockReset().mockResolvedValue(safe);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("all-route safety stop", () => {
  it.each([
    ["invoke failure", "reject"],
    ["hardware enabled", { ...safe, hardware_enabled: true }],
  ])("blocks all mutation routes for %s", async (_label, result) => {
    if (result === "reject") api.invoke.mockRejectedValue(new Error("failed"));
    else api.invoke.mockResolvedValue(result);
    render(<App />);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "バックアップ" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "反映フローをプレビュー" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "キー PgUp" })).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "空・エラー状態をプレビュー" }),
    );
    for (const name of [
      "反映プレビューへ",
      "バックアップから戻す",
      "変更を捨てる",
    ])
      expect(screen.getByRole("button", { name })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "反映プレビューへ" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.invoke).toHaveBeenCalledTimes(1);
    expect(api.invoke).toHaveBeenCalledWith("get_runtime_capabilities");
  });
  it("times out a pending native capability request and ignores late success", async () => {
    vi.useFakeTimers();
    let resolve!: (v: unknown) => void;
    api.invoke.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    render(<App />);
    expect(screen.getByRole("button", { name: "バックアップ" })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(screen.getByRole("alert")).toBeVisible();
    await act(async () => {
      resolve(safe);
    });
    expect(screen.getByRole("button", { name: "バックアップ" })).toBeDisabled();
  });
});
