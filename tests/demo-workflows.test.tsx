// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { BASELINE, cloneBindings } from "../src/domain";
import type { Bindings, DemoBackup } from "../src/domain";

const editedDraft = (): Bindings => ({
  ...cloneBindings(BASELINE),
  left: { codes: ["KeyA", "KeyB"], modifiers: ["alt"] },
  right: { codes: ["KeyT"], modifiers: ["ctrl", "shift"] },
});

function backup(overrides: Partial<DemoBackup> = {}): DemoBackup {
  return {
    schemaVersion: 2,
    id: "test-backup",
    createdAt: "2026-11-09T00:00:00Z",
    name: "比較するサンプル",
    source: "demo",
    firmware: "demo-v1",
    bindings: {
      ...cloneBindings(BASELINE),
      left: { codes: ["KeyB", "KeyC"], modifiers: [] },
      right: { ...BASELINE.right, modifiers: [] },
    },
    ...overrides,
  };
}

function setupApply() {
  const props = {
    baseline: cloneBindings(BASELINE),
    draft: editedDraft(),
    os: "windows" as const,
    onApplyResult: vi.fn(),
    onBackupCreated: vi.fn(),
    onRestart: vi.fn(),
    onOpenBackups: vi.fn(),
    onClose: vi.fn(),
  };
  const view = render(
    <Theme theme={neutralTheme} mode="dark">
      <DesignApply {...props} />
    </Theme>,
  );
  return { ...view, props };
}

function setupBackups() {
  const selected = backup();
  const unknown = backup({
    id: "unknown-backup",
    name: "互換性不明のサンプル",
    firmware: "unknown",
    bindings: cloneBindings(BASELINE),
  });
  const props = {
    baseline: cloneBindings(BASELINE),
    draft: editedDraft(),
    backups: [selected, unknown],
    os: "windows" as const,
    onAddBackup: vi.fn(),
    onRestoreDraft: vi.fn(),
    onClose: vi.fn(),
  };
  const view = render(
    <Theme theme={neutralTheme} mode="dark">
      <DesignBackups {...props} />
    </Theme>,
  );
  return { ...view, props, selected, unknown };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function startApply() {
  fireEvent.click(
    screen.getByRole("button", { name: "2件を反映する（デモ）" }),
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("backs up the baseline and applies confirmed demo changes", async () => {
  const { props } = setupApply();
  expect(props.onApplyResult).not.toHaveBeenCalled();
  startApply();
  await advance(10000);
  expect(props.onBackupCreated).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ source: "demo", bindings: BASELINE }),
  );
  expect(props.onApplyResult).toHaveBeenCalledExactlyOnceWith({
    baseline: editedDraft(),
    applied: ["left", "right"],
    failed: null,
    stopped: false,
  });
  expect(props.baseline).toEqual(BASELINE);
});
it("stops pending demo changes and resumes only after another explicit action", async () => {
  const { props } = setupApply();
  startApply();
  fireEvent.click(screen.getByRole("button", { name: "残りを中止" }));
  await advance(10000);
  expect(props.onApplyResult).toHaveBeenCalledExactlyOnceWith({
    baseline: BASELINE,
    applied: [],
    failed: null,
    stopped: true,
  });
  fireEvent.click(screen.getByRole("button", { name: /残り.*件を続けて反映/ }));
  await advance(10000);
  expect(props.onApplyResult).toHaveBeenLastCalledWith({
    baseline: editedDraft(),
    applied: ["left", "right"],
    failed: null,
    stopped: false,
  });
});
it("exports and imports demo backups without applying them; unknown firmware stays read-only", async () => {
  const createObjectURL = vi.fn(() => "blob:vanzy-test");
  const revokeObjectURL = vi.fn();
  class DownloadURL extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  }
  vi.stubGlobal("URL", DownloadURL);
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  const serialize = vi.spyOn(JSON, "stringify");
  const { props } = setupBackups();
  fireEvent.click(
    screen.getByRole("button", { name: "ファイルに書き出す（.json）" }),
  );
  expect(serialize).toHaveBeenCalledWith(
    expect.objectContaining({
      source: "demo",
      warning: expect.stringContaining("Not a device backup"),
    }),
    null,
    2,
  );
  expect(click).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: /互換性不明のサンプル/ }));
  expect(screen.getByRole("button", { name: "復元できません" })).toBeDisabled();
  await act(async () => {
    fireEvent.change(screen.getByLabelText("デモJSONを選択"), {
      target: {
        files: [{ size: 100, text: async () => JSON.stringify(backup()) }],
      },
    });
  });
  expect(props.onAddBackup).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ source: "demo", bindings: backup().bindings }),
  );
  expect(props.onRestoreDraft).not.toHaveBeenCalled();
  const legacy = {
    ...backup(),
    schemaVersion: undefined,
    bindings: {
      left: { code: "KeyA", modifiers: ["ctrl"] },
      right: { code: "ArrowRight", modifiers: [] },
    },
  };
  expect(parseDemoBackup(JSON.stringify(legacy)).bindings.left).toEqual({
    codes: ["KeyA"],
    modifiers: ["ctrl"],
  });
});
it("rejects malformed, non-demo and unsupported-key imports", () => {
  for (const input of [
    "not json",
    JSON.stringify(
      backup({
        bindings: { ...BASELINE, left: { codes: [], modifiers: ["ctrl"] } },
      }),
    ),
    JSON.stringify(
      backup({
        bindings: {
          ...BASELINE,
          left: { codes: ["KeyA", "KeyA"], modifiers: [] },
        },
      }),
    ),
    JSON.stringify({ ...backup(), source: "device" }),
    JSON.stringify(
      backup({
        bindings: {
          ...BASELINE,
          left: { codes: ["__proto__"], modifiers: [] },
        },
      }),
    ),
  ])
    expect(() => parseDemoBackup(input)).toThrow();
});
