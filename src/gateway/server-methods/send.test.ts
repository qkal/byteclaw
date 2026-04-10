import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { GatewayRequestContext } from "./types.js";

type ResolveOutboundTarget = typeof import("../../infra/outbound/targets.js").resolveOutboundTarget;

const mocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
  applyPluginAutoEnable: vi.fn(),
  deliverOutboundPayloads: vi.fn(),
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  getChannelPlugin: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
  resolveMessageChannelSelection: vi.fn(),
  resolveOutboundSessionRoute: vi.fn(),
  resolveOutboundTarget: vi.fn<ResolveOutboundTarget>(() => ({ ok: true, to: "resolved" })),
  sendPoll: vi.fn<
    () => Promise<{
      messageId: string;
      toJid?: string;
      channelId?: string;
      conversationId?: string;
      pollId?: string;
    }>
  >(async () => ({ messageId: "poll-1" })),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (value: string) => (value === "webchat" ? null : value),
}));

const TEST_AGENT_WORKSPACE = "/tmp/openclaw-test-workspace";
let sendHandlers: typeof import("./send.js").sendHandlers;

function resolveAgentIdFromSessionKeyForTests(params: { sessionKey?: string }): string {
  if (typeof params.sessionKey === "string") {
    const match = params.sessionKey.match(/^agent:([^:]+)/i);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "main";
}

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => TEST_AGENT_WORKSPACE,
  resolveDefaultAgentId: () => "main",
  resolveSessionAgentId: ({
    sessionKey,
  }: {
    sessionKey?: string;
    config?: unknown;
    agentId?: string;
  }) => resolveAgentIdFromSessionKeyForTests({ sessionKey }),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config, env }: { config: unknown; env?: unknown }) =>
    mocks.applyPluginAutoEnable({ config, env }),
}));

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
}));

vi.mock("../../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("../../infra/outbound/outbound-session.js", () => ({
  ensureOutboundSessionEntry: mocks.ensureOutboundSessionEntry,
  resolveOutboundSessionRoute: mocks.resolveOutboundSessionRoute,
}));

vi.mock("../../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: mocks.resolveMessageChannelSelection,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
    recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
  };
});

async function loadFreshSendHandlersForTest() {
  vi.resetModules();
  ({ sendHandlers } = await import("./send.js"));
}

const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
  }) as unknown as GatewayRequestContext;

async function runSend(params: Record<string, unknown>) {
  return await runSendWithClient(params);
}

async function runSendWithClient(
  params: Record<string, unknown>,
  client?: { connect?: { scopes?: string[] } } | null,
) {
  const respond = vi.fn();
  await sendHandlers.send({
    client: (client ?? null) as never,
    context: makeContext(),
    isWebchatConnect: () => false,
    params: params as never,
    req: { id: "1", method: "send", type: "req" },
    respond,
  });
  return { respond };
}

async function runPoll(params: Record<string, unknown>) {
  return await runPollWithClient(params);
}

async function runPollWithClient(
  params: Record<string, unknown>,
  client?: { connect?: { scopes?: string[] } } | null,
) {
  const respond = vi.fn();
  await sendHandlers.poll({
    client: (client ?? null) as never,
    context: makeContext(),
    isWebchatConnect: () => false,
    params: params as never,
    req: { id: "1", method: "poll", type: "req" },
    respond,
  });
  return { respond };
}

function expectDeliverySessionMirror(params: { agentId: string; sessionKey: string }) {
  expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
    expect.objectContaining({
      mirror: expect.objectContaining({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      }),
      session: expect.objectContaining({
        agentId: params.agentId,
        key: params.sessionKey,
      }),
    }),
  );
}

function mockDeliverySuccess(messageId: string) {
  mocks.deliverOutboundPayloads.mockResolvedValue([{ channel: "slack", messageId }]);
}

