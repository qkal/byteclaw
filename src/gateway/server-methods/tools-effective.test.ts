import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { toolsEffectiveHandlers } from "./tools-effective.js";

const runtimeMocks = vi.hoisted(() => ({
  deliveryContextFromSession: vi.fn(() => ({
    accountId: "acct-1",
    channel: "telegram",
    threadId: "thread-2",
    to: "channel-1",
  })),
  listAgentIds: vi.fn(() => ["main"]),
  loadConfig: vi.fn(() => ({})),
  loadSessionEntry: vi.fn(() => ({
    canonicalKey: "main:abc",
    cfg: {},
    entry: {
      chatType: "group",
      groupChannel: "#ops",
      groupId: "group-4",
      lastAccountId: "acct-1",
      lastChannel: "telegram",
      lastThreadId: "thread-2",
      lastTo: "channel-1",
      model: "gpt-4.1",
      modelProvider: "openai",
      sessionId: "session-1",
      space: "workspace-5",
      updatedAt: 1,
    },
  })),
  resolveEffectiveToolInventory: vi.fn(() => ({
    agentId: "main",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [
          {
            description: "Run shell commands",
            id: "exec",
            label: "Exec",
            rawDescription: "Run shell commands",
            source: "core",
          },
        ],
      },
    ],
    profile: "coding",
  })),
  resolveReplyToMode: vi.fn(() => "first"),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveSessionModelRef: vi.fn(() => ({ model: "gpt-4.1", provider: "openai" })),
}));

vi.mock("./tools-effective.runtime.js", () => runtimeMocks);

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvokeParams(params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    invoke: async () =>
      await toolsEffectiveHandlers["tools.effective"]({
        client: null,
        context: {} as never,
        isWebchatConnect: () => false,
        params,
        req: { id: "req-1", method: "tools.effective", type: "req" },
        respond: respond as never,
      }),
    respond,
  };
}

describe("tools.effective handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid params", async () => {
    const { respond, invoke } = createInvokeParams({ includePlugins: false });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.effective params");
  });

  it("rejects missing sessionKey", async () => {
    const { respond, invoke } = createInvokeParams({});
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.effective params");
  });

  it("rejects caller-supplied auth context params", async () => {
    const { respond, invoke } = createInvokeParams({ senderIsOwner: true });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.effective params");
  });

  it("rejects unknown agent ids", async () => {
    const { respond, invoke } = createInvokeParams({
      agentId: "unknown-agent",
      sessionKey: "main:abc",
    });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("unknown agent id");
  });

  it("rejects unknown session keys", async () => {
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      canonicalKey: "missing-session",
      cfg: {},
      entry: undefined,
      legacyKey: undefined,
      storePath: "/tmp/sessions.json",
    } as never);
    const { respond, invoke } = createInvokeParams({ sessionKey: "missing-session" });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('unknown session key "missing-session"');
  });

  it("returns the effective runtime inventory", async () => {
    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      agentId: "main",
      groups: [
        {
          id: "core",
          source: "core",
          tools: [{ id: "exec", source: "core" }],
        },
      ],
      profile: "coding",
    });
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-1",
        currentChannelId: "channel-1",
        currentThreadTs: "thread-2",
        groupChannel: "#ops",
        groupId: "group-4",
        groupSpace: "workspace-5",
        messageProvider: "telegram",
        modelId: "gpt-4.1",
        modelProvider: "openai",
        replyToMode: "first",
        senderIsOwner: false,
      }),
    );
  });

  it("falls back to origin.threadId when delivery context omits thread metadata", async () => {
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      canonicalKey: "main:abc",
      cfg: {},
      entry: {
        chatType: "group",
        groupChannel: "#ops",
        groupId: "group-4",
        lastAccountId: "acct-1",
        lastChannel: "telegram",
        lastTo: "channel-1",
        model: "gpt-4.1",
        modelProvider: "openai",
        origin: {
          accountId: "acct-1",
          provider: "telegram",
          threadId: 42,
        },
        sessionId: "session-origin-thread",
        space: "workspace-5",
        updatedAt: 1,
      },
    } as never);
    runtimeMocks.deliveryContextFromSession.mockReturnValueOnce({
      accountId: "acct-1",
      channel: "telegram",
      threadId: "42",
      to: "channel-1",
    });

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        currentThreadTs: "42",
      }),
    );
    expect((respond.mock.calls[0] as RespondCall | undefined)?.[0]).toBe(true);
  });

  it("passes senderIsOwner=true for admin-scoped callers", async () => {
    const respond = vi.fn();
    await toolsEffectiveHandlers["tools.effective"]({
      client: {
        connect: { scopes: ["operator.admin"] },
      } as never,
      context: {} as never,
      isWebchatConnect: () => false,
      params: { sessionKey: "main:abc" },
      req: { id: "req-1", method: "tools.effective", type: "req" },
      respond: respond as never,
    });
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledWith(
      expect.objectContaining({ senderIsOwner: true }),
    );
  });

  it("rejects agent ids that do not match the session agent", async () => {
    const { respond, invoke } = createInvokeParams({
      agentId: "other",
      sessionKey: "main:abc",
    });
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      canonicalKey: "main:abc",
      cfg: {},
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
      },
    } as never);
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('unknown agent id "other"');
  });
});
