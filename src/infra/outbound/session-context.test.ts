import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveSessionAgentIdMock = vi.hoisted(() => vi.fn());

type SessionContextModule = typeof import("./session-context.js");

let buildOutboundSessionContext: SessionContextModule["buildOutboundSessionContext"];

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: (...args: unknown[]) => resolveSessionAgentIdMock(...args),
}));

beforeAll(async () => {
  ({ buildOutboundSessionContext } = await import("./session-context.js"));
});

beforeEach(() => {
  resolveSessionAgentIdMock.mockReset();
});

describe("buildOutboundSessionContext", () => {
  it("returns undefined when both session key and agent id are blank", () => {
    expect(
      buildOutboundSessionContext({
        agentId: null,
        cfg: {} as never,
        sessionKey: "  ",
      }),
    ).toBeUndefined();
    expect(resolveSessionAgentIdMock).not.toHaveBeenCalled();
  });

  it("returns only the explicit trimmed agent id when no session key is present", () => {
    expect(
      buildOutboundSessionContext({
        agentId: "  explicit-agent  ",
        cfg: {} as never,
        sessionKey: "  ",
      }),
    ).toEqual({
      agentId: "explicit-agent",
    });
    expect(resolveSessionAgentIdMock).not.toHaveBeenCalled();
  });

  it("derives the agent id from the trimmed session key when no explicit agent is given", () => {
    resolveSessionAgentIdMock.mockReturnValueOnce("derived-agent");

    expect(
      buildOutboundSessionContext({
        cfg: { agents: {} } as never,
        sessionKey: "  session:main:123  ",
      }),
    ).toEqual({
      agentId: "derived-agent",
      key: "session:main:123",
    });
    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      config: { agents: {} },
      sessionKey: "session:main:123",
    });
  });

  it("prefers an explicit trimmed agent id over the derived one", () => {
    resolveSessionAgentIdMock.mockReturnValueOnce("derived-agent");

    expect(
      buildOutboundSessionContext({
        agentId: "  explicit-agent  ",
        cfg: {} as never,
        sessionKey: "session:main:123",
      }),
    ).toEqual({
      agentId: "explicit-agent",
      key: "session:main:123",
    });
  });
});
