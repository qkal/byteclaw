import { describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET,
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  hashCommandList,
  syncTelegramMenuCommands,
} from "./bot-native-command-menu.js";

interface SyncMenuOptions {
  deleteMyCommands: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
  commandsToRegister: Parameters<typeof syncTelegramMenuCommands>[0]["commandsToRegister"];
  accountId: string;
  botIdentity: string;
  runtimeLog?: ReturnType<typeof vi.fn>;
  runtimeError?: ReturnType<typeof vi.fn>;
}

function syncMenuCommandsWithMocks(options: SyncMenuOptions): void {
  syncTelegramMenuCommands({
    accountId: options.accountId,
    bot: {
      api: { deleteMyCommands: options.deleteMyCommands, setMyCommands: options.setMyCommands },
    } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
    botIdentity: options.botIdentity,
    commandsToRegister: options.commandsToRegister,
    runtime: {
      error: options.runtimeError ?? vi.fn(),
      exit: vi.fn(),
      log: options.runtimeLog ?? vi.fn(),
    } as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
  });
}

describe("bot-native-command-menu", () => {
  it("caps menu entries to Telegram limit", () => {
    const allCommands = Array.from({ length: 105 }, (_, i) => ({
      command: `cmd_${i}`,
      description: `Command ${i}`,
    }));

    const result = buildCappedTelegramMenuCommands({ allCommands });

    expect(result.commandsToRegister).toHaveLength(100);
    expect(result.totalCommands).toBe(105);
    expect(result.maxCommands).toBe(100);
    expect(result.overflowCount).toBe(5);
    expect(result.commandsToRegister[0]).toEqual({ command: "cmd_0", description: "Command 0" });
    expect(result.commandsToRegister[99]).toEqual({
      command: "cmd_99",
      description: "Command 99",
    });
  });

  it("shortens descriptions before dropping commands to fit Telegram payload budget", () => {
    const allCommands = Array.from({ length: 92 }, (_, i) => ({
      command: `cmd_${i}`,
      description: "x".repeat(100),
    }));

    const result = buildCappedTelegramMenuCommands({ allCommands });

    expect(result.commandsToRegister).toHaveLength(92);
    expect(result.descriptionTrimmed).toBe(true);
    expect(result.textBudgetDropCount).toBe(0);
    const totalText = result.commandsToRegister.reduce(
      (total, command) => total + command.command.length + command.description.length,
      0,
    );
    expect(totalText).toBeLessThanOrEqual(TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET);
    expect(result.commandsToRegister.every((command) => command.description.length <= 56)).toBe(
      true,
    );
  });

  it("drops tail commands only when minimal descriptions still cannot fit the payload budget", () => {
    const allCommands = [
      { command: "alpha_cmd", description: "First command" },
      { command: "bravo_cmd", description: "Second command" },
      { command: "charlie_cmd", description: "Third command" },
    ];

    const result = buildCappedTelegramMenuCommands({
      allCommands,
      maxTotalChars: 20,
    });

    expect(result.commandsToRegister).toEqual([
      { command: "alpha_cmd", description: "F" },
      { command: "bravo_cmd", description: "S" },
    ]);
    expect(result.descriptionTrimmed).toBe(true);
    expect(result.textBudgetDropCount).toBe(1);
  });

  it("validates plugin command specs and reports conflicts", () => {
    const existingCommands = new Set(["native"]);

    const result = buildPluginTelegramMenuCommands({
      existingCommands,
      specs: [
        { description: "  Works  ", name: "valid" },
        { description: "Bad", name: "bad-name!" },
        { description: "Conflicts with native", name: "native" },
        { description: "Duplicate plugin name", name: "valid" },
        { description: "   ", name: "empty" },
      ],
    });

    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/bad-name!" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).',
    );
    expect(result.issues).toContain(
      'Plugin command "/native" conflicts with an existing Telegram command.',
    );
    expect(result.issues).toContain('Plugin command "/valid" is duplicated.');
    expect(result.issues).toContain('Plugin command "/empty" is missing a description.');
  });

  it("normalizes hyphenated plugin command names", () => {
    const result = buildPluginTelegramMenuCommands({
      existingCommands: new Set<string>(),
      specs: [{ description: "Run agent", name: "agent-run" }],
    });

    expect(result.commands).toEqual([{ command: "agent_run", description: "Run agent" }]);
    expect(result.issues).toEqual([]);
  });

  it("ignores malformed plugin specs without crashing", () => {
    const malformedSpecs = [
      { description: " Works ", name: "valid" },
      { description: undefined, name: "missing-description" },
      { description: "Missing name", name: undefined },
    ] as unknown as Parameters<typeof buildPluginTelegramMenuCommands>[0]["specs"];

    const result = buildPluginTelegramMenuCommands({
      existingCommands: new Set<string>(),
      specs: malformedSpecs,
    });

    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/missing_description" is missing a description.',
    );
    expect(result.issues).toContain(
      'Plugin command "/<unknown>" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).',
    );
  });

  it("deletes stale commands before setting new menu", async () => {
    const callOrder: string[] = [];
    const deleteMyCommands = vi.fn(async () => {
      callOrder.push("delete");
    });
    const setMyCommands = vi.fn(async () => {
      callOrder.push("set");
    });

    syncMenuCommandsWithMocks({
      accountId: `test-delete-${Date.now()}`,
      botIdentity: "bot-a",
      commandsToRegister: [{ command: "cmd", description: "Command" }],
      deleteMyCommands,
      setMyCommands,
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });

    expect(callOrder).toEqual(["delete", "set"]);
  });

  it("produces a stable hash regardless of command order (#32017)", () => {
    const commands = [
      { command: "bravo", description: "B" },
      { command: "alpha", description: "A" },
    ];
    const reversed = [...commands].toReversed();
    expect(hashCommandList(commands)).toBe(hashCommandList(reversed));
  });

  it("produces different hashes for different command lists (#32017)", () => {
    const a = [{ command: "alpha", description: "A" }];
    const b = [{ command: "alpha", description: "Changed" }];
    expect(hashCommandList(a)).not.toBe(hashCommandList(b));
  });

  it("skips sync when command hash is unchanged (#32017)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();

    // Use a unique accountId so cached hashes from other tests don't interfere.
    const accountId = `test-skip-${Date.now()}`;
    const commands = [{ command: "skip_test", description: "Skip test command" }];

    // First sync — no cached hash, should call setMyCommands.
    syncMenuCommandsWithMocks({
      accountId,
      botIdentity: "bot-a",
      commandsToRegister: commands,
      deleteMyCommands,
      runtimeLog,
      setMyCommands,
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(1);
    });

    // Second sync with the same commands — hash is cached, should skip.
    syncMenuCommandsWithMocks({
      accountId,
      botIdentity: "bot-a",
      commandsToRegister: commands,
      deleteMyCommands,
      runtimeLog,
      setMyCommands,
    });

    // SetMyCommands should NOT have been called a second time.
    expect(setMyCommands).toHaveBeenCalledTimes(1);
  });

  it("does not reuse cached hash across different bot identities", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();
    const accountId = `test-bot-identity-${Date.now()}`;
    const commands = [{ command: "same", description: "Same" }];

    syncMenuCommandsWithMocks({
      accountId,
      botIdentity: "token-bot-a",
      commandsToRegister: commands,
      deleteMyCommands,
      runtimeLog,
      setMyCommands,
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(1));

    syncMenuCommandsWithMocks({
      accountId,
      botIdentity: "token-bot-b",
      commandsToRegister: commands,
      deleteMyCommands,
      runtimeLog,
      setMyCommands,
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(2));
  });

  it("does not cache empty-menu hash when deleteMyCommands fails", async () => {
    const deleteMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValue(undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();
    const accountId = `test-empty-delete-fail-${Date.now()}`;

    syncMenuCommandsWithMocks({
      accountId,
      botIdentity: "bot-a",
      commandsToRegister: [],
      deleteMyCommands,
      runtimeLog,
      setMyCommands,
    });
    await vi.waitFor(() => expect(deleteMyCommands).toHaveBeenCalledTimes(1));

    syncMenuCommandsWithMocks({
      accountId,
      botIdentity: "bot-a",
      commandsToRegister: [],
      deleteMyCommands,
      runtimeLog,
      setMyCommands,
    });
    await vi.waitFor(() => expect(deleteMyCommands).toHaveBeenCalledTimes(2));
  });

  it("retries with fewer commands on BOT_COMMANDS_TOO_MUCH", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"))
      .mockResolvedValue(undefined);
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();

    syncMenuCommandsWithMocks({
      accountId: `test-retry-${Date.now()}`,
      botIdentity: "bot-a",
      commandsToRegister: Array.from({ length: 100 }, (_, i) => ({
        command: `cmd_${i}`,
        description: `Command ${i}`,
      })),
      deleteMyCommands,
      runtimeError,
      runtimeLog,
      setMyCommands,
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(2);
    });
    const firstPayload = setMyCommands.mock.calls[0]?.[0] as unknown[];
    const secondPayload = setMyCommands.mock.calls[1]?.[0] as unknown[];
    expect(firstPayload).toHaveLength(100);
    expect(secondPayload).toHaveLength(80);
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram rejected 100 commands (BOT_COMMANDS_TOO_MUCH); retrying with 80.",
    );
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram accepted 80 commands after BOT_COMMANDS_TOO_MUCH (started with 100; omitted 20). Reduce plugin/skill/custom commands to expose more menu entries.",
    );
    expect(runtimeError).not.toHaveBeenCalled();
  });

  it.each([
    { error: { description: "BOT_COMMANDS_TOO_MUCH" }, label: "description envelope" },
    { error: { message: "BOT_COMMANDS_TOO_MUCH" }, label: "message envelope" },
  ])("retries when Telegram returns a plain-object $label error", async ({ error }) => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const runtimeLog = vi.fn();

    syncMenuCommandsWithMocks({
      accountId: `test-envelope-${Date.now()}`,
      botIdentity: "bot-a",
      commandsToRegister: Array.from({ length: 10 }, (_, i) => ({
        command: `cmd_${i}`,
        description: `Command ${i}`,
      })),
      deleteMyCommands,
      runtimeLog,
      setMyCommands,
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(2);
    });
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram rejected 10 commands (BOT_COMMANDS_TOO_MUCH); retrying with 8.",
    );
  });
});
