import type {
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
  SetSessionConfigOptionRequest,
  SetSessionModeRequest,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { listThinkingLevels } from "../auto-reply/thinking.js";
import type { GatewayClient } from "../gateway/client.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

function createNewSessionRequest(cwd = "/tmp"): NewSessionRequest {
  return {
    _meta: {},
    cwd,
    mcpServers: [],
  } as unknown as NewSessionRequest;
}

function createLoadSessionRequest(sessionId: string, cwd = "/tmp"): LoadSessionRequest {
  return {
    _meta: {},
    cwd,
    mcpServers: [],
    sessionId,
  } as unknown as LoadSessionRequest;
}

function createPromptRequest(
  sessionId: string,
  text: string,
  meta: Record<string, unknown> = {},
): PromptRequest {
  return {
    _meta: meta,
    prompt: [{ text, type: "text" }],
    sessionId,
  } as unknown as PromptRequest;
}

function createSetSessionModeRequest(sessionId: string, modeId: string): SetSessionModeRequest {
  return {
    _meta: {},
    modeId,
    sessionId,
  } as unknown as SetSessionModeRequest;
}

function createSetSessionConfigOptionRequest(
  sessionId: string,
  configId: string,
  value: string | boolean,
): SetSessionConfigOptionRequest {
  return {
    _meta: {},
    configId,
    sessionId,
    value,
  } as unknown as SetSessionConfigOptionRequest;
}

function createToolEvent(params: {
  sessionKey: string;
  phase: "start" | "update" | "result";
  toolCallId: string;
  name: string;
  args?: Record<string, unknown>;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
}): EventFrame {
  return {
    event: "agent",
    payload: {
      data: {
        args: params.args,
        isError: params.isError,
        name: params.name,
        partialResult: params.partialResult,
        phase: params.phase,
        result: params.result,
        toolCallId: params.toolCallId,
      },
      sessionKey: params.sessionKey,
      stream: "tool",
    },
  } as unknown as EventFrame;
}

function createChatFinalEvent(sessionKey: string): EventFrame {
  return {
    event: "chat",
    payload: {
      sessionKey,
      state: "final",
    },
  } as unknown as EventFrame;
}

async function expectOversizedPromptRejected(params: { sessionId: string; text: string }) {
  const request = vi.fn(async () => ({ ok: true })) as GatewayClient["request"];
  const sessionStore = createInMemorySessionStore();
  const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
    sessionStore,
  });
  await agent.loadSession(createLoadSessionRequest(params.sessionId));

  await expect(agent.prompt(createPromptRequest(params.sessionId, params.text))).rejects.toThrow(
    /maximum allowed size/i,
  );
  expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything(), expect.anything());
  const session = sessionStore.getSession(params.sessionId);
  expect(session?.activeRunId).toBeNull();
  expect(session?.abortController).toBeNull();

  sessionStore.clearAllSessionsForTest();
}