describe("gateway send mirroring", () => {
  let registrySeq = 0;

  beforeEach(async () => {
    vi.clearAllMocks();
    registrySeq += 1;
    setActivePluginRegistry(createTestRegistry([]), `send-test-${registrySeq}`);
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({
      autoEnabledReasons: {},
      changes: [],
      config,
    }));
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "resolved" });
    mocks.resolveOutboundSessionRoute.mockImplementation(
      async ({ agentId, channel }: { agentId?: string; channel?: string }) => ({
        sessionKey:
          channel === "slack"
            ? `agent:${agentId ?? "main"}:slack:channel:resolved`
            : `agent:${agentId ?? "main"}:${channel ?? "main"}:resolved`,
      }),
    );
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "slack",
      configured: ["slack"],
    });
    mocks.sendPoll.mockResolvedValue({ messageId: "poll-1" });
    mocks.getChannelPlugin.mockReturnValue({ outbound: { sendPoll: mocks.sendPoll } });
    await loadFreshSendHandlersForTest();
  });

  it("accepts media-only sends without message", async () => {
    mockDeliverySuccess("m-media");

    const { respond } = await runSend({
      channel: "slack",
      idempotencyKey: "idem-media-only",
      mediaUrl: "https://example.com/a.png",
      to: "channel:C1",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ mediaUrl: "https://example.com/a.png", mediaUrls: undefined, text: "" }],
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ messageId: "m-media" }),
      undefined,
      expect.objectContaining({ channel: "slack" }),
    );
  });

  it("forwards gateway client scopes into outbound delivery", async () => {
    mockDeliverySuccess("m-scope");

    await runSendWithClient(
      {
        channel: "slack",
        idempotencyKey: "idem-scope",
        message: "hi",
        to: "channel:C1",
      },
      { connect: { scopes: ["operator.write"] } },
    );

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        gatewayClientScopes: ["operator.write"],
      }),
    );
  });

  it("forwards an empty gateway scope array into outbound delivery", async () => {
    mockDeliverySuccess("m-empty-scope");

    await runSendWithClient(
      {
        channel: "slack",
        idempotencyKey: "idem-empty-scope",
        message: "hi",
        to: "channel:C1",
      },
      { connect: { scopes: [] } },
    );

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        gatewayClientScopes: [],
      }),
    );
  });

  it("rejects empty sends when neither text nor media is present", async () => {
    const { respond } = await runSend({
      channel: "slack",
      idempotencyKey: "idem-empty",
      message: "   ",
      to: "channel:C1",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("text or media is required"),
      }),
    );
  });

  it("returns actionable guidance when channel is internal webchat", async () => {
    const { respond } = await runSend({
      channel: "webchat",
      idempotencyKey: "idem-webchat",
      message: "hi",
      to: "x",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("unsupported channel: webchat"),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Use `chat.send`"),
      }),
    );
  });

  it("auto-picks the single configured channel for send", async () => {
    mockDeliverySuccess("m-single-send");

    const { respond } = await runSend({
      idempotencyKey: "idem-missing-channel",
      message: "hi",
      to: "x",
    });

    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ messageId: "m-single-send" }),
      undefined,
      expect.objectContaining({ channel: "slack" }),
    );
  });

  it("auto-picks the single configured channel from the auto-enabled config snapshot for send", async () => {
    const autoEnabledConfig = { channels: { slack: {} }, plugins: { allow: ["slack"] } };
    mocks.applyPluginAutoEnable.mockReturnValue({
      autoEnabledReasons: {},
      changes: [],
      config: autoEnabledConfig,
    });
    mockDeliverySuccess("m-single-send-auto");

    const { respond } = await runSend({
      idempotencyKey: "idem-missing-channel-auto-enabled",
      message: "hi",
      to: "x",
    });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledWith({
      cfg: autoEnabledConfig,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ messageId: "m-single-send-auto" }),
      undefined,
      expect.objectContaining({ channel: "slack" }),
    );
  });

  it("returns invalid request when send channel selection is ambiguous", async () => {
    mocks.resolveMessageChannelSelection.mockRejectedValueOnce(
      new Error("Channel is required when multiple channels are configured: telegram, slack"),
    );

    const { respond } = await runSend({
      idempotencyKey: "idem-missing-channel-ambiguous",
      message: "hi",
      to: "x",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Channel is required"),
      }),
    );
  });

  it("forwards gateway client scopes into outbound poll delivery", async () => {
    await runPollWithClient(
      {
        channel: "slack",
        idempotencyKey: "idem-poll-scope",
        options: ["A", "B"],
        question: "Q?",
        to: "channel:C1",
      },
      { connect: { scopes: ["operator.admin"] } },
    );

    expect(mocks.sendPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.any(Object),
        gatewayClientScopes: ["operator.admin"],
        to: "resolved",
      }),
    );
  });

  it("forwards an empty gateway scope array into outbound poll delivery", async () => {
    await runPollWithClient(
      {
        channel: "slack",
        idempotencyKey: "idem-poll-empty-scope",
        options: ["A", "B"],
        question: "Q?",
        to: "channel:C1",
      },
      { connect: { scopes: [] } },
    );

    expect(mocks.sendPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.any(Object),
        gatewayClientScopes: [],
        to: "resolved",
      }),
    );
  });

  it("includes optional poll delivery identifiers in the gateway payload", async () => {
    mocks.sendPoll.mockResolvedValue({
      channelId: "C123",
      conversationId: "conv-1",
      messageId: "poll-rich",
      pollId: "poll-meta-1",
      toJid: "jid-1",
    });

    const { respond } = await runPoll({
      channel: "slack",
      idempotencyKey: "idem-poll-rich",
      options: ["A", "B"],
      question: "Q?",
      to: "channel:C1",
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        channel: "slack",
        channelId: "C123",
        conversationId: "conv-1",
        messageId: "poll-rich",
        pollId: "poll-meta-1",
        runId: "idem-poll-rich",
        toJid: "jid-1",
      }),
      undefined,
      expect.objectContaining({ channel: "slack" }),
    );
  });

  it("auto-picks the single configured channel for poll", async () => {
    const { respond } = await runPoll({
      idempotencyKey: "idem-poll-missing-channel",
      options: ["A", "B"],
      question: "Q?",
      to: "x",
    });

    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined, {
      channel: "slack",
    });
  });

  it("returns invalid request when poll channel selection is ambiguous", async () => {
    mocks.resolveMessageChannelSelection.mockRejectedValueOnce(
      new Error("Channel is required when multiple channels are configured: telegram, slack"),
    );

    const { respond } = await runPoll({
      idempotencyKey: "idem-poll-missing-channel-ambiguous",
      options: ["A", "B"],
      question: "Q?",
      to: "x",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Channel is required"),
      }),
    );
  });

  it("does not mirror when delivery returns no results", async () => {
    mocks.deliverOutboundPayloads.mockResolvedValue([]);

    await runSend({
      channel: "slack",
      idempotencyKey: "idem-1",
      message: "hi",
      sessionKey: "agent:main:main",
      to: "channel:C1",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:main",
        }),
      }),
    );
  });

  it("mirrors media filenames when delivery succeeds", async () => {
    mockDeliverySuccess("m1");

    await runSend({
      channel: "slack",
      idempotencyKey: "idem-2",
      mediaUrl: "https://example.com/files/report.pdf?sig=1",
      message: "caption",
      sessionKey: "agent:main:main",
      to: "channel:C1",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          idempotencyKey: "idem-2",
          mediaUrls: ["https://example.com/files/report.pdf?sig=1"],
          sessionKey: "agent:main:main",
          text: "caption",
        }),
      }),
    );
  });

  it("mirrors MEDIA tags as attachments", async () => {
    mockDeliverySuccess("m2");

    await runSend({
      channel: "slack",
      idempotencyKey: "idem-3",
      message: "Here\nMEDIA:https://example.com/image.png",
      sessionKey: "agent:main:main",
      to: "channel:C1",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          mediaUrls: ["https://example.com/image.png"],
          sessionKey: "agent:main:main",
          text: "Here",
        }),
      }),
    );
  });

  it("lowercases provided session keys for mirroring", async () => {
    mockDeliverySuccess("m-lower");

    await runSend({
      channel: "slack",
      idempotencyKey: "idem-lower",
      message: "hi",
      sessionKey: "agent:main:slack:channel:C123",
      to: "channel:C1",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:slack:channel:c123",
        }),
      }),
    );
  });

  it("derives a target session key when none is provided", async () => {
    mockDeliverySuccess("m3");

    await runSend({
      channel: "slack",
      idempotencyKey: "idem-4",
      message: "hello",
      to: "channel:C1",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          agentId: "main",
          sessionKey: "agent:main:slack:channel:resolved",
        }),
      }),
    );
  });

  it("uses explicit agentId for delivery when sessionKey is not provided", async () => {
    mockDeliverySuccess("m-agent");

    await runSend({
      agentId: "work",
      channel: "slack",
      idempotencyKey: "idem-agent-explicit",
      message: "hello",
      to: "channel:C1",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          agentId: "work",
          sessionKey: "agent:work:slack:channel:resolved",
        }),
        session: expect.objectContaining({
          agentId: "work",
          key: "agent:work:slack:channel:resolved",
        }),
      }),
    );
  });

  it("uses sessionKey agentId when explicit agentId is omitted", async () => {
    mockDeliverySuccess("m-session-agent");

    await runSend({
      channel: "slack",
      idempotencyKey: "idem-session-agent",
      message: "hello",
      sessionKey: "agent:work:slack:channel:c1",
      to: "channel:C1",
    });

    expectDeliverySessionMirror({
      agentId: "work",
      sessionKey: "agent:work:slack:channel:c1",
    });
  });

  it("still resolves outbound routing metadata when a sessionKey is provided", async () => {
    mockDeliverySuccess("m-matrix-session-route");
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      baseSessionKey: "agent:main:matrix:channel:!dm:example.org",
      chatType: "direct",
      from: "matrix:@alice:example.org",
      peer: { id: "!dm:example.org", kind: "channel" },
      sessionKey: "agent:main:matrix:channel:!dm:example.org",
      to: "room:!dm:example.org",
    });

    await runSend({
      channel: "matrix",
      idempotencyKey: "idem-matrix-session-route",
      message: "hello",
      sessionKey: "agent:main:matrix:channel:!dm:example.org",
      to: "@alice:example.org",
    });

    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        currentSessionKey: "agent:main:matrix:channel:!dm:example.org",
        target: "resolved",
      }),
    );
    expect(mocks.ensureOutboundSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({
          baseSessionKey: "agent:main:matrix:channel:!dm:example.org",
          sessionKey: "agent:main:matrix:channel:!dm:example.org",
          to: "room:!dm:example.org",
        }),
      }),
    );
    expectDeliverySessionMirror({
      agentId: "main",
      sessionKey: "agent:main:matrix:channel:!dm:example.org",
    });
  });

  it("falls back to the provided sessionKey when outbound route lookup returns null", async () => {
    mockDeliverySuccess("m-session-fallback");
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(null);

    await runSend({
      channel: "slack",
      idempotencyKey: "idem-session-fallback",
      message: "hello",
      sessionKey: "agent:work:slack:channel:c1",
      to: "channel:C1",
    });

    expect(mocks.ensureOutboundSessionEntry).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          agentId: "work",
          sessionKey: "agent:work:slack:channel:c1",
        }),
        session: expect.objectContaining({
          agentId: "work",
          key: "agent:work:slack:channel:c1",
        }),
      }),
    );
  });

  it("prefers explicit agentId over sessionKey agent for delivery and mirror", async () => {
    mockDeliverySuccess("m-agent-precedence");

    await runSend({
      agentId: "work",
      channel: "slack",
      idempotencyKey: "idem-agent-precedence",
      message: "hello",
      sessionKey: "agent:main:slack:channel:c1",
      to: "channel:C1",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          agentId: "work",
          sessionKey: "agent:main:slack:channel:c1",
        }),
        session: expect.objectContaining({
          agentId: "work",
          key: "agent:main:slack:channel:c1",
        }),
      }),
    );
  });

  it("ignores blank explicit agentId and falls back to sessionKey agent", async () => {
    mockDeliverySuccess("m-agent-blank");

    await runSend({
      agentId: "   ",
      channel: "slack",
      idempotencyKey: "idem-agent-blank",
      message: "hello",
      sessionKey: "agent:work:slack:channel:c1",
      to: "channel:C1",
    });

    expectDeliverySessionMirror({
      agentId: "work",
      sessionKey: "agent:work:slack:channel:c1",
    });
  });

  it("forwards threadId to outbound delivery when provided", async () => {
    mockDeliverySuccess("m-thread");

    await runSend({
      channel: "slack",
      idempotencyKey: "idem-thread",
      message: "hi",
      threadId: "1710000000.9999",
      to: "channel:C1",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "1710000000.9999",
      }),
    );
  });

  it("returns invalid request when outbound target resolution fails", async () => {
    mocks.resolveOutboundTarget.mockReturnValue({
      error: new Error("target not found"),
      ok: false,
    });

    const { respond } = await runSend({
      channel: "slack",
      idempotencyKey: "idem-target-fail",
      message: "hi",
      to: "channel:C1",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("target not found"),
      }),
      expect.objectContaining({
        channel: "slack",
      }),
    );
  });

  it("recovers cold plugin resolution for threaded sends", async () => {
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "123" });
    mocks.deliverOutboundPayloads.mockResolvedValue([
      { channel: "slack", messageId: "m-threaded" },
    ]);
    const outboundPlugin = { outbound: { sendPoll: mocks.sendPoll } };
    mocks.getChannelPlugin
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(outboundPlugin)
      .mockReturnValue(outboundPlugin);

    const { respond } = await runSend({
      channel: "slack",
      idempotencyKey: "idem-cold-thread",
      message: "threaded completion",
      threadId: "1710000000.9999",
      to: "123",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        threadId: "1710000000.9999",
        to: "123",
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ messageId: "m-threaded" }),
      undefined,
      expect.objectContaining({ channel: "slack" }),
    );
  });
});
