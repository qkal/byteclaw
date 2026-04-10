import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const requireAcpRuntimeBackendMock = vi.fn();
  const getAcpRuntimeBackendMock = vi.fn();
  const listAcpSessionEntriesMock = vi.fn();
  const readAcpSessionEntryMock = vi.fn();
  const upsertAcpSessionMetaMock = vi.fn();
  const resolveSessionStorePathForAcpMock = vi.fn();
  const loadSessionStoreMock = vi.fn();
  const sessionBindingCapabilitiesMock = vi.fn();
  const sessionBindingBindMock = vi.fn();
  const sessionBindingListBySessionMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  const sessionBindingUnbindMock = vi.fn();
  const ensureSessionMock = vi.fn();
  const runTurnMock = vi.fn();
  const cancelMock = vi.fn();
  const closeMock = vi.fn();
  const getCapabilitiesMock = vi.fn();
  const getStatusMock = vi.fn();
  const setModeMock = vi.fn();
  const setConfigOptionMock = vi.fn();
  const doctorMock = vi.fn();
  return {
    callGatewayMock,
    cancelMock,
    closeMock,
    doctorMock,
    ensureSessionMock,
    getAcpRuntimeBackendMock,
    getCapabilitiesMock,
    getStatusMock,
    listAcpSessionEntriesMock,
    loadSessionStoreMock,
    readAcpSessionEntryMock,
    requireAcpRuntimeBackendMock,
    resolveSessionStorePathForAcpMock,
    runTurnMock,
    sessionBindingBindMock,
    sessionBindingCapabilitiesMock,
    sessionBindingListBySessionMock,
    sessionBindingResolveByConversationMock,
    sessionBindingUnbindMock,
    setConfigOptionMock,
    setModeMock,
    upsertAcpSessionMetaMock,
  };
});

function createAcpCommandSessionBindingService() {
  const forward =
    <A extends unknown[], T>(fn: (...args: A) => T) =>
    (...args: A) =>
      fn(...args);
  return {
    bind: (input: unknown) => hoisted.sessionBindingBindMock(input),
    getCapabilities: forward((params: unknown) => hoisted.sessionBindingCapabilitiesMock(params)),
    listBySession: (targetSessionKey: string) =>
      hoisted.sessionBindingListBySessionMock(targetSessionKey),
    resolveByConversation: (ref: unknown) => hoisted.sessionBindingResolveByConversationMock(ref),
    touch: vi.fn(),
    unbind: (input: unknown) => hoisted.sessionBindingUnbindMock(input),
  };
}

vi.mock("../../gateway/call.js", () => ({
  callGateway: (args: unknown) => hoisted.callGatewayMock(args),
}));

vi.mock("../../acp/runtime/registry.js", () => ({
  getAcpRuntimeBackend: (id?: string) => hoisted.getAcpRuntimeBackendMock(id),
  requireAcpRuntimeBackend: (id?: string) => hoisted.requireAcpRuntimeBackendMock(id),
}));

vi.mock("../../acp/runtime/session-meta.js", () => ({
  listAcpSessionEntries: (args: unknown) => hoisted.listAcpSessionEntriesMock(args),
  readAcpSessionEntry: (args: unknown) => hoisted.readAcpSessionEntryMock(args),
  resolveSessionStorePathForAcp: (args: unknown) => hoisted.resolveSessionStorePathForAcpMock(args),
  upsertAcpSessionMeta: (args: unknown) => hoisted.upsertAcpSessionMetaMock(args),
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    loadSessionStore: (...args: unknown[]) => hoisted.loadSessionStoreMock(...args),
  };
});

vi.mock("../../infra/outbound/session-binding-service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/session-binding-service.js")
  >("../../infra/outbound/session-binding-service.js");
  const patched = { ...actual } as typeof actual & {
    getSessionBindingService: () => ReturnType<typeof createAcpCommandSessionBindingService>;
  };
  patched.getSessionBindingService = () => createAcpCommandSessionBindingService();
  return patched;
});

const { handleAcpCommand } = await import("./commands-acp.js");
const { buildCommandTestParams } = await import("./commands-spawn.test-harness.js");
const { __testing: acpManagerTesting } = await import("../../acp/control-plane/manager.js");
const { __testing: acpResetTargetTesting, resolveEffectiveResetTargetSessionKey } =
  await import("./acp-reset-target.js");
const { createTaskRecord, resetTaskRegistryForTests } =
  await import("../../tasks/task-registry.js");
const { configureTaskRegistryRuntime } = await import("../../tasks/task-registry.store.js");
const { failTaskRunByRunId } = await import("../../tasks/task-executor.js");

function configureInMemoryTaskRegistryStoreForTests(): void {
  configureTaskRegistryRuntime({
    store: {
      close: () => {},
      deleteDeliveryState: () => {},
      deleteTask: () => {},
      deleteTaskWithDeliveryState: () => {},
      loadSnapshot: () => ({
        deliveryStates: new Map(),
        tasks: new Map(),
      }),
      saveSnapshot: () => {},
      upsertDeliveryState: () => {},
      upsertTask: () => {},
      upsertTaskWithDeliveryState: () => {},
    },
  });
}

function parseTelegramChatIdForTest(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^telegram:/i, "");
  if (!trimmed) {
    return undefined;
  }
  const topicMatch = /^(.*):topic:\d+$/i.exec(trimmed);
  return (topicMatch?.[1] ?? trimmed).trim() || undefined;
}

function parseDiscordConversationIdForTest(
  targets: (string | undefined | null)[],
): string | undefined {
  for (const rawTarget of targets) {
    const target = rawTarget?.trim();
    if (!target) {
      continue;
    }
    const mentionMatch = /^<#(\d+)>$/.exec(target);
    if (mentionMatch?.[1]) {
      return mentionMatch[1];
    }
    if (/^channel:/i.test(target)) {
      return target;
    }
  }
  return undefined;
}