describe("acp session creation rate limit", () => {
  it("rate limits excessive newSession bursts", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionCreateRateLimit: {
        maxRequests: 2,
        windowMs: 60_000,
      },
      sessionStore,
    });

    await agent.newSession(createNewSessionRequest());
    await agent.newSession(createNewSessionRequest());
    await expect(agent.newSession(createNewSessionRequest())).rejects.toThrow(
      /session creation rate limit exceeded/i,
    );

    sessionStore.clearAllSessionsForTest();
  });

  it("does not count loadSession refreshes for an existing session ID", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionCreateRateLimit: {
        maxRequests: 1,
        windowMs: 60_000,
      },
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("shared-session"));
    await agent.loadSession(createLoadSessionRequest("shared-session"));
    await expect(agent.loadSession(createLoadSessionRequest("new-session"))).rejects.toThrow(
      /session creation rate limit exceeded/i,
    );

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp unsupported bridge session setup", () => {
  it("rejects per-session MCP servers on newSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const agent = new AcpGatewayAgent(connection, createAcpGateway(), {
      sessionStore,
    });

    await expect(
      agent.newSession({
        ...createNewSessionRequest(),
        mcpServers: [{ command: "mcp-docs", name: "docs" }] as never[],
      }),
    ).rejects.toThrow(/does not support per-session MCP servers/i);

    expect(sessionStore.hasSession("docs-session")).toBe(false);
    expect(sessionUpdate).not.toHaveBeenCalled();
    sessionStore.clearAllSessionsForTest();
  });

  it("rejects per-session MCP servers on loadSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const agent = new AcpGatewayAgent(connection, createAcpGateway(), {
      sessionStore,
    });

    await expect(
      agent.loadSession({
        ...createLoadSessionRequest("docs-session"),
        mcpServers: [{ command: "mcp-docs", name: "docs" }] as never[],
      }),
    ).rejects.toThrow(/does not support per-session MCP servers/i);

    expect(sessionStore.hasSession("docs-session")).toBe(false);
    expect(sessionUpdate).not.toHaveBeenCalled();
    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp session UX bridge behavior", () => {
  it("returns initial modes and thought-level config options for new sessions", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
    });

    const result = await agent.newSession(createNewSessionRequest());

    expect(result.modes?.currentModeId).toBe("adaptive");
    expect(result.modes?.availableModes.map((mode) => mode.id)).toContain("adaptive");
    expect(result.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "thought_level",
          currentValue: "adaptive",
          id: "thought_level",
        }),
        expect.objectContaining({
          currentValue: "off",
          id: "verbose_level",
        }),
        expect.objectContaining({
          currentValue: "off",
          id: "reasoning_level",
        }),
        expect.objectContaining({
          currentValue: "off",
          id: "response_usage",
        }),
        expect.objectContaining({
          currentValue: "off",
          id: "elevated_level",
        }),
      ]),
    );

    sessionStore.clearAllSessionsForTest();
  });

  it("replays user text, assistant text, and hidden assistant thinking on loadSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          count: 1,
          defaults: {
            contextTokens: null,
            model: null,
            modelProvider: null,
          },
          path: "/tmp/sessions.json",
          sessions: [
            {
              contextTokens: 8192,
              derivedTitle: "Fix ACP bridge",
              displayName: "Main work",
              elevatedLevel: "ask",
              key: "agent:main:work",
              kind: "direct",
              label: "main-work",
              model: "gpt-5.4",
              modelProvider: "openai",
              reasoningLevel: "stream",
              responseUsage: "tokens",
              thinkingLevel: "high",
              totalTokens: 4096,
              totalTokensFresh: true,
              updatedAt: 1_710_000_000_000,
              verboseLevel: "full",
            },
          ],
          ts: Date.now(),
        };
      }
      if (method === "sessions.get") {
        return {
          messages: [
            { content: [{ text: "Question", type: "text" }], role: "user" },
            {
              content: [
                { thinking: "Internal loop about NO_REPLY", type: "thinking" },
                { text: "Answer", type: "text" },
              ],
              role: "assistant",
            },
            { content: [{ text: "ignore me", type: "text" }], role: "system" },
            { content: [{ image: "skip", type: "image" }], role: "assistant" },
          ],
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    const result = await agent.loadSession(createLoadSessionRequest("agent:main:work"));

    expect(result.modes?.currentModeId).toBe("high");
    expect(result.modes?.availableModes.map((mode) => mode.id)).toEqual(
      listThinkingLevels("openai", "gpt-5.4"),
    );
    expect(result.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentValue: "high",
          id: "thought_level",
        }),
        expect.objectContaining({
          currentValue: "full",
          id: "verbose_level",
        }),
        expect.objectContaining({
          currentValue: "stream",
          id: "reasoning_level",
        }),
        expect.objectContaining({
          currentValue: "tokens",
          id: "response_usage",
        }),
        expect.objectContaining({
          currentValue: "ask",
          id: "elevated_level",
        }),
      ]),
    );
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        content: { text: "Question", type: "text" },
        sessionUpdate: "user_message_chunk",
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        content: { text: "Internal loop about NO_REPLY", type: "text" },
        sessionUpdate: "agent_thought_chunk",
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        content: { text: "Answer", type: "text" },
        sessionUpdate: "agent_message_chunk",
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: expect.objectContaining({
        sessionUpdate: "available_commands_update",
      }),
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "session_info_update",
        title: "Fix ACP bridge",
        updatedAt: "2024-03-09T16:00:00.000Z",
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        _meta: {
          approximate: true,
          source: "gateway-session-store",
        },
        sessionUpdate: "usage_update",
        size: 8192,
        used: 4096,
      },
    });

    sessionStore.clearAllSessionsForTest();
  });

  it("falls back to an empty transcript when sessions.get fails during loadSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          count: 1,
          defaults: {
            contextTokens: null,
            model: null,
            modelProvider: null,
          },
          path: "/tmp/sessions.json",
          sessions: [
            {
              displayName: "Recover session",
              key: "agent:main:recover",
              kind: "direct",
              label: "recover",
              model: "gpt-5.4",
              modelProvider: "openai",
              thinkingLevel: "adaptive",
              updatedAt: 1_710_000_000_000,
            },
          ],
          ts: Date.now(),
        };
      }
      if (method === "sessions.get") {
        throw new Error("sessions.get unavailable");
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    const result = await agent.loadSession(createLoadSessionRequest("agent:main:recover"));

    expect(result.modes?.currentModeId).toBe("adaptive");
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:recover",
      update: expect.objectContaining({
        sessionUpdate: "available_commands_update",
      }),
    });
    expect(sessionUpdate).not.toHaveBeenCalledWith({
      sessionId: "agent:main:recover",
      update: expect.objectContaining({
        sessionUpdate: "user_message_chunk",
      }),
    });

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp setSessionMode bridge behavior", () => {
  it("surfaces gateway mode patch failures instead of succeeding silently", async () => {
    const sessionStore = createInMemorySessionStore();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        throw new Error("gateway rejected mode");
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("mode-session"));

    await expect(
      agent.setSessionMode(createSetSessionModeRequest("mode-session", "high")),
    ).rejects.toThrow(/gateway rejected mode/i);

    sessionStore.clearAllSessionsForTest();
  });

  it("emits current mode and thought-level config updates after a successful mode change", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          count: 1,
          defaults: {
            contextTokens: null,
            model: null,
            modelProvider: null,
          },
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "mode-session",
              kind: "direct",
              model: "gpt-5.4",
              modelProvider: "openai",
              thinkingLevel: "high",
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("mode-session"));
    sessionUpdate.mockClear();

    await agent.setSessionMode(createSetSessionModeRequest("mode-session", "high"));

    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "mode-session",
      update: {
        currentModeId: "high",
        sessionUpdate: "current_mode_update",
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "mode-session",
      update: {
        configOptions: expect.arrayContaining([
          expect.objectContaining({
            currentValue: "high",
            id: "thought_level",
          }),
        ]),
        sessionUpdate: "config_option_update",
      },
    });

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp setSessionConfigOption bridge behavior", () => {
  it("updates the thought-level config option and returns refreshed options", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          count: 1,
          defaults: {
            contextTokens: null,
            model: null,
            modelProvider: null,
          },
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "config-session",
              kind: "direct",
              model: "gpt-5.4",
              modelProvider: "openai",
              thinkingLevel: "minimal",
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("config-session"));
    sessionUpdate.mockClear();

    const result = await agent.setSessionConfigOption(
      createSetSessionConfigOptionRequest("config-session", "thought_level", "minimal"),
    );

    expect(result.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentValue: "minimal",
          id: "thought_level",
        }),
      ]),
    );
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "config-session",
      update: {
        currentModeId: "minimal",
        sessionUpdate: "current_mode_update",
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "config-session",
      update: {
        configOptions: expect.arrayContaining([
          expect.objectContaining({
            currentValue: "minimal",
            id: "thought_level",
          }),
        ]),
        sessionUpdate: "config_option_update",
      },
    });

    sessionStore.clearAllSessionsForTest();
  });

  it("updates non-mode ACP config options through gateway session patches", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          count: 1,
          defaults: {
            contextTokens: null,
            model: null,
            modelProvider: null,
          },
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "reasoning-session",
              kind: "direct",
              model: "gpt-5.4",
              modelProvider: "openai",
              reasoningLevel: "stream",
              thinkingLevel: "minimal",
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("reasoning-session"));
    sessionUpdate.mockClear();

    const result = await agent.setSessionConfigOption(
      createSetSessionConfigOptionRequest("reasoning-session", "reasoning_level", "stream"),
    );

    expect(result.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentValue: "stream",
          id: "reasoning_level",
        }),
      ]),
    );
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "reasoning-session",
      update: {
        configOptions: expect.arrayContaining([
          expect.objectContaining({
            currentValue: "stream",
            id: "reasoning_level",
          }),
        ]),
        sessionUpdate: "config_option_update",
      },
    });

    sessionStore.clearAllSessionsForTest();
  });

  it("updates fast mode ACP config options through gateway session patches", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.list") {
        return {
          count: 1,
          defaults: {
            contextTokens: null,
            model: null,
            modelProvider: null,
          },
          path: "/tmp/sessions.json",
          sessions: [
            {
              fastMode: true,
              key: "fast-session",
              kind: "direct",
              model: "gpt-5.4",
              modelProvider: "openai",
              thinkingLevel: "minimal",
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        };
      }
      if (method === "sessions.patch") {
        expect(params).toEqual({
          fastMode: true,
          key: "fast-session",
        });
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("fast-session"));
    sessionUpdate.mockClear();

    const result = await agent.setSessionConfigOption(
      createSetSessionConfigOptionRequest("fast-session", "fast_mode", "on"),
    );

    expect(result.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentValue: "on",
          id: "fast_mode",
        }),
      ]),
    );
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "fast-session",
      update: {
        configOptions: expect.arrayContaining([
          expect.objectContaining({
            currentValue: "on",
            id: "fast_mode",
          }),
        ]),
        sessionUpdate: "config_option_update",
      },
    });

    sessionStore.clearAllSessionsForTest();
  });

  it("rejects non-string ACP config option values", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          count: 1,
          defaults: {
            contextTokens: null,
            model: null,
            modelProvider: null,
          },
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "bool-config-session",
              kind: "direct",
              model: "gpt-5.4",
              modelProvider: "openai",
              thinkingLevel: "minimal",
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("bool-config-session"));

    await expect(
      agent.setSessionConfigOption(
        createSetSessionConfigOptionRequest("bool-config-session", "thought_level", false),
      ),
    ).rejects.toThrow(
      'ACP bridge does not support non-string session config option values for "thought_level".',
    );
    expect(request).not.toHaveBeenCalledWith(
      "sessions.patch",
      expect.objectContaining({ key: "bool-config-session" }),
    );

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp tool streaming bridge behavior", () => {
  it("maps Gateway tool partial output and file locations into ACP tool updates", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return new Promise(() => {});
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("tool-session"));
    sessionUpdate.mockClear();

    const promptPromise = agent.prompt(createPromptRequest("tool-session", "Inspect app.ts"));

    await agent.handleGatewayEvent(
      createToolEvent({
        args: { line: 12, path: "src/app.ts" },
        name: "read",
        phase: "start",
        sessionKey: "tool-session",
        toolCallId: "tool-1",
      }),
    );
    await agent.handleGatewayEvent(
      createToolEvent({
        name: "read",
        partialResult: {
          content: [{ text: "partial output", type: "text" }],
          details: { path: "src/app.ts" },
        },
        phase: "update",
        sessionKey: "tool-session",
        toolCallId: "tool-1",
      }),
    );
    await agent.handleGatewayEvent(
      createToolEvent({
        name: "read",
        phase: "result",
        result: {
          content: [{ text: "FILE:src/app.ts", type: "text" }],
          details: { path: "src/app.ts" },
        },
        sessionKey: "tool-session",
        toolCallId: "tool-1",
      }),
    );
    await agent.handleGatewayEvent(createChatFinalEvent("tool-session"));
    await promptPromise;

    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "tool-session",
      update: {
        kind: "read",
        locations: [{ line: 12, path: "src/app.ts" }],
        rawInput: { line: 12, path: "src/app.ts" },
        sessionUpdate: "tool_call",
        status: "in_progress",
        title: "read: path: src/app.ts, line: 12",
        toolCallId: "tool-1",
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "tool-session",
      update: {
        content: [
          {
            content: { text: "partial output", type: "text" },
            type: "content",
          },
        ],
        locations: [{ line: 12, path: "src/app.ts" }],
        rawOutput: {
          content: [{ text: "partial output", type: "text" }],
          details: { path: "src/app.ts" },
        },
        sessionUpdate: "tool_call_update",
        status: "in_progress",
        toolCallId: "tool-1",
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "tool-session",
      update: {
        content: [
          {
            content: { text: "FILE:src/app.ts", type: "text" },
            type: "content",
          },
        ],
        locations: [{ line: 12, path: "src/app.ts" }],
        rawOutput: {
          content: [{ text: "FILE:src/app.ts", type: "text" }],
          details: { path: "src/app.ts" },
        },
        sessionUpdate: "tool_call_update",
        status: "completed",
        toolCallId: "tool-1",
      },
    });

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp session metadata and usage updates", () => {
  it("emits a fresh usage snapshot after prompt completion when gateway totals are available", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          count: 1,
          defaults: {
            contextTokens: null,
            model: null,
            modelProvider: null,
          },
          path: "/tmp/sessions.json",
          sessions: [
            {
              contextTokens: 4000,
              displayName: "Usage session",
              key: "usage-session",
              kind: "direct",
              model: "gpt-5.4",
              modelProvider: "openai",
              thinkingLevel: "adaptive",
              totalTokens: 1200,
              totalTokensFresh: true,
              updatedAt: 1_710_000_123_000,
            },
          ],
          ts: Date.now(),
        };
      }
      if (method === "chat.send") {
        return new Promise(() => {});
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("usage-session"));
    sessionUpdate.mockClear();

    const promptPromise = agent.prompt(createPromptRequest("usage-session", "hello"));
    await agent.handleGatewayEvent(createChatFinalEvent("usage-session"));
    await promptPromise;

    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "usage-session",
      update: {
        sessionUpdate: "session_info_update",
        title: "Usage session",
        updatedAt: "2024-03-09T16:02:03.000Z",
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "usage-session",
      update: {
        _meta: {
          approximate: true,
          source: "gateway-session-store",
        },
        sessionUpdate: "usage_update",
        size: 4000,
        used: 1200,
      },
    });

    sessionStore.clearAllSessionsForTest();
  });

  it("still resolves prompts when snapshot updates fail after completion", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          count: 1,
          defaults: {
            contextTokens: null,
            model: null,
            modelProvider: null,
          },
          path: "/tmp/sessions.json",
          sessions: [
            {
              contextTokens: 4000,
              displayName: "Usage session",
              key: "usage-session",
              kind: "direct",
              model: "gpt-5.4",
              modelProvider: "openai",
              thinkingLevel: "adaptive",
              totalTokens: 1200,
              totalTokensFresh: true,
              updatedAt: 1_710_000_123_000,
            },
          ],
          ts: Date.now(),
        };
      }
      if (method === "chat.send") {
        return new Promise(() => {});
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("usage-session"));
    sessionUpdate.mockClear();
    sessionUpdate.mockRejectedValueOnce(new Error("session update transport failed"));

    const promptPromise = agent.prompt(createPromptRequest("usage-session", "hello"));
    await agent.handleGatewayEvent(createChatFinalEvent("usage-session"));

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    const session = sessionStore.getSession("usage-session");
    expect(session?.activeRunId).toBeNull();
    expect(session?.abortController).toBeNull();

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp prompt size hardening", () => {
  it("rejects oversized prompt blocks without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-oversize",
      text: "a".repeat(2 * 1024 * 1024 + 1),
    });
  });

  it("rejects oversize final messages from cwd prefix without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-prefix",
      text: "a".repeat(2 * 1024 * 1024),
    });
  });
});

