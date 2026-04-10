import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerUpdateCli } from "./update-cli.js";

const mocks = vi.hoisted(() => ({
  defaultRuntime: {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  },
  updateCommand: vi.fn(async (_opts: unknown) => {}),
  updateStatusCommand: vi.fn(async (_opts: unknown) => {}),
  updateWizardCommand: vi.fn(async (_opts: unknown) => {}),
}));

const { updateCommand, updateStatusCommand, updateWizardCommand, defaultRuntime } = mocks;

vi.mock("./update-cli/update-command.js", () => ({
  updateCommand: (opts: unknown) => mocks.updateCommand(opts),
}));

vi.mock("./update-cli/status.js", () => ({
  updateStatusCommand: (opts: unknown) => mocks.updateStatusCommand(opts),
}));

vi.mock("./update-cli/wizard.js", () => ({
  updateWizardCommand: (opts: unknown) => mocks.updateWizardCommand(opts),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

describe("update cli option collisions", () => {
  beforeEach(() => {
    updateCommand.mockClear();
    updateStatusCommand.mockClear();
    updateWizardCommand.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it.each([
    {
      argv: ["update", "status", "--json", "--timeout", "9"],
      assert: () => {
        expect(updateStatusCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            json: true,
            timeout: "9",
          }),
        );
      },
      name: "forwards parent-captured --json/--timeout to `update status`",
    },
    {
      argv: ["update", "wizard", "--timeout", "13"],
      assert: () => {
        expect(updateWizardCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            timeout: "13",
          }),
        );
      },
      name: "forwards parent-captured --timeout to `update wizard`",
    },
  ])("$name", async ({ argv, assert }) => {
    await runRegisteredCli({
      argv,
      register: registerUpdateCli as (program: Command) => void,
    });

    assert();
  });
});