function parseDiscordParentChannelFromSessionKeyForTest(raw?: string | null): string | undefined {
  const sessionKey = raw?.trim().toLowerCase() ?? "";
  const match = sessionKey.match(/(?:^|:)channel:([^:]+)$/);
  return match?.[1] ? `channel:${match[1]}` : undefined;
}

function setMinimalAcpCommandRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          bindings: {
            resolveCommandConversation: ({
              threadId,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const chatId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => parseTelegramChatIdForTest(candidate))
                .find(Boolean);
              if (!chatId) {
                return null;
              }
              if (threadId) {
                return {
                  conversationId: `${chatId}:topic:${threadId}`,
                  parentConversationId: chatId,
                };
              }
              if (chatId.startsWith("-")) {
                return null;
              }
              return { conversationId: chatId, parentConversationId: chatId };
            },
          },
          conversationBindings: {
            buildBoundReplyChannelData: ({
              operation,
              conversation,
            }: {
              operation: "acp-spawn";
              conversation: { conversationId: string };
            }) =>
              operation === "acp-spawn" && conversation.conversationId.includes(":topic:")
                ? { telegram: { pin: true } }
                : null,
            defaultTopLevelPlacement: "current",
          },
        },
        pluginId: "telegram",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "discord", label: "Discord" }),
          bindings: {
            resolveCommandConversation: ({
              threadId,
              threadParentId,
              parentSessionKey,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              threadParentId?: string;
              parentSessionKey?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              if (threadId) {
                const parentConversationId =
                  (threadParentId?.trim()
                    ? `channel:${threadParentId.trim().replace(/^channel:/i, "")}`
                    : undefined) ??
                  parseDiscordParentChannelFromSessionKeyForTest(parentSessionKey) ??
                  parseDiscordConversationIdForTest([originatingTo, commandTo, fallbackTo]);
                return {
                  conversationId: threadId,
                  ...(parentConversationId && parentConversationId !== threadId
                    ? { parentConversationId }
                    : {}),
                };
              }
              const conversationId = parseDiscordConversationIdForTest([
                originatingTo,
                commandTo,
                fallbackTo,
              ]);
              return conversationId ? { conversationId } : null;
            },
          },
          conversationBindings: {
            defaultTopLevelPlacement: "child",
          },
        },
        pluginId: "discord",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim())
                .find((candidate) => candidate && candidate.length > 0);
              return conversationId ? { conversationId } : null;
            },
          },
        },
        pluginId: "slack",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
          bindings: {
            resolveCommandConversation: ({
              threadId,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const roomId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim().replace(/^room:/i, ""))
                .find((candidate) => candidate && candidate.length > 0);
              if (!threadId || !roomId) {
                return null;
              }
              return {
                conversationId: threadId,
                parentConversationId: roomId,
              };
            },
          },
          conversationBindings: {
            defaultTopLevelPlacement: "child",
          },
        },
        pluginId: "matrix",
        source: "test",
      },
    ]),
  );
}

interface FakeBinding {
  bindingId: string;
  targetSessionKey: string;
  targetKind: "subagent" | "session";
  conversation: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  };
  status: "active";
  boundAt: number;
  metadata?: {
    agentId?: string;
    label?: string;
    boundBy?: string;
    webhookId?: string;
  };
}

function createSessionBinding(overrides?: Partial<FakeBinding>): FakeBinding {
  return {
    bindingId: "default:thread-created",
    boundAt: Date.now(),
    conversation: {
      accountId: "default",
      channel: "discord",
      conversationId: "thread-created",
      parentConversationId: "parent-1",
    },
    metadata: {
      agentId: "codex",
      boundBy: "user-1",
    },
    status: "active",
    targetKind: "session",
    targetSessionKey: "agent:codex:acp:s1",
    ...overrides,
  };
}

const baseCfg = {
  acp: {
    backend: "acpx",
    dispatch: { enabled: true },
    enabled: true,
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        spawnAcpSessions: true,
      },
    },
  },
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function createDiscordParams(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = buildCommandTestParams(commandBody, cfg, {
    AccountId: "default",
    OriginatingChannel: "discord",
    OriginatingTo: "channel:parent-1",
    Provider: "discord",
    Surface: "discord",
  });
  params.command.senderId = "user-1";
  return params;
}

const defaultAcpSessionKey = "agent:codex:acp:s1";
const defaultThreadId = "thread-1";

interface AcpSessionIdentity {
  state: "resolved";
  source: "status";
  acpxSessionId: string;
  agentSessionId: string;
  lastUpdatedAt: number;
}

function createThreadConversation(conversationId: string = defaultThreadId) {
  return {
    accountId: "default",
    channel: "discord" as const,
    conversationId,
    parentConversationId: "parent-1",
  };
}

function createBoundThreadSession(sessionKey: string = defaultAcpSessionKey) {
  return createSessionBinding({
    conversation: createThreadConversation(),
    targetSessionKey: sessionKey,
  });
}

function createAcpSessionEntry(options?: {
  sessionKey?: string;
  state?: "idle" | "running";
  identity?: AcpSessionIdentity;
}) {
  const sessionKey = options?.sessionKey ?? defaultAcpSessionKey;
  return {
    acp: {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime-1",
      ...(options?.identity ? { identity: options.identity } : {}),
      mode: "persistent",
      state: options?.state ?? "idle",
      lastActivityAt: Date.now(),
    },
    sessionKey,
    storeSessionKey: sessionKey,
  };
}

function createSessionBindingCapabilities() {
  return {
    adapterAvailable: true,
    bindSupported: true,
    placements: ["current", "child"] as const,
    unbindSupported: true,
  };
}

interface AcpBindInput {
  targetSessionKey: string;
  conversation: {
    channel?: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  };
  placement: "current" | "child";
  metadata?: Record<string, unknown>;
}

