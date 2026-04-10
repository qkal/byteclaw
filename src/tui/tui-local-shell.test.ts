import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createLocalShellRunner } from "./tui-local-shell.js";

const createSelector = () => {
  const selector = {
    invalidate: () => {},
    onCancel: undefined as (() => void) | undefined,
    onSelect: undefined as ((item: { value: string; label: string }) => void) | undefined,
    render: () => ["selector"],
  };
  return selector;
};

function createShellHarness(params?: {
  spawnCommand?: typeof import("node:child_process").spawn;
  env?: Record<string, string>;
}) {
  const messages: string[] = [];
  const chatLog = {
    addSystem: (line: string) => {
      messages.push(line);
    },
  };
  const tui = { requestRender: vi.fn() };
  const openOverlay = vi.fn();
  const closeOverlay = vi.fn();
  let lastSelector: ReturnType<typeof createSelector> | null = null;
  const createSelectorSpy = vi.fn(() => {
    lastSelector = createSelector();
    return lastSelector;
  });
  const spawnCommand = params?.spawnCommand ?? vi.fn();
  const { runLocalShellLine } = createLocalShellRunner({
    chatLog,
    closeOverlay,
    createSelector: createSelectorSpy,
    openOverlay,
    spawnCommand,
    tui,
    ...(params?.env ? { env: params.env } : {}),
  });
  return {
    createSelectorSpy,
    getLastSelector: () => lastSelector,
    messages,
    openOverlay,
    runLocalShellLine,
    spawnCommand,
  };
}

describe("createLocalShellRunner", () => {
  it("logs denial on subsequent ! attempts without re-prompting", async () => {
    const harness = createShellHarness();

    const firstRun = harness.runLocalShellLine("!ls");
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    const selector = harness.getLastSelector();
    selector?.onSelect?.({ label: "No", value: "no" });
    await firstRun;

    await harness.runLocalShellLine("!pwd");

    expect(harness.messages).toContain("local shell: not enabled");
    expect(harness.messages).toContain("local shell: not enabled for this session");
    expect(harness.createSelectorSpy).toHaveBeenCalledTimes(1);
    expect(harness.spawnCommand).not.toHaveBeenCalled();
  });

  it("sets OPENCLAW_SHELL when running local shell commands", async () => {
    const spawnCommand = vi.fn((_command: string, _options: unknown) => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      return {
        on: (event: string, callback: (...args: unknown[]) => void) => {
          if (event === "close") {
            setImmediate(() => callback(0, null));
          }
        },
        stderr,
        stdout,
      };
    });

    const harness = createShellHarness({
      env: { PATH: "/tmp/bin", USER: "dev" },
      spawnCommand: spawnCommand as unknown as typeof import("node:child_process").spawn,
    });

    const firstRun = harness.runLocalShellLine("!echo hi");
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    const selector = harness.getLastSelector();
    selector?.onSelect?.({ label: "Yes", value: "yes" });
    await firstRun;

    expect(harness.createSelectorSpy).toHaveBeenCalledTimes(1);
    expect(spawnCommand).toHaveBeenCalledTimes(1);
    const spawnOptions = spawnCommand.mock.calls[0]?.[1] as { env?: Record<string, string> };
    expect(spawnOptions.env?.OPENCLAW_SHELL).toBe("tui-local");
    expect(spawnOptions.env?.PATH).toBe("/tmp/bin");
    expect(harness.messages).toContain("local shell: enabled for this session");
  });
});
