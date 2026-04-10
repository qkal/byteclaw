import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedIrcAccount } from "./accounts.js";
import { handleIrcInbound } from "./inbound.js";
import type { RuntimeEnv } from "./runtime-api.js";
import { setIrcRuntime } from "./runtime.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

const {
  buildMentionRegexesMock,
  hasControlCommandMock,
  matchesMentionPatternsMock,
  readAllowFromStoreMock,
  shouldHandleTextCommandsMock,
  upsertPairingRequestMock,
} = vi.hoisted(() => ({
  buildMentionRegexesMock: vi.fn(() => []),
  hasControlCommandMock: vi.fn(() => false),
  matchesMentionPatternsMock: vi.fn(() => false),
  readAllowFromStoreMock: vi.fn(async () => []),
  shouldHandleTextCommandsMock: vi.fn(() => false),
  upsertPairingRequestMock: vi.fn(async () => ({ code: "CODE", created: true })),
}));

function installIrcRuntime() {
  setIrcRuntime({
    channel: {
      commands: {
        shouldHandleTextCommands: shouldHandleTextCommandsMock,
      },
      mentions: {
        buildMentionRegexes: buildMentionRegexesMock,
        matchesMentionPatterns: matchesMentionPatternsMock,
      },
      pairing: {
        readAllowFromStore: readAllowFromStoreMock,
        upsertPairingRequest: upsertPairingRequestMock,
      },
      text: {
        hasControlCommand: hasControlCommandMock,
      },
    },
  } as never);
}

function createRuntimeEnv() {
  return {
    error: vi.fn(),
    log: vi.fn(),
  } as unknown as RuntimeEnv;
}

function createAccount(overrides?: Partial<ResolvedIrcAccount>): ResolvedIrcAccount {
  return {
    accountId: "default",
    config: {
      allowFrom: [],
      dmPolicy: "pairing",
      groupAllowFrom: [],
      groupPolicy: "allowlist",
    },
    enabled: true,
    nick: "OpenClaw",
    server: "irc.example.com",
    ...overrides,
  } as ResolvedIrcAccount;
}

function createMessage(overrides?: Partial<IrcInboundMessage>): IrcInboundMessage {
  return {
    isGroup: false,
    messageId: "msg-1",
    senderHost: "example.com",
    senderNick: "alice",
    senderUser: "ident",
    target: "alice",
    text: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("irc inbound behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installIrcRuntime();
    readAllowFromStoreMock.mockResolvedValue([]);
  });

  it("issues a DM pairing challenge and sends the reply to the sender nick", async () => {
    const sendReply = vi.fn(async () => {});

    await handleIrcInbound({
      account: createAccount(),
      config: { channels: { irc: {} } } as CoreConfig,
      message: createMessage(),
      runtime: createRuntimeEnv(),
      sendReply,
    });

    expect(upsertPairingRequestMock).toHaveBeenCalledWith({
      accountId: "default",
      channel: "irc",
      id: "alice!ident@example.com",
      meta: { name: "alice" },
    });
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith(
      "alice",
      expect.stringContaining("OpenClaw: access not configured."),
      undefined,
    );
    expect(sendReply).toHaveBeenCalledWith(
      "alice",
      expect.stringContaining("Your IRC id: alice!ident@example.com"),
      undefined,
    );
    expect(sendReply).toHaveBeenCalledWith("alice", expect.stringContaining("CODE"), undefined);
  });

  it("drops unauthorized group control commands before dispatch", async () => {
    const runtime = createRuntimeEnv();
    shouldHandleTextCommandsMock.mockReturnValue(true);
    hasControlCommandMock.mockReturnValue(true);

    await handleIrcInbound({
      account: createAccount({
        config: {
          allowFrom: [],
          dmPolicy: "pairing",
          groupAllowFrom: ["bob!ident@example.com"],
          groupPolicy: "allowlist",
          groups: {
            "#ops": {
              allowFrom: ["alice!ident@example.com"],
            },
          },
        },
      }),
      config: { channels: { irc: {} }, commands: { useAccessGroups: true } } as CoreConfig,
      message: createMessage({
        isGroup: true,
        target: "#ops",
        text: "/admin",
      }),
      runtime,
    });

    expect(runtime.log).toHaveBeenCalledWith(
      "irc: drop control command (unauthorized) target=alice!ident@example.com",
    );
  });
});
