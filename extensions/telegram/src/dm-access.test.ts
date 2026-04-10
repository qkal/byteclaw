import type { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const createChannelPairingChallengeIssuerMock = vi.hoisted(() => vi.fn());
const upsertChannelPairingRequestMock = vi.hoisted(() =>
  vi.fn(async () => ({ code: "123456", created: true })),
);
const withTelegramApiErrorLoggingMock = vi.hoisted(() => vi.fn(async ({ fn }) => await fn()));
const createPairingPrefixStripperMock = vi.hoisted(
  () => (prefix: RegExp, normalize: (value: string) => string) => (value: string) =>
    normalize(value.replace(prefix, "")),
);

vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingChallengeIssuer: createChannelPairingChallengeIssuerMock,
  createChannelPairingController: () => ({}),
  createLoggedPairingApprovalNotifier: () => undefined,
  createPairingPrefixStripper: createPairingPrefixStripperMock,
  createTextPairingAdapter: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  createScopedAccountReplyToModeResolver: () => () => "off",
  createStaticReplyToModeResolver: (mode: string) => () => mode,
  createTopLevelChannelReplyToModeResolver: () => () => "off",
  resolvePinnedMainDmOwnerFromAllowlist: () => undefined,
  upsertChannelPairingRequest: upsertChannelPairingRequestMock,
}));

vi.mock("./api-logging.js", () => ({
  withTelegramApiErrorLogging: withTelegramApiErrorLoggingMock,
}));

import type { Message } from "@grammyjs/types";
import { normalizeAllowFrom } from "./bot-access.js";
let enforceTelegramDmAccess: typeof import("./dm-access.js").enforceTelegramDmAccess;

function createDmMessage(overrides: Partial<Message> = {}): Message {
  return {
    chat: { id: 42, type: "private" },
    date: 1,
    from: {
      first_name: "Test",
      id: 12_345,
      is_bot: false,
      username: "tester",
    },
    message_id: 1,
    text: "hello",
    ...overrides,
  } as Message;
}

describe("enforceTelegramDmAccess", () => {
  beforeAll(async () => {
    ({ enforceTelegramDmAccess } = await import("./dm-access.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows DMs when policy is open", async () => {
    const bot = { api: { sendMessage: vi.fn(async () => undefined) } };

    const allowed = await enforceTelegramDmAccess({
      accountId: "main",
      bot: bot as never,
      chatId: 42,
      dmPolicy: "open",
      effectiveDmAllow: normalizeAllowFrom([]),
      isGroup: false,
      logger: { info: vi.fn() },
      msg: createDmMessage(),
      upsertPairingRequest: upsertChannelPairingRequestMock,
    });

    expect(allowed).toBe(true);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("blocks DMs when policy is disabled", async () => {
    const allowed = await enforceTelegramDmAccess({
      accountId: "main",
      bot: { api: { sendMessage: vi.fn(async () => undefined) } } as never,
      chatId: 42,
      dmPolicy: "disabled",
      effectiveDmAllow: normalizeAllowFrom([]),
      isGroup: false,
      logger: { info: vi.fn() },
      msg: createDmMessage(),
      upsertPairingRequest: upsertChannelPairingRequestMock,
    });

    expect(allowed).toBe(false);
  });

  it("allows DMs for allowlisted senders under pairing policy", async () => {
    const allowed = await enforceTelegramDmAccess({
      accountId: "main",
      bot: { api: { sendMessage: vi.fn(async () => undefined) } } as never,
      chatId: 42,
      dmPolicy: "pairing",
      effectiveDmAllow: normalizeAllowFrom(["12345"]),
      isGroup: false,
      logger: { info: vi.fn() },
      msg: createDmMessage(),
      upsertPairingRequest: upsertChannelPairingRequestMock,
    });

    expect(allowed).toBe(true);
    expect(createChannelPairingChallengeIssuerMock).not.toHaveBeenCalled();
  });

  it("issues a pairing challenge for unauthorized DMs under pairing policy", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const logger = { info: vi.fn() };
    createChannelPairingChallengeIssuerMock.mockReturnValueOnce(
      ({
        sendPairingReply,
        onCreated,
      }: Parameters<ReturnType<typeof createChannelPairingChallengeIssuer>>[0]) =>
        (async () => {
          onCreated?.({ code: "123456" });
          await sendPairingReply("Pairing code: 123456");
        })(),
    );

    const allowed = await enforceTelegramDmAccess({
      accountId: "main",
      bot: { api: { sendMessage } } as never,
      chatId: 42,
      dmPolicy: "pairing",
      effectiveDmAllow: normalizeAllowFrom([]),
      isGroup: false,
      logger,
      msg: createDmMessage(),
      upsertPairingRequest: upsertChannelPairingRequestMock,
    });

    expect(allowed).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [firstCall] = sendMessage.mock.calls as unknown[][];
    expect(firstCall?.[0]).toBe(42);
    const sentText = String(firstCall?.[1] ?? "");
    expect(sentText).toContain("Pairing code:");
    expect(firstCall?.[2]).toEqual(expect.objectContaining({ parse_mode: "HTML" }));
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "42",
        senderUserId: "12345",
        username: "tester",
      }),
      "telegram pairing request",
    );
  });
});
