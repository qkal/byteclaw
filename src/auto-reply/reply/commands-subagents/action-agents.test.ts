import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const THREAD_CHANNEL = "thread-chat";
const ROOM_CHANNEL = "room-chat";

const { listBySessionMock, getChannelPluginMock, normalizeChannelIdMock } = vi.hoisted(() => ({
  getChannelPluginMock: vi.fn((channel: string) =>
    channel === "thread-chat" || channel === "room-chat"
      ? {
          config: {
            hasPersistedAuthState: () => false,
          },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
        }
      : null,
  ),
  listBySessionMock: vi.fn(),
  normalizeChannelIdMock: vi.fn((channel: string) => channel),
}));

vi.mock("../../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    listBySession: listBySessionMock,
  }),
}));

vi.mock("../../../channels/plugins/index.js", () => ({
  getChannelPlugin: getChannelPluginMock,
  normalizeChannelId: normalizeChannelIdMock,
}));

let handleSubagentsAgentsAction: typeof import("./action-agents.js").handleSubagentsAgentsAction;

describe("handleSubagentsAgentsAction", () => {
  beforeAll(async () => {
    ({ handleSubagentsAgentsAction } = await import("./action-agents.js"));
  });

  beforeEach(() => {
    listBySessionMock.mockReset();
    getChannelPluginMock.mockClear();
    normalizeChannelIdMock.mockClear();
  });

  it("dedupes stale bound rows for the same child session", () => {
    const childSessionKey = "agent:main:subagent:worker";
    listBySessionMock.mockImplementation((sessionKey: string) =>
      sessionKey === childSessionKey
        ? [
            {
              bindingId: "binding-1",
              boundAt: Date.now() - 20_000,
              conversation: {
                accountId: "default",
                channel: THREAD_CHANNEL,
                conversationId: "thread-1",
              },
              status: "active",
              targetKind: "subagent",
              targetSessionKey: childSessionKey,
            },
          ]
        : [],
    );

    const result = handleSubagentsAgentsAction({
      params: {
        command: {
          channel: THREAD_CHANNEL,
        },
        ctx: {
          Provider: THREAD_CHANNEL,
          Surface: THREAD_CHANNEL,
        },
      },
      requesterKey: "agent:main:main",
      restTokens: [],
      runs: [
        {
          childSessionKey,
          cleanup: "keep",
          createdAt: Date.now() - 10_000,
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-current",
          startedAt: Date.now() - 10_000,
          task: "current worker label",
        },
        {
          childSessionKey,
          cleanup: "keep",
          createdAt: Date.now() - 20_000,
          endedAt: Date.now() - 15_000,
          outcome: { status: "ok" },
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-stale",
          startedAt: Date.now() - 20_000,
          task: "stale worker label",
        },
      ],
    } as never);

    expect(result.reply?.text).toContain("current worker label");
    expect(result.reply?.text).not.toContain("stale worker label");
  });

  it("keeps /agents numbering aligned with target resolution when hidden recent rows exist", () => {
    const hiddenSessionKey = "agent:main:subagent:hidden-recent";
    const visibleSessionKey = "agent:main:subagent:visible-bound";
    listBySessionMock.mockImplementation((sessionKey: string) =>
      sessionKey === visibleSessionKey
        ? [
            {
              bindingId: "binding-visible",
              boundAt: Date.now() - 20_000,
              conversation: {
                accountId: "default",
                channel: THREAD_CHANNEL,
                conversationId: "thread-visible",
              },
              status: "active",
              targetKind: "subagent",
              targetSessionKey: visibleSessionKey,
            },
          ]
        : [],
    );

    const result = handleSubagentsAgentsAction({
      params: {
        command: {
          channel: THREAD_CHANNEL,
        },
        ctx: {
          Provider: THREAD_CHANNEL,
          Surface: THREAD_CHANNEL,
        },
      },
      requesterKey: "agent:main:main",
      restTokens: [],
      runs: [
        {
          childSessionKey: hiddenSessionKey,
          cleanup: "keep",
          createdAt: Date.now() - 10_000,
          endedAt: Date.now() - 5_000,
          outcome: { status: "ok" },
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-hidden-recent",
          startedAt: Date.now() - 10_000,
          task: "hidden recent worker",
        },
        {
          childSessionKey: visibleSessionKey,
          cleanup: "keep",
          createdAt: Date.now() - 20_000,
          endedAt: Date.now() - 15_000,
          outcome: { status: "ok" },
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-visible-bound",
          startedAt: Date.now() - 20_000,
          task: "visible bound worker",
        },
      ],
    } as never);

    expect(result.reply?.text).toContain("2. visible bound worker");
    expect(result.reply?.text).not.toContain("1. visible bound worker");
    expect(result.reply?.text).not.toContain("hidden recent worker");
  });

  it("shows room-channel runs as unbound when the plugin supports conversation bindings", () => {
    listBySessionMock.mockReturnValue([]);

    const result = handleSubagentsAgentsAction({
      params: {
        command: {
          channel: ROOM_CHANNEL,
        },
        ctx: {
          Provider: ROOM_CHANNEL,
          Surface: ROOM_CHANNEL,
        },
      },
      requesterKey: "agent:main:main",
      restTokens: [],
      runs: [
        {
          childSessionKey: "agent:main:subagent:room-worker",
          cleanup: "keep",
          createdAt: Date.now() - 20_000,
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-room-worker",
          startedAt: Date.now() - 20_000,
          task: "room worker",
        },
      ],
    } as never);

    expect(result.reply?.text).toContain("room worker (unbound)");
    expect(result.reply?.text).not.toContain("bindings unavailable");
  });

  it("formats bindings generically", () => {
    const childSessionKey = "agent:main:subagent:room-bound";
    listBySessionMock.mockImplementation((sessionKey: string) =>
      sessionKey === childSessionKey
        ? [
            {
              bindingId: "binding-room",
              boundAt: Date.now() - 20_000,
              conversation: {
                accountId: "default",
                channel: ROOM_CHANNEL,
                conversationId: "room-thread-1",
              },
              status: "active",
              targetKind: "subagent",
              targetSessionKey: childSessionKey,
            },
          ]
        : [],
    );

    const result = handleSubagentsAgentsAction({
      params: {
        command: {
          channel: ROOM_CHANNEL,
        },
        ctx: {
          Provider: ROOM_CHANNEL,
          Surface: ROOM_CHANNEL,
        },
      },
      requesterKey: "agent:main:main",
      restTokens: [],
      runs: [
        {
          childSessionKey,
          cleanup: "keep",
          createdAt: Date.now() - 20_000,
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-room-bound",
          startedAt: Date.now() - 20_000,
          task: "room bound worker",
        },
      ],
    } as never);

    expect(result.reply?.text).toContain("room bound worker (binding:room-thread-1)");
  });

  it("shows bindings unavailable for channels without conversation binding support", () => {
    getChannelPluginMock.mockReturnValueOnce(null);
    listBySessionMock.mockReturnValue([]);

    const result = handleSubagentsAgentsAction({
      params: {
        command: {
          channel: "irc",
        },
        ctx: {
          Provider: "irc",
          Surface: "irc",
        },
      },
      requesterKey: "agent:main:main",
      restTokens: [],
      runs: [
        {
          childSessionKey: "agent:main:subagent:irc-worker",
          cleanup: "keep",
          createdAt: Date.now() - 20_000,
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-irc-worker",
          startedAt: Date.now() - 20_000,
          task: "irc worker",
        },
      ],
    } as never);

    expect(result.reply?.text).toContain("irc worker (bindings unavailable)");
  });
});
