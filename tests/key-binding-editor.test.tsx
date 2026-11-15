// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KeyBindingEditor } from "../src/KeyBindingEditor";
afterEach(cleanup);
const empty = { codes: [], mask: 0 };
const capture = () =>
  screen.getByRole("button", {
    name: "ここをクリックして、割り当てたいキーを押す",
  });
it("shares capture semantics and caps ordinary chord at six keys", () => {
  const change = vi.fn();
  render(<KeyBindingEditor value={empty} onChange={change} editable />);
  const button = capture();
  fireEvent.click(button);
  for (const c of "ABCDEFG")
    fireEvent.keyDown(button, { key: c, code: `Key${c}`, ctrlKey: true });
  fireEvent.keyUp(button, { key: "A", code: "KeyA" });
  expect(change).toHaveBeenCalledWith({
    codes: ["KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF"],
    mask: 1,
  });
});
it("Tab navigates, Escape cancels and a lock or reset cancels capture", () => {
  const change = vi.fn(),
    state = vi.fn();
  const p = {
    value: empty,
    onChange: change,
    onCaptureChange: state,
    editable: true,
  };
  const { rerender } = render(<KeyBindingEditor {...p} resetKey={1} />);
  let button = capture();
  fireEvent.click(button);
  expect(fireEvent.keyDown(button, { key: "Tab", code: "Tab" })).toBe(true);
  expect(button).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(button);
  fireEvent.keyDown(button, { key: "Escape", code: "Escape" });
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(button);
  fireEvent.keyDown(button, { key: "A", code: "KeyA" });
  rerender(<KeyBindingEditor {...p} resetKey={2} />);
  fireEvent.keyUp(button, { key: "A", code: "KeyA" });
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(button);
  rerender(<KeyBindingEditor {...p} editable={false} resetKey={2} />);
  expect(state).toHaveBeenLastCalledWith(false);
  expect(button).toBeDisabled();
});
it("uses same chips/dropdown and isolates accessibility IDs across macro rows", () => {
  const change = vi.fn();
  render(
    <>
      <KeyBindingEditor
        value={{ codes: ["KeyA", "KeyB"], mask: 1 }}
        onChange={change}
        editable
        showValue
      />
      <KeyBindingEditor
        value={empty}
        onChange={change}
        editable
        allowWindowsOnly={false}
      />
    </>,
  );
  expect(screen.getAllByLabelText("その他のキー")).toHaveLength(2);
  expect(screen.getAllByRole("group", { name: "修飾キー" })).toHaveLength(2);
  expect(screen.getByLabelText("選択中のキー")).toHaveTextContent(
    "Ctrl+A+B",
  );
  const selects = screen.getAllByLabelText("その他のキー");
  expect(selects[0].id).not.toBe(selects[1].id);
  fireEvent.change(selects[0], { target: { value: "WindowsOnly" } });
  expect(change).toHaveBeenLastCalledWith({ codes: ["WindowsOnly"], mask: 0 });
});
