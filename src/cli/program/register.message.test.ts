import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgramContext } from "./context.js";
import { registerMessageCommands } from "./register.message.js";

const mocks = vi.hoisted(() => ({
  createMessageCliHelpersMock: vi.fn(() => ({ helper: true })),
  registerMessageBroadcastCommandMock: vi.fn(),
  registerMessageDiscordAdminCommandsMock: vi.fn(),
  registerMessageEmojiCommandsMock: vi.fn(),
  registerMessagePermissionsCommandMock: vi.fn(),
  registerMessagePinCommandsMock: vi.fn(),
  registerMessagePollCommandMock: vi.fn(),
  registerMessageReactionsCommandsMock: vi.fn(),
  registerMessageReadEditDeleteCommandsMock: vi.fn(),
  registerMessageSearchCommandMock: vi.fn(),
  registerMessageSendCommandMock: vi.fn(),
  registerMessageStickerCommandsMock: vi.fn(),
  registerMessageThreadCommandsMock: vi.fn(),
}));

const { createMessageCliHelpersMock } = mocks;
const { registerMessageSendCommandMock } = mocks;
const { registerMessageBroadcastCommandMock } = mocks;
const { registerMessagePollCommandMock } = mocks;
const { registerMessageReactionsCommandsMock } = mocks;
const { registerMessageReadEditDeleteCommandsMock } = mocks;
const { registerMessagePinCommandsMock } = mocks;
const { registerMessagePermissionsCommandMock } = mocks;
const { registerMessageSearchCommandMock } = mocks;
const { registerMessageThreadCommandsMock } = mocks;
const { registerMessageEmojiCommandsMock } = mocks;
const { registerMessageStickerCommandsMock } = mocks;
const { registerMessageDiscordAdminCommandsMock } = mocks;

vi.mock("./message/helpers.js", () => ({
  createMessageCliHelpers: mocks.createMessageCliHelpersMock,
}));

vi.mock("./message/register.send.js", () => ({
  registerMessageSendCommand: mocks.registerMessageSendCommandMock,
}));

vi.mock("./message/register.broadcast.js", () => ({
  registerMessageBroadcastCommand: mocks.registerMessageBroadcastCommandMock,
}));

vi.mock("./message/register.poll.js", () => ({
  registerMessagePollCommand: mocks.registerMessagePollCommandMock,
}));

vi.mock("./message/register.reactions.js", () => ({
  registerMessageReactionsCommands: mocks.registerMessageReactionsCommandsMock,
}));

vi.mock("./message/register.read-edit-delete.js", () => ({
  registerMessageReadEditDeleteCommands: mocks.registerMessageReadEditDeleteCommandsMock,
}));

vi.mock("./message/register.pins.js", () => ({
  registerMessagePinCommands: mocks.registerMessagePinCommandsMock,
}));

vi.mock("./message/register.permissions-search.js", () => ({
  registerMessagePermissionsCommand: mocks.registerMessagePermissionsCommandMock,
  registerMessageSearchCommand: mocks.registerMessageSearchCommandMock,
}));

vi.mock("./message/register.thread.js", () => ({
  registerMessageThreadCommands: mocks.registerMessageThreadCommandsMock,
}));

vi.mock("./message/register.emoji-sticker.js", () => ({
  registerMessageEmojiCommands: mocks.registerMessageEmojiCommandsMock,
  registerMessageStickerCommands: mocks.registerMessageStickerCommandsMock,
}));

vi.mock("./message/register.discord-admin.js", () => ({
  registerMessageDiscordAdminCommands: mocks.registerMessageDiscordAdminCommandsMock,
}));

describe("registerMessageCommands", () => {
  const ctx: ProgramContext = {
    agentChannelOptions: "last|telegram|discord",
    channelOptions: ["telegram", "discord"],
    messageChannelOptions: "telegram|discord",
    programVersion: "9.9.9-test",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    createMessageCliHelpersMock.mockReturnValue({ helper: true });
  });

  it("registers message command and wires all message sub-registrars with shared helpers", () => {
    const program = new Command();
    registerMessageCommands(program, ctx);

    const message = program.commands.find((command) => command.name() === "message");
    expect(message).toBeDefined();
    expect(createMessageCliHelpersMock).toHaveBeenCalledWith(message, "telegram|discord");

    const expectedRegistrars = [
      registerMessageSendCommandMock,
      registerMessageBroadcastCommandMock,
      registerMessagePollCommandMock,
      registerMessageReactionsCommandsMock,
      registerMessageReadEditDeleteCommandsMock,
      registerMessagePinCommandsMock,
      registerMessagePermissionsCommandMock,
      registerMessageSearchCommandMock,
      registerMessageThreadCommandsMock,
      registerMessageEmojiCommandsMock,
      registerMessageStickerCommandsMock,
      registerMessageDiscordAdminCommandsMock,
    ];
    for (const registrar of expectedRegistrars) {
      expect(registrar).toHaveBeenCalledWith(message, { helper: true });
    }
  });

  it("shows command help when root message command is invoked", async () => {
    const program = new Command().exitOverride();
    registerMessageCommands(program, ctx);
    const message = program.commands.find((command) => command.name() === "message");
    expect(message).toBeDefined();
    const helpSpy = vi.spyOn(message as Command, "help").mockImplementation(() => {
      throw new Error("help-called");
    });

    await expect(program.parseAsync(["message"], { from: "user" })).rejects.toThrow("help-called");
    expect(helpSpy).toHaveBeenCalledWith({ error: true });
  });
});