function createAcpThreadBinding(input: AcpBindInput): FakeBinding {
  const nextConversationId =
    input.placement === "child" ? "thread-created" : input.conversation.conversationId;
  const boundBy = typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "user-1";
  const channel = input.conversation.channel ?? "discord";
  const nextParentConversationId =
    input.placement === "child"
      ? input.conversation.conversationId
      : input.conversation.parentConversationId;
  const conversation = {
    accountId: input.conversation.accountId,
    channel,
    conversationId: nextConversationId,
    ...(nextParentConversationId ? { parentConversationId: nextParentConversationId } : {}),
  };
  return createSessionBinding({
    conversation,
    metadata: { boundBy, webhookId: "wh-1" },
    targetSessionKey: input.targetSessionKey,
  });
}

function expectBoundIntroTextToExclude(match: string): void {
  const calls = hoisted.sessionBindingBindMock.mock.calls as [
    { metadata?: { introText?: unknown } },
  ][];
  const introText = calls
    .map((call) => call[0]?.metadata?.introText)
    .find((value): value is string => typeof value === "string");
  expect((introText ?? "").includes(match)).toBe(false);
}

function mockBoundThreadSession(options?: {
  sessionKey?: string;
  state?: "idle" | "running";
  identity?: AcpSessionIdentity;
}) {
  const sessionKey = options?.sessionKey ?? defaultAcpSessionKey;
  hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
    createBoundThreadSession(sessionKey),
  );
  hoisted.readAcpSessionEntryMock.mockReturnValue(
    createAcpSessionEntry({
      identity: options?.identity,
      sessionKey,
      state: options?.state,
    }),
  );
}

function createThreadParams(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = createDiscordParams(commandBody, cfg);
  params.ctx.MessageThreadId = defaultThreadId;
  return params;
}

interface ConversationCommandFixture {
  accountId?: string;
  channel: string;
  originatingTo: string;
  senderId?: string;
  sessionKey?: string;
  threadId?: string;
  threadParentId?: string;
}

function createConversationParams(
  commandBody: string,
  fixture: ConversationCommandFixture,
  cfg: OpenClawConfig = baseCfg,
) {
  const params = buildCommandTestParams(commandBody, cfg, {
    AccountId: fixture.accountId ?? "default",
    OriginatingChannel: fixture.channel,
    OriginatingTo: fixture.originatingTo,
    Provider: fixture.channel,
    Surface: fixture.channel,
    ...(fixture.senderId ? { SenderId: fixture.senderId } : {}),
    ...(fixture.sessionKey ? { SessionKey: fixture.sessionKey } : {}),
    ...(fixture.threadId ? { MessageThreadId: fixture.threadId } : {}),
    ...(fixture.threadParentId ? { ThreadParentId: fixture.threadParentId } : {}),
  });
  params.command.senderId = fixture.senderId ?? "user-1";
  return params;
}

async function runDiscordAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(createDiscordParams(commandBody, cfg), true);
}

async function runThreadAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(createThreadParams(commandBody, cfg), true);
}

async function runTelegramAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "telegram",
        originatingTo: "telegram:-1003841603622",
        threadId: "498",
      },
      cfg,
    ),
    true,
  );
}

async function runTelegramDmAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "telegram",
        originatingTo: "telegram:123456789",
      },
      cfg,
    ),
    true,
  );
}

async function runSlackDmAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "slack",
        originatingTo: "user:U123",
        senderId: "U123",
      },
      cfg,
    ),
    true,
  );
}

function createMatrixThreadParams(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = createConversationParams(
    commandBody,
    {
      channel: "matrix",
      originatingTo: "room:!room:example.org",
    },
    cfg,
  );
  params.ctx.MessageThreadId = "$thread-root";
  return params;
}

async function runMatrixAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "matrix",
        originatingTo: "room:!room:example.org",
      },
      cfg,
    ),
    true,
  );
}

async function runMatrixThreadAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(createMatrixThreadParams(commandBody, cfg), true);
}

async function runFeishuDmAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "feishu",
        originatingTo: "user:ou_sender_1",
        senderId: "ou_sender_1",
      },
      cfg,
    ),
    true,
  );
}

async function runLineDmAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "line",
        originatingTo: "U1234567890abcdef1234567890abcdef",
        senderId: "U1234567890abcdef1234567890abcdef",
      },
      cfg,
    ),
    true,
  );
}

async function runBlueBubblesDmAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "bluebubbles",
        originatingTo: "bluebubbles:+15555550123",
      },
      cfg,
    ),
    true,
  );
}

async function runIMessageDmAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "imessage",
        originatingTo: "imessage:+15555550123",
      },
      cfg,
    ),
    true,
  );
}

async function runInternalAcpCommand(params: {
  commandBody: string;
  scopes: string[];
  cfg?: OpenClawConfig;
}) {
  const commandParams = buildCommandTestParams(params.commandBody, params.cfg ?? baseCfg, {
    GatewayClientScopes: params.scopes,
    OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
    OriginatingTo: "webchat:conversation-1",
    Provider: INTERNAL_MESSAGE_CHANNEL,
    Surface: INTERNAL_MESSAGE_CHANNEL,
  });
  commandParams.command.channel = INTERNAL_MESSAGE_CHANNEL;
  commandParams.command.senderId = "user-1";
  commandParams.command.senderIsOwner = true;
  return handleAcpCommand(commandParams, true);
}

