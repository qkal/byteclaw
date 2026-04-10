import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgentToAgentPolicy: vi.fn(() => ({})),
  createSessionVisibilityGuard: vi.fn(async () => ({
    check: () => ({ allowed: true }),
  })),
  gatewayCall: vi.fn(),
  resolveEffectiveSessionToolsVisibility: vi.fn(() => "all"),
  resolveSandboxedSessionToolContext: vi.fn(() => ({
    alias: "main",
    mainKey: "main",
    requesterInternalKey: undefined,
    restrictToSpawned: false,
  })),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => mocks.gatewayCall(opts),
}));

vi.mock("./sessions-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./sessions-helpers.js")>();
  return {
    ...actual,
    createAgentToAgentPolicy: () => mocks.createAgentToAgentPolicy(),
    createSessionVisibilityGuard: async () => await mocks.createSessionVisibilityGuard(),
    resolveEffectiveSessionToolsVisibility: () => mocks.resolveEffectiveSessionToolsVisibility(),
    resolveSandboxedSessionToolContext: () => mocks.resolveSandboxedSessionToolContext(),
  };
});

describe("sessions-list-tool", () => {
  let createSessionsListTool: typeof import("./sessions-list-tool.js").createSessionsListTool;

  beforeAll(async () => {
    ({ createSessionsListTool } = await import("./sessions-list-tool.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAgentToAgentPolicy.mockReturnValue({});
    mocks.createSessionVisibilityGuard.mockResolvedValue({
      check: () => ({ allowed: true }),
    });
    mocks.resolveEffectiveSessionToolsVisibility.mockReturnValue("all");
    mocks.resolveSandboxedSessionToolContext.mockReturnValue({
      alias: "main",
      mainKey: "main",
      requesterInternalKey: undefined,
      restrictToSpawned: false,
    });
  });

  it("keeps deliveryContext.threadId in sessions_list results", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              deliveryContext: {
                accountId: "acct-1",
                channel: "discord",
                threadId: "thread-1",
                to: "discord:child",
              },
              key: "agent:main:dashboard:child",
              kind: "direct",
              sessionId: "sess-dashboard-child",
            },
            {
              deliveryContext: {
                accountId: "acct-2",
                channel: "telegram",
                threadId: 271,
                to: "telegram:topic",
              },
              key: "agent:main:telegram:topic",
              kind: "direct",
              sessionId: "sess-telegram-topic",
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-1", {});
    const details = result.details as {
      sessions?: {
        deliveryContext?: {
          channel?: string;
          to?: string;
          accountId?: string;
          threadId?: string | number;
        };
      }[];
    };

    expect(details.sessions?.[0]?.deliveryContext).toEqual({
      accountId: "acct-1",
      channel: "discord",
      threadId: "thread-1",
      to: "discord:child",
    });
    expect(details.sessions?.[1]?.deliveryContext).toEqual({
      accountId: "acct-2",
      channel: "telegram",
      threadId: 271,
      to: "telegram:topic",
    });
  });

  it("keeps numeric deliveryContext.threadId in sessions_list results", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              deliveryContext: {
                accountId: "acct-1",
                channel: "telegram",
                threadId: 99,
                to: "-100123",
              },
              key: "agent:main:telegram:group:-100123:topic:99",
              kind: "group",
              sessionId: "sess-telegram-topic",
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-2", {});
    const details = result.details as {
      sessions?: {
        deliveryContext?: {
          channel?: string;
          to?: string;
          accountId?: string;
          threadId?: string | number;
        };
      }[];
    };

    expect(details.sessions?.[0]?.deliveryContext).toEqual({
      accountId: "acct-1",
      channel: "telegram",
      threadId: 99,
      to: "-100123",
    });
  });

  it("keeps live session setting metadata in sessions_list results", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              elevatedLevel: "on",
              fastMode: true,
              key: "main",
              kind: "direct",
              reasoningLevel: "deep",
              responseUsage: "full",
              sessionId: "sess-main",
              thinkingLevel: "high",
              verboseLevel: "on",
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-3", {});
    const details = result.details as {
      sessions?: {
        thinkingLevel?: string;
        fastMode?: boolean;
        verboseLevel?: string;
        reasoningLevel?: string;
        elevatedLevel?: string;
        responseUsage?: string;
      }[];
    };

    expect(details.sessions?.[0]).toMatchObject({
      elevatedLevel: "on",
      fastMode: true,
      reasoningLevel: "deep",
      responseUsage: "full",
      thinkingLevel: "high",
      verboseLevel: "on",
    });
  });
});
