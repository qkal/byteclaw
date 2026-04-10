import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { type Mock, vi } from "vitest";
import { parsePluginBindingApprovalCustomId } from "../../../../src/plugins/conversation-binding.js";
import { resolvePinnedMainDmOwnerFromAllowlist } from "../../../../src/security/dm-policy-shared.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyMock = Mock<DispatchReplyWithBufferedBlockDispatcherFn>;

interface DiscordComponentRuntimeMocks {
  buildPluginBindingResolvedTextMock: UnknownMock;
  dispatchPluginInteractiveHandlerMock: AsyncUnknownMock;
  dispatchReplyMock: DispatchReplyMock;
  enqueueSystemEventMock: UnknownMock;
  readAllowFromStoreMock: AsyncUnknownMock;
  readSessionUpdatedAtMock: UnknownMock;
  recordInboundSessionMock: AsyncUnknownMock;
  resolveStorePathMock: UnknownMock;
  resolvePluginConversationBindingApprovalMock: AsyncUnknownMock;
  upsertPairingRequestMock: AsyncUnknownMock;
}

const runtimeMocks = vi.hoisted(
  (): DiscordComponentRuntimeMocks => ({
    buildPluginBindingResolvedTextMock: vi.fn(),
    dispatchPluginInteractiveHandlerMock: vi.fn(),
    dispatchReplyMock: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(),
    enqueueSystemEventMock: vi.fn(),
    readAllowFromStoreMock: vi.fn(),
    readSessionUpdatedAtMock: vi.fn(),
    recordInboundSessionMock: vi.fn(),
    resolvePluginConversationBindingApprovalMock: vi.fn(),
    resolveStorePathMock: vi.fn(),
    upsertPairingRequestMock: vi.fn(),
  }),
);

export const {readAllowFromStoreMock} = runtimeMocks;
export const {dispatchPluginInteractiveHandlerMock} = runtimeMocks;
export const {dispatchReplyMock} = runtimeMocks;
export const {enqueueSystemEventMock} = runtimeMocks;
export const {upsertPairingRequestMock} = runtimeMocks;
export const {recordInboundSessionMock} = runtimeMocks;
export const {readSessionUpdatedAtMock} = runtimeMocks;
export const {resolveStorePathMock} = runtimeMocks;
export const {resolvePluginConversationBindingApprovalMock} = runtimeMocks;
export const {buildPluginBindingResolvedTextMock} = runtimeMocks;

async function readStoreAllowFromForDmPolicy(params: {
  provider: string;
  accountId: string;
  dmPolicy?: string | null;
  shouldRead?: boolean | null;
}) {
  if (params.shouldRead === false || params.dmPolicy === "allowlist") {
    return [];
  }
  return await readAllowFromStoreMock(params.provider, params.accountId);
}

vi.mock("../monitor/agent-components-helpers.runtime.js", () => ({
    readStoreAllowFromForDmPolicy,
    resolvePinnedMainDmOwnerFromAllowlist,
    upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
  }));

vi.mock("../monitor/agent-components.runtime.js", () => ({
    buildPluginBindingResolvedText: (...args: unknown[]) =>
      buildPluginBindingResolvedTextMock(...args),
    createReplyReferencePlanner: vi.fn(
      (params: {
        existingId?: string;
        hasReplied?: boolean;
        replyToMode?: "off" | "first" | "all" | "batched";
        startId?: string;
      }) => {
        let hasReplied = params.hasReplied ?? false;
        let nextId = params.existingId ?? params.startId;
        return {
          hasReplied() {
            return hasReplied;
          },
          markSent() {
            hasReplied = true;
          },
          use() {
            if (params.replyToMode === "off") {
              return undefined;
            }
            if (isSingleUseReplyToMode(params.replyToMode ?? "off") && hasReplied) {
              return undefined;
            }
            const value = nextId;
            hasReplied = true;
            nextId = undefined;
            return value;
          },
        };
      },
    ),
    dispatchPluginInteractiveHandler: (...args: unknown[]) =>
      dispatchPluginInteractiveHandlerMock(...args),
    dispatchReplyWithBufferedBlockDispatcher: dispatchReplyMock,
    finalizeInboundContext: vi.fn((ctx) => ctx),
    parsePluginBindingApprovalCustomId,
    recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
    resolveChunkMode: vi.fn(() => "sentences"),
    resolvePluginConversationBindingApproval: (...args: unknown[]) =>
      resolvePluginConversationBindingApprovalMock(...args),
    resolveTextChunkLimit: vi.fn(() => 2000),
  }));

vi.mock("../interactive-dispatch.js", () => ({
    dispatchDiscordPluginInteractiveHandler: (...args: unknown[]) =>
      dispatchPluginInteractiveHandlerMock(...args),
  }));

vi.mock("../monitor/agent-components.deps.runtime.js", () => ({
    enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
    readSessionUpdatedAt: (...args: unknown[]) => readSessionUpdatedAtMock(...args),
    resolveStorePath: (...args: unknown[]) => resolveStorePathMock(...args),
  }));

vi.mock("../interactive-dispatch.js", async () => {
  const actual = await vi.importActual<typeof import("../interactive-dispatch.js")>(
    "../interactive-dispatch.js",
  );
  return {
    ...actual,
    dispatchDiscordPluginInteractiveHandler: (...args: unknown[]) =>
      dispatchPluginInteractiveHandlerMock(...args),
  };
});

export function resetDiscordComponentRuntimeMocks() {
  dispatchPluginInteractiveHandlerMock.mockReset().mockResolvedValue({
    duplicate: false,
    handled: false,
    matched: false,
  });
  dispatchReplyMock.mockClear();
  enqueueSystemEventMock.mockClear();
  readAllowFromStoreMock.mockClear().mockResolvedValue([]);
  readSessionUpdatedAtMock.mockClear().mockReturnValue(undefined);
  upsertPairingRequestMock.mockClear().mockResolvedValue({ code: "PAIRCODE", created: true });
  recordInboundSessionMock.mockClear().mockResolvedValue(undefined);
  resolveStorePathMock.mockClear().mockReturnValue("/tmp/openclaw-sessions-test.json");
  resolvePluginConversationBindingApprovalMock.mockReset().mockResolvedValue({
    binding: {
      accountId: "default",
      bindingId: "binding-1",
      boundAt: Date.now(),
      channel: "discord",
      conversationId: "user:123456789",
      pluginId: "openclaw-codex-app-server",
      pluginName: "OpenClaw App Server",
      pluginRoot: "/plugins/codex",
    },
    decision: "allow-once",
    request: {
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "user:123456789",
      },
      id: "approval-1",
      pluginId: "openclaw-codex-app-server",
      pluginName: "OpenClaw App Server",
      pluginRoot: "/plugins/codex",
      requestedAt: Date.now(),
    },
    status: "approved",
  });
  buildPluginBindingResolvedTextMock.mockReset().mockReturnValue("Binding approved.");
}
