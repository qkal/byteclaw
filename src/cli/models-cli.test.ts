import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerModelsCli } from "./models-cli.js";

const mocks = vi.hoisted(() => ({
  modelsAuthLoginCommand: vi.fn().mockResolvedValue(undefined),
  modelsStatusCommand: vi.fn().mockResolvedValue(undefined),
  noopAsync: vi.fn(async () => undefined),
}));

const { modelsStatusCommand, modelsAuthLoginCommand } = mocks;

vi.mock("../commands/models.js", () => ({
  modelsAliasesAddCommand: mocks.noopAsync,
  modelsAliasesListCommand: mocks.noopAsync,
  modelsAliasesRemoveCommand: mocks.noopAsync,
  modelsAuthAddCommand: mocks.noopAsync,
  modelsAuthLoginCommand: mocks.modelsAuthLoginCommand,
  modelsAuthOrderClearCommand: mocks.noopAsync,
  modelsAuthOrderGetCommand: mocks.noopAsync,
  modelsAuthOrderSetCommand: mocks.noopAsync,
  modelsAuthPasteTokenCommand: mocks.noopAsync,
  modelsAuthSetupTokenCommand: mocks.noopAsync,
  modelsFallbacksAddCommand: mocks.noopAsync,
  modelsFallbacksClearCommand: mocks.noopAsync,
  modelsFallbacksListCommand: mocks.noopAsync,
  modelsFallbacksRemoveCommand: mocks.noopAsync,
  modelsImageFallbacksAddCommand: mocks.noopAsync,
  modelsImageFallbacksClearCommand: mocks.noopAsync,
  modelsImageFallbacksListCommand: mocks.noopAsync,
  modelsImageFallbacksRemoveCommand: mocks.noopAsync,
  modelsListCommand: mocks.noopAsync,
  modelsScanCommand: mocks.noopAsync,
  modelsSetCommand: mocks.noopAsync,
  modelsSetImageCommand: mocks.noopAsync,
  modelsStatusCommand: mocks.modelsStatusCommand,
}));

describe("models cli", () => {
  beforeEach(() => {
    modelsAuthLoginCommand.mockClear();
    modelsStatusCommand.mockClear();
  });

  function createProgram() {
    const program = new Command();
    registerModelsCli(program);
    return program;
  }

  async function runModelsCommand(args: string[]) {
    await runRegisteredCli({
      argv: args,
      register: registerModelsCli as (program: Command) => void,
    });
  }

  it("registers github-copilot login command", async () => {
    const program = createProgram();
    const models = program.commands.find((cmd) => cmd.name() === "models");
    expect(models).toBeTruthy();

    const auth = models?.commands.find((cmd) => cmd.name() === "auth");
    expect(auth).toBeTruthy();

    const login = auth?.commands.find((cmd) => cmd.name() === "login-github-copilot");
    expect(login).toBeTruthy();

    await program.parseAsync(["models", "auth", "login-github-copilot", "--yes"], {
      from: "user",
    });

    expect(modelsAuthLoginCommand).toHaveBeenCalledTimes(1);
    expect(modelsAuthLoginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "device",
        provider: "github-copilot",
        yes: true,
      }),
      expect.any(Object),
    );
  });

  it.each([
    { args: ["models", "status", "--agent", "poe"], label: "status flag" },
    { args: ["models", "--agent", "poe", "status"], label: "parent flag" },
  ])("passes --agent to models status ($label)", async ({ args }) => {
    await runModelsCommand(args);
    expect(modelsStatusCommand).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "poe" }),
      expect.any(Object),
    );
  });

  it("shows help for models auth without error exit", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: () => {},
    });
    registerModelsCli(program);

    try {
      await program.parseAsync(["models", "auth"], { from: "user" });
      expect.fail("expected help to exit");
    } catch (error) {
      const error = error as { exitCode?: number };
      expect(error.exitCode).toBe(0);
    }
  });
});
