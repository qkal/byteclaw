import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import "./monitor.send-mocks.js";
import "./zalo-js.test-mocks.js";
import { resolveZalouserAccountSync } from "./accounts.js";
import { __testing } from "./monitor.js";
import {
  sendDeliveredZalouserMock,
  sendMessageZalouserMock,
  sendSeenZalouserMock,
  sendTypingZalouserMock,
} from "./monitor.send-mocks.js";
import { setZalouserRuntime } from "./runtime.js";
import { createZalouserRuntimeEnv } from "./test-helpers.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";

function createAccount(): ResolvedZalouserAccount {
  return {
    accountId: "default",
    authenticated: true,
    config: {
      groupPolicy: "open",
      groups: {
        "*": { requireMention: true },
      },
    },
    enabled: true,
    profile: "default",
  };
}

function createConfig(): OpenClawConfig {
  return {
    channels: {
      zalouser: {
        enabled: true,
        groups: {
          "*": { requireMention: true },
        },
      },
    },
  };
}

const createRuntimeEnv = () => createZalouserRuntimeEnv();

function installRuntime(params: {
  commandAuthorized?: boolean;
  replyPayload?: { text?: string; mediaUrl?: string; mediaUrls?: string[] };
  resolveCommandAuthorizedFromAuthorizers?: (params: {
    useAccessGroups: boolean;
    authorizers: { configured: boolean; allowed: boolean }[];
  }) => boolean;
}) {
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions, ctx }) => {
    await dispatcherOptions.typingCallbacks?.onReplyStart?.();
    if (params.replyPayload) {
      await dispatcherOptions.deliver(params.replyPayload);
    }
    return { counts: { block: 0, final: 0, tool: 0 }, ctx, queuedFinal: false };
  });
  const resolveCommandAuthorizedFromAuthorizers = vi.fn(
    (input: {
      useAccessGroups: boolean;
      authorizers: { configured: boolean; allowed: boolean }[];
    }) => {
      if (params.resolveCommandAuthorizedFromAuthorizers) {
        return params.resolveCommandAuthorizedFromAuthorizers(input);
      }
      return params.commandAuthorized ?? false;
    },
  );
  const resolveAgentRoute = vi.fn((input: { peer?: { kind?: string; id?: string } }) => {
    const peerKind = input.peer?.kind === "direct" ? "direct" : "group";
    const peerId = input.peer?.id ?? "1";
    return {
      accountId: "default",
      agentId: "main",
      mainSessionKey: "agent:main:main",
      sessionKey:
        peerKind === "direct" ? "agent:main:main" : `agent:main:zalouser:${peerKind}:${peerId}`,
    };
  });
  const readAllowFromStore = vi.fn(async () => []);
  const readSessionUpdatedAt = vi.fn(
    (_params?: { storePath: string; sessionKey: string }): number | undefined => undefined,
  );
  const buildAgentSessionKey = vi.fn(
    (input: {
      agentId: string;
      channel: string;
      accountId?: string;
      peer?: { kind?: string; id?: string };
      dmScope?: string;
    }) => {
      const peerKind = input.peer?.kind === "direct" ? "direct" : "group";
      const peerId = input.peer?.id ?? "1";
      if (peerKind === "direct") {
        if (input.dmScope === "per-account-channel-peer") {
          return `agent:${input.agentId}:${input.channel}:${input.accountId ?? "default"}:direct:${peerId}`;
        }
        if (input.dmScope === "per-peer") {
          return `agent:${input.agentId}:direct:${peerId}`;
        }
        if (input.dmScope === "main" || !input.dmScope) {
          return "agent:main:main";
        }
      }
      return `agent:${input.agentId}:${input.channel}:${peerKind}:${peerId}`;
    },
  );

  setZalouserRuntime({
    channel: {
      commands: {
        isControlCommandMessage: vi.fn((body: string) => body.trim().startsWith("/")),
        resolveCommandAuthorizedFromAuthorizers,
        shouldComputeCommandAuthorized: vi.fn((body: string) => body.trim().startsWith("/")),
        shouldHandleTextCommands: vi.fn(() => true),
      },
      groups: {
        resolveRequireMention: vi.fn((input) => {
          const cfg = input.cfg as OpenClawConfig;
          const groupCfg = cfg.channels?.zalouser?.groups ?? {};
          const typedGroupCfg = groupCfg as Record<string, { requireMention?: boolean }>;
          const groupEntry = input.groupId ? typedGroupCfg[input.groupId] : undefined;
          const defaultEntry = typedGroupCfg["*"];
          if (typeof groupEntry?.requireMention === "boolean") {
            return groupEntry.requireMention;
          }
          if (typeof defaultEntry?.requireMention === "boolean") {
            return defaultEntry.requireMention;
          }
          return true;
        }),
      },
      mentions: {
        buildMentionRegexes: vi.fn(() => []),
        matchesMentionWithExplicit: vi.fn(
          (input) => input.explicit?.isExplicitlyMentioned === true,
        ),
      },
      pairing: {
        buildPairingReply: vi.fn(() => "pair"),
        readAllowFromStore,
        upsertPairingRequest: vi.fn(async () => ({ code: "PAIR", created: true })),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
        finalizeInboundContext: vi.fn((ctx) => ctx),
        formatAgentEnvelope: vi.fn(({ body }) => body),
        resolveEnvelopeFormatOptions: vi.fn(() => undefined),
      },
      routing: {
        buildAgentSessionKey,
        resolveAgentRoute,
      },
      session: {
        readSessionUpdatedAt,
        recordInboundSession: vi.fn(async () => {}),
        resolveStorePath: vi.fn(() => "/tmp"),
      },
      text: {
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
        convertMarkdownTables: vi.fn((text: string) => text),
        resolveChunkMode: vi.fn(() => "length"),
        resolveMarkdownTableMode: vi.fn(() => "code"),
        resolveTextChunkLimit: vi.fn(() => 1200),
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime);

  return {
    buildAgentSessionKey,
    dispatchReplyWithBufferedBlockDispatcher,
    readAllowFromStore,
    readSessionUpdatedAt,
    resolveAgentRoute,
    resolveCommandAuthorizedFromAuthorizers,
  };
}

function installGroupCommandAuthRuntime() {
  return installRuntime({
    resolveCommandAuthorizedFromAuthorizers: ({ useAccessGroups, authorizers }) =>
      useAccessGroups && authorizers.some((entry) => entry.configured && entry.allowed),
  });
}

async function processGroupControlCommand(params: {
  account: ResolvedZalouserAccount;
  content?: string;
  commandContent?: string;
}) {
  await __testing.processMessage({
    account: params.account,
    config: createConfig(),
    message: createGroupMessage({
      commandContent: params.commandContent ?? "/new",
      content: params.content ?? "/new",
      hasAnyMention: true,
      wasExplicitlyMentioned: true,
    }),
    runtime: createRuntimeEnv(),
  });
}

function createGroupMessage(overrides: Partial<ZaloInboundMessage> = {}): ZaloInboundMessage {
  return {
    canResolveExplicitMention: true,
    content: "hello",
    groupName: "Team",
    hasAnyMention: false,
    implicitMention: false,
    isGroup: true,
    msgId: "m-1",
    raw: { source: "test" },
    senderId: "123",
    senderName: "Alice",
    threadId: "g-1",
    timestampMs: Date.now(),
    wasExplicitlyMentioned: false,
    ...overrides,
  };
}

function createDmMessage(overrides: Partial<ZaloInboundMessage> = {}): ZaloInboundMessage {
  return {
    content: "hello",
    groupName: undefined,
    isGroup: false,
    msgId: "dm-1",
    raw: { source: "test" },
    senderId: "321",
    senderName: "Bob",
    threadId: "u-1",
    timestampMs: Date.now(),
    ...overrides,
  };
}

describe("zalouser monitor group mention gating", () => {
  beforeEach(() => {
    sendMessageZalouserMock.mockClear();
    sendTypingZalouserMock.mockClear();
    sendDeliveredZalouserMock.mockClear();
    sendSeenZalouserMock.mockClear();
  });

  async function processMessageWithDefaults(params: {
    message: ZaloInboundMessage;
    account?: ResolvedZalouserAccount;
    historyState?: {
      historyLimit: number;
      groupHistories: Map<
        string,
        { sender: string; body: string; timestamp?: number; messageId?: string }[]
      >;
    };
  }) {
    await __testing.processMessage({
      account: params.account ?? createAccount(),
      config: createConfig(),
      historyState: params.historyState,
      message: params.message,
      runtime: createZalouserRuntimeEnv(),
    });
  }

  async function expectSkippedGroupMessage(message?: Partial<ZaloInboundMessage>) {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await processMessageWithDefaults({
      message: createGroupMessage(message),
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendTypingZalouserMock).not.toHaveBeenCalled();
  }

  async function expectGroupCommandAuthorizers(params: {
    accountConfig: ResolvedZalouserAccount["config"];
    expectedAuthorizers: { configured: boolean; allowed: boolean }[];
  }) {
    const { dispatchReplyWithBufferedBlockDispatcher, resolveCommandAuthorizedFromAuthorizers } =
      installGroupCommandAuthRuntime();
    await processGroupControlCommand({
      account: {
        ...createAccount(),
        config: params.accountConfig,
      },
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const authCall = resolveCommandAuthorizedFromAuthorizers.mock.calls[0]?.[0];
    expect(authCall?.authorizers).toEqual(params.expectedAuthorizers);
  }

  async function processOpenDmMessage(params?: {
    message?: Partial<ZaloInboundMessage>;
    readSessionUpdatedAt?: (input?: {
      storePath: string;
      sessionKey: string;
    }) => number | undefined;
  }) {
    const runtime = installRuntime({
      commandAuthorized: false,
    });
    if (params?.readSessionUpdatedAt) {
      runtime.readSessionUpdatedAt.mockImplementation(params.readSessionUpdatedAt);
    }
    const account = createAccount();
    await processMessageWithDefaults({
      account: {
        ...account,
        config: {
          ...account.config,
          dmPolicy: "open",
        },
      },
      message: createDmMessage(params?.message),
    });
    return runtime;
  }

  async function expectDangerousNameMatching(params: {
    dangerouslyAllowNameMatching?: boolean;
    expectedDispatches: number;
  }) {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await processMessageWithDefaults({
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          ...(params.dangerouslyAllowNameMatching ? { dangerouslyAllowNameMatching: true } : {}),
          groupAllowFrom: ["*"],
          groupPolicy: "allowlist",
          groups: {
            "Trusted Team": { enabled: true },
            "group:g-trusted-001": { enabled: true },
          },
        },
      },
      message: createGroupMessage({
        content: "ping @bot",
        groupName: "Trusted Team",
        hasAnyMention: true,
        senderId: "666",
        threadId: "g-attacker-001",
        wasExplicitlyMentioned: true,
      }),
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(
      params.expectedDispatches,
    );
    return dispatchReplyWithBufferedBlockDispatcher;
  }

  async function dispatchGroupMessage(params: {
    commandAuthorized: boolean;
    message: Partial<ZaloInboundMessage>;
  }) {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: params.commandAuthorized,
    });
    await processMessageWithDefaults({
      message: createGroupMessage(params.message),
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    return dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
  }

  it("skips unmentioned group messages when requireMention=true", async () => {
    await expectSkippedGroupMessage();
  });

  it("blocks mentioned group messages by default when groupPolicy is omitted", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    const cfg: OpenClawConfig = {
      channels: {
        zalouser: {
          enabled: true,
        },
      },
    };
    const account = resolveZalouserAccountSync({ accountId: "default", cfg });

    await __testing.processMessage({
      account,
      config: cfg,
      message: createGroupMessage({
        content: "ping @bot",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
      }),
      runtime: createRuntimeEnv(),
    });

    expect(account.config.groupPolicy).toBe("allowlist");
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("fails closed when requireMention=true but mention detection is unavailable", async () => {
    await expectSkippedGroupMessage({
      canResolveExplicitMention: false,
      hasAnyMention: false,
      wasExplicitlyMentioned: false,
    });
  });

  it("dispatches explicitly-mentioned group messages and marks WasMentioned", async () => {
    const callArg = await dispatchGroupMessage({
      commandAuthorized: false,
      message: {
        content: "ping @bot",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
      },
    });
    expect(callArg?.ctx?.WasMentioned).toBe(true);
    expect(callArg?.ctx?.To).toBe("zalouser:group:g-1");
    expect(callArg?.ctx?.OriginatingTo).toBe("zalouser:group:g-1");
    expect(sendTypingZalouserMock).toHaveBeenCalledWith("g-1", {
      isGroup: true,
      profile: "default",
    });
  });

  it("allows authorized control commands to bypass mention gating", async () => {
    const callArg = await dispatchGroupMessage({
      commandAuthorized: true,
      message: {
        content: "/status",
        hasAnyMention: false,
        wasExplicitlyMentioned: false,
      },
    });
    expect(callArg?.ctx?.WasMentioned).toBe(true);
  });

  it("passes long markdown replies through once so formatting happens before chunking", async () => {
    const replyText = `**${"a".repeat(2501)}**`;
    installRuntime({
      commandAuthorized: false,
      replyPayload: { text: replyText },
    });

    await __testing.processMessage({
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          dmPolicy: "open",
        },
      },
      config: createConfig(),
      message: createDmMessage({
        content: "hello",
      }),
      runtime: createRuntimeEnv(),
    });

    expect(sendMessageZalouserMock).toHaveBeenCalledTimes(1);
    expect(sendMessageZalouserMock).toHaveBeenCalledWith(
      "u-1",
      replyText,
      expect.objectContaining({
        isGroup: false,
        profile: "default",
        textChunkLimit: 1200,
        textChunkMode: "length",
        textMode: "markdown",
      }),
    );
  });

  it("uses commandContent for mention-prefixed control commands", async () => {
    const callArg = await dispatchGroupMessage({
      commandAuthorized: true,
      message: {
        commandContent: "/new",
        content: "@Bot /new",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
      },
    });
    expect(callArg?.ctx?.CommandBody).toBe("/new");
    expect(callArg?.ctx?.BodyForCommands).toBe("/new");
  });

  it("allows group control commands when only allowFrom is configured", async () => {
    await expectGroupCommandAuthorizers({
      accountConfig: {
        ...createAccount().config,
        allowFrom: ["123"],
      },
      expectedAuthorizers: [
        { allowed: true, configured: true },
        { allowed: true, configured: true },
      ],
    });
  });

  it("blocks routed allowlist groups without an explicit group sender allowlist", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await __testing.processMessage({
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          allowFrom: ["123"],
          groupPolicy: "allowlist",
          groups: {
            "group:g-1": { enabled: true, requireMention: true },
          },
        },
      },
      config: createConfig(),
      message: createGroupMessage({
        content: "ping @bot",
        hasAnyMention: true,
        senderId: "456",
        wasExplicitlyMentioned: true,
      }),
      runtime: createRuntimeEnv(),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("blocks group messages when sender is not in groupAllowFrom", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await __testing.processMessage({
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          allowFrom: ["999"],
          groupAllowFrom: ["999"],
          groupPolicy: "allowlist",
        },
      },
      config: createConfig(),
      message: createGroupMessage({
        content: "ping @bot",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
      }),
      runtime: createRuntimeEnv(),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("does not accept a different group id by matching only the mutable group name by default", async () => {
    await expectDangerousNameMatching({ expectedDispatches: 0 });
  });

  it("accepts mutable group-name matches only when dangerouslyAllowNameMatching is enabled", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = await expectDangerousNameMatching({
      dangerouslyAllowNameMatching: true,
      expectedDispatches: 1,
    });
    const callArg = dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
    expect(callArg?.ctx?.To).toBe("zalouser:group:g-attacker-001");
  });

  it("allows group control commands when sender is in groupAllowFrom", async () => {
    await expectGroupCommandAuthorizers({
      accountConfig: {
        ...createAccount().config,
        allowFrom: ["999"],
        groupAllowFrom: ["123"],
      },
      expectedAuthorizers: [
        { allowed: false, configured: true },
        { allowed: true, configured: true },
      ],
    });
  });

  it("routes DM messages with direct peer kind", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher, resolveAgentRoute, buildAgentSessionKey } =
      await processOpenDmMessage();

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { id: "321", kind: "direct" },
      }),
    );
    expect(buildAgentSessionKey).toHaveBeenCalledWith(
      expect.objectContaining({
        dmScope: "per-channel-peer",
        peer: { id: "321", kind: "direct" },
      }),
    );
    const callArg = dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
    expect(callArg?.ctx?.SessionKey).toBe("agent:main:zalouser:direct:321");
  });

  it("reuses the legacy DM session key when only the old group-shaped session exists", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = await processOpenDmMessage({
      readSessionUpdatedAt: (input?: { storePath: string; sessionKey: string }) =>
        input?.sessionKey === "agent:main:zalouser:group:321" ? 123 : undefined,
    });

    const callArg = dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
    expect(callArg?.ctx?.SessionKey).toBe("agent:main:zalouser:group:321");
  });

  it("reads pairing store for open DM control commands", async () => {
    const { readAllowFromStore } = installRuntime({
      commandAuthorized: false,
    });
    const account = createAccount();
    await __testing.processMessage({
      account: {
        ...account,
        config: {
          ...account.config,
          dmPolicy: "open",
        },
      },
      config: createConfig(),
      message: createDmMessage({ commandContent: "/new", content: "/new" }),
      runtime: createRuntimeEnv(),
    });

    expect(readAllowFromStore).toHaveBeenCalledTimes(1);
  });

  it("skips pairing store read for open DM non-command messages", async () => {
    const { readAllowFromStore } = installRuntime({
      commandAuthorized: false,
    });
    const account = createAccount();
    await __testing.processMessage({
      account: {
        ...account,
        config: {
          ...account.config,
          dmPolicy: "open",
        },
      },
      config: createConfig(),
      message: createDmMessage({ content: "hello there" }),
      runtime: createRuntimeEnv(),
    });

    expect(readAllowFromStore).not.toHaveBeenCalled();
  });

  it("includes skipped group messages as InboundHistory on the next processed message", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    const historyState = {
      groupHistories: new Map<
        string,
        { sender: string; body: string; timestamp?: number; messageId?: string }[]
      >(),
      historyLimit: 5,
    };
    const account = createAccount();
    const config = createConfig();
    await __testing.processMessage({
      account,
      config,
      historyState,
      message: createGroupMessage({
        content: "first unmentioned line",
        hasAnyMention: false,
        wasExplicitlyMentioned: false,
      }),
      runtime: createRuntimeEnv(),
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    await __testing.processMessage({
      account,
      config,
      historyState,
      message: createGroupMessage({
        content: "second line @bot",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
      }),
      runtime: createRuntimeEnv(),
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const firstDispatch = dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
    expect(firstDispatch?.ctx?.InboundHistory).toEqual([
      expect.objectContaining({ body: "first unmentioned line", sender: "Alice" }),
    ]);
    expect(String(firstDispatch?.ctx?.Body ?? "")).toContain("first unmentioned line");

    await __testing.processMessage({
      account,
      config,
      historyState,
      message: createGroupMessage({
        content: "third line @bot",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
      }),
      runtime: createRuntimeEnv(),
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    const secondDispatch = dispatchReplyWithBufferedBlockDispatcher.mock.calls[1]?.[0];
    expect(secondDispatch?.ctx?.InboundHistory).toEqual([]);
  });
});
