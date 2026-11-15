// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MacroEditor } from "../src/MacroEditor";
import { type MacroDefinition } from "../src/macro-model";
afterEach(cleanup);
const value: MacroDefinition = {
  version: 1,
  steps: [
    { type: "key", keys: [4], modifiers: 0 },
    { type: "wait", ms: 100 },
  ],
};
it("offers local-only save and edits, reorder, duplicate and delete without device IPC", () => {
  const onChange = vi.fn(),
    onSave = vi.fn();
  render(
    <MacroEditor
      value={value}
      onChange={onChange}
      onSave={onSave}
      onTest={() => {}}
      onStop={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "PC内に保存" }));
  expect(onSave).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "手順1を下へ" }));
  expect(onChange.mock.lastCall?.[0].steps[0].type).toBe("wait");
  fireEvent.click(screen.getByRole("button", { name: "手順1を複製" }));
  expect(onChange.mock.lastCall?.[0].steps).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "手順1を削除" }));
  expect(onChange.mock.lastCall?.[0].steps).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("手順2の待機時間"), {
    target: { value: "350" },
  });
  expect(onChange.mock.lastCall?.[0].steps[1].ms).toBe(350);
});
it("disables real testing on unsupported platform and locks edits during execution", () => {
  const p = {
    value,
    onChange: vi.fn(),
    onSave: vi.fn(),
    onTest: vi.fn(),
    onStop: vi.fn(),
  };
  const { rerender } = render(<MacroEditor {...p} supported={false} />);
  expect(screen.getByRole("button", { name: "試す" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "PC内に保存" })).toBeEnabled();
  rerender(<MacroEditor {...p} running />);
  expect(screen.getByRole("button", { name: "PC内に保存" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "マクロを停止" })).toBeEnabled();
});
it("keeps target condition optional and removes it entirely when unchecked", () => {
  const onChange = vi.fn();
  const props = {
    value,
    onChange,
    onSave: vi.fn(),
    onTest: vi.fn(),
    onStop: vi.fn(),
  };
  const { rerender } = render(<MacroEditor {...props} />);
  const toggle = screen.getByRole("checkbox", {
    name: "特定のアプリが最前面のときだけ送信",
  });
  expect(toggle).not.toBeChecked();
  expect(screen.queryByLabelText("手順1の送信条件アプリ")).toBeNull();
  fireEvent.click(toggle);
  expect(onChange.mock.lastCall?.[0].steps[0].targetApp).toBe("");
  const conditioned: MacroDefinition = {
    version: 1,
    steps: [
      { type: "key", keys: [4], modifiers: 0, targetApp: "org.vendor.App" },
    ],
  };
  rerender(<MacroEditor {...props} value={conditioned} />);
  expect(screen.getByLabelText("手順1の送信条件アプリ")).toHaveValue(
    "org.vendor.App",
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "特定のアプリが最前面のときだけ送信",
    }),
  );
  expect(onChange.mock.lastCall?.[0].steps[0]).not.toHaveProperty("targetApp");
});
it("uses the shared capture UI to append and edit a macro chord while preserving target", () => {
  const onChange = vi.fn();
  render(<MacroEditor value={{ version: 1, steps: [{ type: "key", keys: [4], modifiers: 0, targetApp: "org.test.App" }] }} onChange={onChange} onSave={() => {}} onTest={() => {}} onStop={() => {}} />);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  const capture = screen.getByRole("button", { name: /ここをクリックして、割り当てたいキーを押す/ });
  fireEvent.click(capture);
  fireEvent.keyDown(capture, { key: "a", code: "KeyA" });
  fireEvent.keyDown(capture, { key: "b", code: "KeyB" });
  fireEvent.keyUp(capture, { key: "b", code: "KeyB" });
  expect(onChange.mock.lastCall?.[0].steps[0]).toEqual({ type: "key", keys: [4,5], modifiers: 0, targetApp: "org.test.App" });
  expect(screen.getByRole("group", { name: "よく使うキー" })).toBeInTheDocument();
  expect(screen.getByLabelText("その他のキー")).toBeInTheDocument();
});

it("shows Windows targets and accepts a local EXE macro in the shared editor", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  try {
    render(<MacroEditor value={{ version: 1, steps: [{ type: "openApp", app: String.raw`C:\Tools\Example.exe`, timeoutMs: 1000 }] }} onChange={vi.fn()} onSave={vi.fn()} onTest={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByText("対象アプリのEXEパス / パッケージID")).toBeInTheDocument();
    expect(screen.getByLabelText("手順1の対象アプリ")).toHaveAttribute("maxlength", "32767");
    expect(screen.getByRole("button", { name: "PC内に保存" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "試す" })).toBeEnabled();
  } finally {
    if (original) Object.defineProperty(navigator, "platform", original);
    else Reflect.deleteProperty(navigator, "platform");
  }
});