describe("acp final chat snapshots", () => {
  async function createSnapshotHarness() {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return new Promise(() => {});
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });
    await agent.loadSession(createLoadSessionRequest("snapshot-session"));
    sessionUpdate.mockClear();
    const promptPromise = agent.prompt(createPromptRequest("snapshot-session", "hello"));
    const runId = sessionStore.getSession("snapshot-session")?.activeRunId;
    if (!runId) {
      throw new Error("Expected ACP prompt run to be active");
    }
    return { agent, promptPromise, runId, sessionStore, sessionUpdate };
  }

  it("emits final snapshot text before resolving end_turn", async () => {
    const { agent, sessionUpdate, promptPromise, runId, sessionStore } =
      await createSnapshotHarness();

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        message: {
          content: [{ text: "FINAL TEXT SHOULD BE EMITTED", type: "text" }],
        },
        runId,
        sessionKey: "snapshot-session",
        state: "final",
        stopReason: "end_turn",
      },
    } as unknown as EventFrame);

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "snapshot-session",
      update: {
        content: { text: "FINAL TEXT SHOULD BE EMITTED", type: "text" },
        sessionUpdate: "agent_message_chunk",
      },
    });
    expect(sessionStore.getSession("snapshot-session")?.activeRunId).toBeNull();
    sessionStore.clearAllSessionsForTest();
  });

  it("does not duplicate text when final repeats the last delta snapshot", async () => {
    const { agent, sessionUpdate, promptPromise, runId, sessionStore } =
      await createSnapshotHarness();

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        message: {
          content: [{ text: "Hello world", type: "text" }],
        },
        runId,
        sessionKey: "snapshot-session",
        state: "delta",
      },
    } as unknown as EventFrame);

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        message: {
          content: [{ text: "Hello world", type: "text" }],
        },
        runId,
        sessionKey: "snapshot-session",
        state: "final",
        stopReason: "end_turn",
      },
    } as unknown as EventFrame);

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    const chunks = sessionUpdate.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>)?.update &&
        (call[0] as Record<string, Record<string, unknown>>).update?.sessionUpdate ===
          "agent_message_chunk",
    );
    expect(chunks).toHaveLength(1);
    sessionStore.clearAllSessionsForTest();
  });

  it("emits only the missing tail when the final snapshot extends prior deltas", async () => {
    const { agent, sessionUpdate, promptPromise, runId, sessionStore } =
      await createSnapshotHarness();

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        message: {
          content: [{ text: "Hello", type: "text" }],
        },
        runId,
        sessionKey: "snapshot-session",
        state: "delta",
      },
    } as unknown as EventFrame);

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        message: {
          content: [{ text: "Hello world", type: "text" }],
        },
        runId,
        sessionKey: "snapshot-session",
        state: "final",
        stopReason: "max_tokens",
      },
    } as unknown as EventFrame);

    await expect(promptPromise).resolves.toEqual({ stopReason: "max_tokens" });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "snapshot-session",
      update: {
        content: { text: "Hello", type: "text" },
        sessionUpdate: "agent_message_chunk",
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "snapshot-session",
      update: {
        content: { text: " world", type: "text" },
        sessionUpdate: "agent_message_chunk",
      },
    });
    sessionStore.clearAllSessionsForTest();
  });
});