describe("/acp command", () => {
  beforeEach(() => {
    setMinimalAcpCommandRegistryForTests();
    acpManagerTesting.resetAcpSessionManagerForTests();
    resetTaskRegistryForTests({ persist: false });
    configureInMemoryTaskRegistryStoreForTests();
    acpResetTargetTesting.setDepsForTest({
      getSessionBindingService: () => createAcpCommandSessionBindingService() as never,
    });
    hoisted.listAcpSessionEntriesMock.mockReset().mockResolvedValue([]);
    hoisted.callGatewayMock.mockReset().mockResolvedValue({ ok: true });
    hoisted.readAcpSessionEntryMock.mockReset().mockReturnValue(null);
    hoisted.upsertAcpSessionMetaMock.mockReset().mockResolvedValue({
      acp: {
        agent: "codex",
        backend: "acpx",
        lastActivityAt: Date.now(),
        mode: "persistent",
        runtimeSessionName: "run-1",
        state: "idle",
      },
      sessionId: "session-1",
      updatedAt: Date.now(),
    });
    hoisted.resolveSessionStorePathForAcpMock.mockReset().mockReturnValue({
      cfg: baseCfg,
      storePath: "/tmp/sessions-acp.json",
    });
    hoisted.loadSessionStoreMock.mockReset().mockReturnValue({});
    hoisted.sessionBindingCapabilitiesMock
      .mockReset()
      .mockReturnValue(createSessionBindingCapabilities());
    hoisted.sessionBindingBindMock
      .mockReset()
      .mockImplementation(async (input: AcpBindInput) => createAcpThreadBinding(input));
    hoisted.sessionBindingListBySessionMock.mockReset().mockReturnValue([]);
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingUnbindMock.mockReset().mockResolvedValue([]);

    hoisted.ensureSessionMock
      .mockReset()
      .mockImplementation(async (input: { sessionKey: string }) => ({
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:runtime`,
        sessionKey: input.sessionKey,
      }));
    hoisted.runTurnMock.mockReset().mockImplementation(async function* () {
      yield { type: "done" };
    });
    hoisted.cancelMock.mockReset().mockResolvedValue(undefined);
    hoisted.closeMock.mockReset().mockResolvedValue(undefined);
    hoisted.getCapabilitiesMock.mockReset().mockResolvedValue({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
    });
    hoisted.getStatusMock.mockReset().mockResolvedValue({
      details: { pid: 1234, sessionId: "sid-1", status: "alive" },
      summary: "status=alive sessionId=sid-1 pid=1234",
    });
    hoisted.setModeMock.mockReset().mockResolvedValue(undefined);
    hoisted.setConfigOptionMock.mockReset().mockResolvedValue(undefined);
    hoisted.doctorMock.mockReset().mockResolvedValue({
      message: "acpx command available",
      ok: true,
    });

    const runtimeBackend = {
      id: "acpx",
      runtime: {
        cancel: hoisted.cancelMock,
        close: hoisted.closeMock,
        doctor: hoisted.doctorMock,
        ensureSession: hoisted.ensureSessionMock,
        getCapabilities: hoisted.getCapabilitiesMock,
        getStatus: hoisted.getStatusMock,
        runTurn: hoisted.runTurnMock,
        setConfigOption: hoisted.setConfigOptionMock,
        setMode: hoisted.setModeMock,
      },
    };
    hoisted.requireAcpRuntimeBackendMock.mockReset().mockReturnValue(runtimeBackend);
    hoisted.getAcpRuntimeBackendMock.mockReset().mockReturnValue(runtimeBackend);
    acpManagerTesting.setAcpSessionManagerForTests({
      cancelSession: async (input: unknown) => {
        await hoisted.cancelMock(input);
      },
      closeSession: async (input: { clearMeta?: boolean; sessionKey: string }) => {
        await hoisted.closeMock(input);
        if (input.clearMeta === true) {
          await hoisted.upsertAcpSessionMetaMock({
            mutate: () => null,
            sessionKey: input.sessionKey,
          });
        }
        return {
          metaCleared: input.clearMeta === true,
          runtimeClosed: true,
        };
      },
      getObservabilitySnapshot: () => ({
        errorsByCode: {},
        runtimeCache: { activeSessions: 0, evictedTotal: 0, idleTtlMs: 0 },
        turns: {
          active: 0,
          averageLatencyMs: 0,
          completed: 0,
          failed: 0,
          maxLatencyMs: 0,
          queueDepth: 0,
        },
      }),
      getSessionStatus: async (input: { sessionKey: string }) => {
        const status = await hoisted.getStatusMock(input);
        const entry = hoisted.readAcpSessionEntryMock({
          sessionKey: input.sessionKey,
        }) as { acp?: Record<string, unknown> } | null;
        const meta = entry?.acp ?? {};
        return {
          agent: typeof meta.agent === "string" ? meta.agent : "codex",
          backend: typeof meta.backend === "string" ? meta.backend : "acpx",
          capabilities: {
            controls: ["session/set_mode", "session/set_config_option", "session/status"],
          },
          identity: meta.identity,
          lastActivityAt:
            typeof meta.lastActivityAt === "number" ? meta.lastActivityAt : Date.now(),
          mode: meta.mode ?? "persistent",
          runtimeOptions: meta.runtimeOptions ?? {},
          runtimeStatus: status,
          sessionKey: input.sessionKey,
          state: meta.state ?? "idle",
          ...(typeof meta.lastError === "string" ? { lastError: meta.lastError } : {}),
        };
      },
      initializeSession: async (input: {
        sessionKey: string;
        agent: string;
        mode: "persistent" | "oneshot";
        cwd?: string;
      }) => {
        const backend = hoisted.requireAcpRuntimeBackendMock("acpx") as {
          id?: string;
          runtime: typeof runtimeBackend.runtime;
        };
        const ensured = await hoisted.ensureSessionMock({
          agent: input.agent,
          cwd: input.cwd,
          mode: input.mode,
          sessionKey: input.sessionKey,
        });
        const now = Date.now();
        const meta = {
          agent: input.agent,
          backend: ensured.backend ?? "acpx",
          lastActivityAt: now,
          mode: input.mode,
          runtimeSessionName: ensured.runtimeSessionName ?? `${input.sessionKey}:runtime`,
          state: "idle" as const,
          ...(input.cwd ? { cwd: input.cwd, runtimeOptions: { cwd: input.cwd } } : {}),
          ...(typeof ensured.agentSessionId === "string" ||
          typeof ensured.backendSessionId === "string"
            ? {
                identity: {
                  acpxSessionId:
                    typeof ensured.backendSessionId === "string"
                      ? ensured.backendSessionId
                      : "acpx-1",
                  agentSessionId:
                    typeof ensured.agentSessionId === "string"
                      ? ensured.agentSessionId
                      : input.sessionKey,
                  lastUpdatedAt: now,
                  source: "status" as const,
                  state: "resolved" as const,
                },
              }
            : {}),
        };
        await hoisted.upsertAcpSessionMetaMock({
          mutate: () => meta,
          sessionKey: input.sessionKey,
        });
        return {
          handle: {
            backend: meta.backend,
            runtimeSessionName: meta.runtimeSessionName,
          },
          meta,
          runtime: backend.runtime,
        };
      },
      resolveSession: (input: { sessionKey: string }) => {
        const entry = hoisted.readAcpSessionEntryMock({
          sessionKey: input.sessionKey,
        }) as { acp?: Record<string, unknown> } | null;
        const meta =
          entry?.acp ??
          ({
            agent: "codex",
            backend: "acpx",
            lastActivityAt: Date.now(),
            mode: "persistent",
            runtimeSessionName: `${input.sessionKey}:runtime`,
            state: "idle",
          } as const);
        return {
          kind: "ready" as const,
          meta,
          sessionKey: input.sessionKey,
        };
      },
      runTurn: async (input: { onEvent?: (event: unknown) => Promise<void> | void }) => {
        for await (const event of hoisted.runTurnMock(input) as AsyncIterable<unknown>) {
          await input.onEvent?.(event);
        }
      },
      setSessionConfigOption: async (input: { key: string; value: string }) => {
        await hoisted.setConfigOptionMock(input);
        return { [input.key]: input.value };
      },
      setSessionRuntimeMode: async (input: { sessionKey: string; runtimeMode: string }) => {
        await hoisted.setModeMock(input);
        return { mode: input.runtimeMode };
      },
      updateSessionRuntimeOptions: async (input: { patch: Record<string, unknown> }) => input.patch,
    });
  });

  afterEach(() => {
    resetTaskRegistryForTests({ persist: false });
  });

  it("returns null when the message is not /acp", async () => {
    const result = await runDiscordAcpCommand("/status");
    expect(result).toBeNull();
  });

  it("shows help by default", async () => {
    const result = await runDiscordAcpCommand("/acp");
    expect(result?.reply?.text).toContain("ACP commands:");
    expect(result?.reply?.text).toContain("/acp spawn");
  });

  it("spawns an ACP session and binds a Discord thread", async () => {
    hoisted.ensureSessionMock.mockResolvedValueOnce({
      agentSessionId: "codex-inner-1",
      backend: "acpx",
      backendSessionId: "acpx-1",
      runtimeSessionName: "agent:codex:acp:s1:runtime",
      sessionKey: "agent:codex:acp:s1",
    });

    const result = await runDiscordAcpCommand("/acp spawn codex --cwd /home/bob/clawd");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Created thread thread-created and bound it");
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("acpx");
    expect(hoisted.ensureSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        cwd: "/home/bob/clawd",
        mode: "persistent",
      }),
    );
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          introText: expect.stringContaining("cwd: /home/bob/clawd"),
        }),
        placement: "child",
        targetKind: "session",
      }),
    );
    expectBoundIntroTextToExclude("session ids: pending (available after the first reply)");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.patch",
      }),
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalled();
    const upsertArgs = hoisted.upsertAcpSessionMetaMock.mock.calls[0]?.[0] as
      | {
          sessionKey: string;
          mutate: (
            current: unknown,
            entry: { sessionId: string; updatedAt: number } | undefined,
          ) => {
            backend?: string;
            runtimeSessionName?: string;
          };
        }
      | undefined;
    expect(upsertArgs?.sessionKey).toMatch(/^agent:codex:acp:/);
    const seededWithoutEntry = upsertArgs?.mutate(undefined, undefined);
    expect(seededWithoutEntry?.backend).toBe("acpx");
    expect(seededWithoutEntry?.runtimeSessionName).toContain(":runtime");
  });

  it("persists ACP spawn labels without a nested gateway self-call", async () => {
    const params = createDiscordParams("/acp spawn codex --bind here --label inbox");

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.patch",
      }),
    );
  });

  it("accepts unicode dash option prefixes in /acp spawn args", async () => {
    const result = await runThreadAcpCommand(
      "/acp spawn codex \u2014mode oneshot \u2014thread here \u2014cwd /home/bob/clawd \u2014label jeerreview",
    );

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this thread to");
    expect(hoisted.ensureSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        cwd: "/home/bob/clawd",
        mode: "oneshot",
      }),
    );
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          label: "jeerreview",
        }),
        placement: "current",
      }),
    );
  });

  it("binds the current Discord channel with --bind here without creating a child thread", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        discord: {
          threadBindings: {
            enabled: true,
            spawnAcpSessions: false,
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runDiscordAcpCommand("/acp spawn codex --bind here", cfg);

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          accountId: "default",
          channel: "discord",
          conversationId: "channel:parent-1",
        }),
        placement: "current",
      }),
    );
  });

  it("binds BlueBubbles DMs with --bind here", async () => {
    const result = await runBlueBubblesDmAcpCommand("/acp spawn codex --bind here");

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          accountId: "default",
          channel: "bluebubbles",
          conversationId: "+15555550123",
        }),
        placement: "current",
      }),
    );
  });

  it("binds Slack DMs with --bind here through the generic conversation path", async () => {
    const result = await runSlackDmAcpCommand("/acp spawn codex --bind here");

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          accountId: "default",
          channel: "slack",
          conversationId: "user:U123",
        }),
        placement: "current",
      }),
    );
  });

  it("binds iMessage DMs with --bind here", async () => {
    const result = await runIMessageDmAcpCommand("/acp spawn codex --bind here");

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          accountId: "default",
          channel: "imessage",
          conversationId: "+15555550123",
        }),
        placement: "current",
      }),
    );
  });

  it("binds Telegram topic ACP spawns to full conversation ids", async () => {
    const result = await runTelegramAcpCommand("/acp spawn codex --thread here");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this conversation to");
    expect(result?.reply?.channelData).toEqual({ telegram: { pin: true } });
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          accountId: "default",
          channel: "telegram",
          conversationId: "-1003841603622:topic:498",
        }),
        placement: "current",
      }),
    );
  });

  it("binds Telegram DM ACP spawns to the DM conversation id", async () => {
    const result = await runTelegramDmAcpCommand("/acp spawn codex --thread here");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this conversation to");
    expect(result?.reply?.channelData).toBeUndefined();
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          accountId: "default",
          channel: "telegram",
          conversationId: "123456789",
        }),
        placement: "current",
      }),
    );
  });

  it("binds Matrix rooms with --bind here without requiring thread spawn", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        matrix: {
          threadBindings: {
            enabled: true,
            spawnAcpSessions: false,
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runMatrixAcpCommand("/acp spawn codex --bind here", cfg);

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          accountId: "default",
          channel: "matrix",
          conversationId: "room:!room:example.org",
        }),
        placement: "current",
      }),
    );
  });

  it("creates Matrix thread-bound ACP spawns from top-level rooms when enabled", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        matrix: {
          threadBindings: {
            enabled: true,
            spawnAcpSessions: true,
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runMatrixAcpCommand("/acp spawn codex", cfg);

    expect(result?.reply?.text).toContain("Created thread thread-created and bound it");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          accountId: "default",
          channel: "matrix",
          conversationId: "room:!room:example.org",
        }),
        placement: "child",
      }),
    );
  });

  it("binds Matrix thread ACP spawns to the current thread with the parent room id", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        matrix: {
          threadBindings: {
            enabled: true,
            spawnAcpSessions: true,
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runMatrixThreadAcpCommand("/acp spawn codex --thread here", cfg);

    expect(result?.reply?.text).toContain("Bound this thread to");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          accountId: "default",
          channel: "matrix",
          conversationId: "$thread-root",
          parentConversationId: "!room:example.org",
        }),
        placement: "current",
      }),
    );
  });

  it("binds Feishu DM ACP spawns to the current DM conversation", async () => {
    const result = await runFeishuDmAcpCommand("/acp spawn codex --thread here");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this conversation to");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          accountId: "default",
          channel: "feishu",
          conversationId: "user:ou_sender_1",
        }),
        placement: "current",
      }),
    );
  });

  it("binds LINE DM ACP spawns to the current conversation", async () => {
    const result = await runLineDmAcpCommand("/acp spawn codex --thread here");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this conversation to");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          accountId: "default",
          channel: "line",
          conversationId: "U1234567890abcdef1234567890abcdef",
        }),
        placement: "current",
      }),
    );
  });

  it("requires explicit ACP target when acp.defaultAgent is not configured", async () => {
    const result = await runDiscordAcpCommand("/acp spawn");

    expect(result?.reply?.text).toContain("ACP target harness id is required");
    expect(hoisted.ensureSessionMock).not.toHaveBeenCalled();
  });

  it("rejects mixing --thread and --bind on the same /acp spawn", async () => {
    const result = await runDiscordAcpCommand("/acp spawn codex --thread here --bind here");

    expect(result?.reply?.text).toContain("Use either --thread or --bind");
    expect(hoisted.ensureSessionMock).not.toHaveBeenCalled();
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it("rejects thread-bound ACP spawn when spawnAcpSessions is disabled", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        discord: {
          threadBindings: {
            enabled: true,
            spawnAcpSessions: false,
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runDiscordAcpCommand("/acp spawn codex", cfg);

    expect(result?.reply?.text).toContain("spawnAcpSessions=true");
    expect(hoisted.closeMock).toHaveBeenCalledTimes(2);
    expect(hoisted.callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.delete" }),
    );
    expect(hoisted.callGatewayMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.patch" }),
    );
  });

  it("rejects Matrix thread-bound ACP spawn when spawnAcpSessions is unset", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        matrix: {
          threadBindings: {
            enabled: true,
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runMatrixAcpCommand("/acp spawn codex", cfg);

    expect(result?.reply?.text).toContain("spawnAcpSessions=true");
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it("forbids /acp spawn from sandboxed requester sessions", async () => {
    const cfg = {
      ...baseCfg,
      agents: {
        defaults: {
          sandbox: { mode: "all" },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runDiscordAcpCommand("/acp spawn codex", cfg);

    expect(result?.reply?.text).toContain("Sandboxed sessions cannot spawn ACP sessions");
    expect(hoisted.requireAcpRuntimeBackendMock).not.toHaveBeenCalled();
    expect(hoisted.ensureSessionMock).not.toHaveBeenCalled();
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("cancels the ACP session bound to the current thread", async () => {
    mockBoundThreadSession({ state: "running" });
    const result = await runThreadAcpCommand("/acp cancel", baseCfg);
    expect(result?.reply?.text).toContain(
      `Cancel requested for ACP session ${defaultAcpSessionKey}`,
    );
    expect(hoisted.cancelMock).toHaveBeenCalledWith({
      cfg: baseCfg,
      reason: "manual-cancel",
      sessionKey: defaultAcpSessionKey,
    });
  });

  it("sends steer instructions via ACP runtime", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return { key: defaultAcpSessionKey };
      }
      return { ok: true };
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());
    hoisted.runTurnMock.mockImplementation(async function* () {
      yield { text: "Applied steering.", type: "text_delta" };
      yield { type: "done" };
    });

    const result = await runDiscordAcpCommand(
      `/acp steer --session ${defaultAcpSessionKey} tighten logging`,
    );

    expect(hoisted.runTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "steer",
        text: "tighten logging",
      }),
    );
    expect(result?.reply?.text).toContain("Applied steering.");
  });

  it("resolves bound Telegram topic ACP sessions for /acp steer without explicit target", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockImplementation(
      (ref: { channel?: string; accountId?: string; conversationId?: string }) =>
        ref.channel === "telegram" &&
        ref.accountId === "default" &&
        ref.conversationId === "-1003841603622:topic:498"
          ? createSessionBinding({
              conversation: {
                accountId: "default",
                channel: "telegram",
                conversationId: "-1003841603622:topic:498",
              },
              targetSessionKey: defaultAcpSessionKey,
            })
          : null,
    );
    hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());
    hoisted.runTurnMock.mockImplementation(async function* () {
      yield { text: "Viewed diver package.", type: "text_delta" };
      yield { type: "done" };
    });

    const result = await runTelegramAcpCommand("/acp steer use npm to view package diver");

    expect(hoisted.runTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: baseCfg,
        mode: "steer",
        sessionKey: defaultAcpSessionKey,
        text: "use npm to view package diver",
      }),
    );
    expect(result?.reply?.text).toContain("Viewed diver package.");
  });

  it("resolves ACP reset targets through the configured default account when AccountId is omitted", () => {
    const cfg = {
      ...baseCfg,
      channels: {
        ...baseCfg.channels,
        discord: {
          ...baseCfg.channels.discord,
          defaultAccount: "work",
        },
      },
    } satisfies OpenClawConfig;
    hoisted.sessionBindingResolveByConversationMock.mockImplementation(
      (ref: {
        channel?: string;
        accountId?: string;
        conversationId?: string;
        parentConversationId?: string;
      }) =>
        ref.channel === "discord" &&
        ref.accountId === "work" &&
        ref.conversationId === defaultThreadId &&
        ref.parentConversationId === "parent-1"
          ? createSessionBinding({
              conversation: {
                accountId: "work",
                channel: "discord",
                conversationId: defaultThreadId,
                parentConversationId: "parent-1",
              },
              targetSessionKey: defaultAcpSessionKey,
            })
          : null,
    );

    const result = resolveEffectiveResetTargetSessionKey({
      cfg,
      channel: "discord",
      conversationId: defaultThreadId,
      parentConversationId: "parent-1",
    });

    expect(hoisted.sessionBindingResolveByConversationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        channel: "discord",
        conversationId: defaultThreadId,
        parentConversationId: "parent-1",
      }),
    );
    expect(result).toBe(defaultAcpSessionKey);
  });

  it("blocks /acp steer when ACP dispatch is disabled by policy", async () => {
    const cfg = {
      ...baseCfg,
      acp: {
        ...baseCfg.acp,
        dispatch: { enabled: false },
      },
    } satisfies OpenClawConfig;
    const result = await runDiscordAcpCommand("/acp steer tighten logging", cfg);
    expect(result?.reply?.text).toContain("ACP dispatch is disabled by policy");
    expect(hoisted.runTurnMock).not.toHaveBeenCalled();
  });

  it("closes an ACP session, unbinds thread targets, and clears metadata", async () => {
    mockBoundThreadSession();
    hoisted.sessionBindingUnbindMock.mockResolvedValue([
      createBoundThreadSession() as SessionBindingRecord,
    ]);

    const result = await runThreadAcpCommand("/acp close", baseCfg);

    expect(hoisted.closeMock).toHaveBeenCalledTimes(1);
    expect(hoisted.sessionBindingUnbindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "manual",
        targetSessionKey: defaultAcpSessionKey,
      }),
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalled();
    expect(result?.reply?.text).toContain("Removed 1 binding");
  });

  it("lists ACP sessions from the session store", async () => {
    hoisted.sessionBindingListBySessionMock.mockImplementation((key: string) =>
      key === defaultAcpSessionKey ? [createBoundThreadSession(key) as SessionBindingRecord] : [],
    );
    hoisted.loadSessionStoreMock.mockReturnValue({
      [defaultAcpSessionKey]: {
        acp: {
          agent: "codex",
          backend: "acpx",
          lastActivityAt: Date.now(),
          mode: "persistent",
          runtimeSessionName: "runtime-1",
          state: "idle",
        },
        label: "codex-main",
        sessionId: "sess-1",
        updatedAt: Date.now(),
      },
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: Date.now(),
      },
    });

    const result = await runDiscordAcpCommand("/acp sessions", baseCfg);

    expect(result?.reply?.text).toContain("ACP sessions:");
    expect(result?.reply?.text).toContain("codex-main");
    expect(result?.reply?.text).toContain(`thread:${defaultThreadId}`);
  });

  it("shows ACP status for the thread-bound ACP session", async () => {
    mockBoundThreadSession({
      identity: {
        acpxSessionId: "acpx-sid-1",
        agentSessionId: "codex-sid-1",
        lastUpdatedAt: Date.now(),
        source: "status",
        state: "resolved",
      },
    });
    createTaskRecord({
      childSessionKey: defaultAcpSessionKey,
      ownerKey: "agent:main:main",
      progressSummary: "Fetching the latest runtime state",
      runId: "acp-run-1",
      runtime: "acp",
      scopeKind: "session",
      status: "running",
      task: "Inspect ACP backlog",
    });
    const result = await runThreadAcpCommand("/acp status", baseCfg);

    expect(result?.reply?.text).toContain("ACP status:");
    expect(result?.reply?.text).toContain(`session: ${defaultAcpSessionKey}`);
    expect(result?.reply?.text).toContain("agent session id: codex-sid-1");
    expect(result?.reply?.text).toContain("acpx session id: acpx-sid-1");
    expect(result?.reply?.text).toContain("taskStatus: running");
    expect(result?.reply?.text).toContain("taskProgress: Fetching the latest runtime state");
    expect(result?.reply?.text).toContain("capabilities:");
    expect(hoisted.getStatusMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes leaked task and runtime details in ACP status output", async () => {
    mockBoundThreadSession({
      identity: {
        acpxSessionId: "acpx-sid-1",
        agentSessionId: "codex-sid-1",
        lastUpdatedAt: Date.now(),
        source: "status",
        state: "resolved",
      },
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      ...createAcpSessionEntry({
        identity: {
          acpxSessionId: "acpx-sid-1",
          agentSessionId: "codex-sid-1",
          lastUpdatedAt: Date.now(),
          source: "status",
          state: "resolved",
        },
      }),
      acp: {
        ...createAcpSessionEntry().acp,
        identity: {
          acpxSessionId: "acpx-sid-1",
          agentSessionId: "codex-sid-1",
          lastUpdatedAt: Date.now(),
          source: "status",
          state: "resolved",
        },
        lastError: [
          "OpenClaw runtime context (internal):",
          "This context is runtime-generated, not user-authored. Keep internal details private.",
          "",
          "[Internal task completion event]",
          "source: subagent",
        ].join("\n"),
      },
    });
    hoisted.getStatusMock.mockResolvedValue({
      details: {
        payload: [
          "OpenClaw runtime context (internal):",
          "This context is runtime-generated, not user-authored. Keep internal details private.",
          "",
          "[Internal task completion event]",
          "source: subagent",
        ].join("\n"),
      },
      summary: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
    });
    createTaskRecord({
      childSessionKey: defaultAcpSessionKey,
      ownerKey: "agent:main:main",
      runId: "acp-run-1",
      runtime: "acp",
      scopeKind: "session",
      status: "running",
      task: "Inspect ACP backlog",
    });
    failTaskRunByRunId({
      endedAt: Date.now(),
      error: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
      runId: "acp-run-1",
      terminalSummary: "Needs approval to continue.",
    });

    const result = await runThreadAcpCommand("/acp status", baseCfg);

    expect(result?.reply?.text).toContain("ACP status:");
    expect(result?.reply?.text).toContain("taskSummary: Needs approval to continue.");
    expect(result?.reply?.text).not.toContain("OpenClaw runtime context (internal):");
    expect(result?.reply?.text).not.toContain("Internal task completion event");
  });

  it("updates ACP runtime mode via /acp set-mode", async () => {
    mockBoundThreadSession();
    const result = await runThreadAcpCommand("/acp set-mode plan", baseCfg);

    expect(hoisted.setModeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: baseCfg,
        runtimeMode: "plan",
        sessionKey: defaultAcpSessionKey,
      }),
    );
    expect(result?.reply?.text).toContain("Updated ACP runtime mode");
  });

  it("blocks mutating /acp actions for internal operator.write clients", async () => {
    const result = await runInternalAcpCommand({
      commandBody: "/acp set-mode plan",
      scopes: ["operator.write"],
    });

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("requires operator.admin");
  });

  it("blocks /acp status for internal operator.write clients", async () => {
    const result = await runInternalAcpCommand({
      commandBody: "/acp status",
      scopes: ["operator.write"],
    });

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("requires operator.admin");
  });

  it("keeps read-only /acp actions available to internal operator.write clients", async () => {
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      createAcpSessionEntry({
        identity: {
          acpxSessionId: "runtime-1",
          agentSessionId: "session-1",
          lastUpdatedAt: Date.now(),
          source: "status",
          state: "resolved",
        },
      }),
    ]);

    const result = await runInternalAcpCommand({
      commandBody: "/acp sessions",
      scopes: ["operator.write"],
    });

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("ACP sessions");
  });

  it("allows mutating /acp actions for internal operator.admin clients", async () => {
    mockBoundThreadSession();

    const result = await runInternalAcpCommand({
      commandBody: "/acp set-mode plan",
      scopes: ["operator.admin"],
    });

    expect(hoisted.setModeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: baseCfg,
        runtimeMode: "plan",
      }),
    );
    expect(result?.reply?.text).toContain("Updated ACP runtime mode");
  });

  it("updates ACP config options and keeps cwd local when using /acp set", async () => {
    mockBoundThreadSession();

    const setModel = await runThreadAcpCommand("/acp set model gpt-5.4", baseCfg);
    expect(hoisted.setConfigOptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "model",
        value: "gpt-5.4",
      }),
    );
    expect(setModel?.reply?.text).toContain("Updated ACP config option");

    hoisted.setConfigOptionMock.mockClear();
    const setCwd = await runThreadAcpCommand("/acp set cwd /tmp/worktree", baseCfg);
    expect(hoisted.setConfigOptionMock).not.toHaveBeenCalled();
    expect(setCwd?.reply?.text).toContain("Updated ACP cwd");
  });

  it("rejects non-absolute cwd values via ACP runtime option validation", async () => {
    mockBoundThreadSession();

    const result = await runThreadAcpCommand("/acp cwd relative/path", baseCfg);

    expect(result?.reply?.text).toContain("ACP error (ACP_INVALID_RUNTIME_OPTION)");
    expect(result?.reply?.text).toContain("absolute path");
  });

  it("rejects invalid timeout values before backend config writes", async () => {
    mockBoundThreadSession();

    const result = await runThreadAcpCommand("/acp timeout 10s", baseCfg);

    expect(result?.reply?.text).toContain("ACP error (ACP_INVALID_RUNTIME_OPTION)");
    expect(hoisted.setConfigOptionMock).not.toHaveBeenCalled();
  });

  it("returns actionable doctor output when backend is missing", async () => {
    hoisted.getAcpRuntimeBackendMock.mockReturnValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });

    const result = await runDiscordAcpCommand("/acp doctor", baseCfg);

    expect(result?.reply?.text).toContain("ACP doctor:");
    expect(result?.reply?.text).toContain("healthy: no");
    expect(result?.reply?.text).toContain("next:");
  });

  it("shows deterministic install instructions via /acp install", async () => {
    const result = await runDiscordAcpCommand("/acp install", baseCfg);

    expect(result?.reply?.text).toContain("ACP install:");
    expect(result?.reply?.text).toContain("run:");
    expect(result?.reply?.text).toContain("then: /acp doctor");
  });
});
