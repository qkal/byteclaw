import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import * as acpManagerModule from "../acp/control-plane/manager.js";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import * as embeddedModule from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
import { readSessionMessages } from "../gateway/session-utils.fs.js";
import { onAgentEvent } from "../infra/agent-events.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentCommand } from "./agent.js";

const loadConfigSpy = vi.spyOn(configModule, "loadConfig");
const runEmbeddedPiAgentSpy = vi.spyOn(embeddedModule, "runEmbeddedPiAgent");
const getAcpSessionManagerSpy = vi.spyOn(acpManagerModule, "getAcpSessionManager");

const runtime: RuntimeEnv = {
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
  log: vi.fn(),
};

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-acp-" });
}

function createAcpEnabledConfig(home: string, storePath: string): OpenClawConfig {
  return {
    acp: {
      allowedAgents: ["codex", "kimi"],
      backend: "acpx",
      dispatch: { enabled: true },
      enabled: true,
    },
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.4" },
        models: { "openai/gpt-5.4": {} },
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { mainKey: "main", store: storePath },
  };
}

function mockConfig(home: string, storePath: string) {
  loadConfigSpy.mockReturnValue(createAcpEnabledConfig(home, storePath));
}

function mockConfigWithAcpOverrides(
  home: string,
  storePath: string,
  acpOverrides: Partial<NonNullable<OpenClawConfig["acp"]>>,
) {
  const cfg = createAcpEnabledConfig(home, storePath);
  cfg.acp = {
    ...cfg.acp,
    ...acpOverrides,
  };
  loadConfigSpy.mockReturnValue(cfg);
}

function writeAcpSessionStore(storePath: string, agent = "codex") {
  const sessionKey = `agent:${agent}:acp:test`;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    storePath,
    JSON.stringify(
      {
        [sessionKey]: {
          acp: {
            agent,
            backend: "acpx",
            lastActivityAt: Date.now(),
            mode: "oneshot",
            runtimeSessionName: sessionKey,
            state: "idle",
          },
          sessionId: "acp-session-1",
          updatedAt: Date.now(),
        },
      },
      null,
      2,
    ),
  );
}

function resolveReadySession(
  sessionKey: string,
  agent = "codex",
): ReturnType<ReturnType<typeof acpManagerModule.getAcpSessionManager>["resolveSession"]> {
  return {
    kind: "ready",
    meta: {
      agent,
      backend: "acpx",
      lastActivityAt: Date.now(),
      mode: "oneshot",
      runtimeSessionName: sessionKey,
      state: "idle",
    },
    sessionKey,
  };
}

function mockAcpManager(params: {
  runTurn: (params: unknown) => Promise<void>;
  resolveSession?: (params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }) => ReturnType<ReturnType<typeof acpManagerModule.getAcpSessionManager>["resolveSession"]>;
}) {
  getAcpSessionManagerSpy.mockReturnValue({
    resolveSession: params.resolveSession ?? ((input) => resolveReadySession(input.sessionKey)),
    runTurn: params.runTurn,
  } as unknown as ReturnType<typeof acpManagerModule.getAcpSessionManager>);
}

async function withAcpSessionEnv(fn: () => Promise<void>) {
  await withTempHome(async (home) => {
    const storePath = path.join(home, "sessions.json");
    writeAcpSessionStore(storePath);
    mockConfig(home, storePath);
    await fn();
  });
}

async function withAcpSessionEnvInfo(
  fn: (env: { home: string; storePath: string }) => Promise<void>,
) {
  await withTempHome(async (home) => {
    const storePath = path.join(home, "sessions.json");
    writeAcpSessionStore(storePath);
    mockConfig(home, storePath);
    await fn({ home, storePath });
  });
}

function createRunTurnFromTextDeltas(chunks: string[]) {
  return vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as {
      onEvent?: (event: { type: string; text?: string; stopReason?: string }) => Promise<void>;
    };
    for (const text of chunks) {
      await params.onEvent?.({ text, type: "text_delta" });
    }
    await params.onEvent?.({ stopReason: "stop", type: "done" });
  });
}

function subscribeAssistantEvents() {
  const assistantEvents: { text?: string; delta?: string }[] = [];
  const stop = onAgentEvent((evt) => {
    if (evt.stream !== "assistant") {
      return;
    }
    assistantEvents.push({
      delta: typeof evt.data?.delta === "string" ? evt.data.delta : undefined,
      text: typeof evt.data?.text === "string" ? evt.data.text : undefined,
    });
  });
  return { assistantEvents, stop };
}

async function runAcpTurnWithAssistantEvents(chunks: string[]) {
  const { assistantEvents, stop } = subscribeAssistantEvents();
  const runTurn = createRunTurnFromTextDeltas(chunks);

  mockAcpManager({
    runTurn: (params: unknown) => runTurn(params),
  });

  try {
    await agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime);
  } finally {
    stop();
  }

  const logLines = vi.mocked(runtime.log).mock.calls.map(([first]) => String(first));
  return { assistantEvents, logLines };
}

async function runAcpTurnWithTextDeltas(params: { message?: string; chunks: string[] }) {
  const runTurn = createRunTurnFromTextDeltas(params.chunks);
  mockAcpManager({
    runTurn: (input: unknown) => runTurn(input),
  });
  await agentCommand(
    {
      message: params.message ?? "ping",
      sessionKey: "agent:codex:acp:test",
    },
    runtime,
  );
  return { runTurn };
}

function expectPersistedAcpTranscript(params: {
  storePath: string;
  userContent: string;
  assistantText: string;
}) {
  const persistedStore = JSON.parse(fs.readFileSync(params.storePath, "utf8")) as Record<
    string,
    { sessionFile?: string }
  >;
  const sessionFile = persistedStore["agent:codex:acp:test"]?.sessionFile;
  const messages = readSessionMessages("acp-session-1", params.storePath, sessionFile);
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({
    content: params.userContent,
    role: "user",
  });
  expect(messages[1]).toMatchObject({
    content: [{ text: params.assistantText, type: "text" }],
    role: "assistant",
  });
}

async function runAcpSessionWithPolicyOverrides(params: {
  acpOverrides: Partial<NonNullable<OpenClawConfig["acp"]>>;
  resolveSession?: Parameters<typeof mockAcpManager>[0]["resolveSession"];
}) {
  await withTempHome(async (home) => {
    const storePath = path.join(home, "sessions.json");
    writeAcpSessionStore(storePath);
    mockConfigWithAcpOverrides(home, storePath, params.acpOverrides);

    const runTurn = vi.fn(async (_params: unknown) => {});
    mockAcpManager({
      runTurn: (input: unknown) => runTurn(input),
      ...(params.resolveSession ? { resolveSession: params.resolveSession } : {}),
    });

    await expect(
      agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime),
    ).rejects.toMatchObject({
      code: "ACP_DISPATCH_DISABLED",
    });
    expect(runTurn).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
  });
}

describe("agentCommand ACP runtime routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runEmbeddedPiAgentSpy.mockResolvedValue({
      meta: {
        durationMs: 5,
      },
      payloads: [{ text: "embedded" }],
    } as never);
  });

  it("routes ACP sessions through AcpSessionManager instead of embedded agent", async () => {
    await withAcpSessionEnv(async () => {
      const { runTurn } = await runAcpTurnWithTextDeltas({ chunks: ["ACP_", "OK"] });

      expect(runTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "prompt",
          sessionKey: "agent:codex:acp:test",
          text: "ping",
        }),
      );
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
      const hasAckLog = vi
        .mocked(runtime.log)
        .mock.calls.some(([first]) => typeof first === "string" && first.includes("ACP_OK"));
      expect(hasAckLog).toBe(true);
    });
  });

  it("persists ACP child session history to the transcript store", async () => {
    await withAcpSessionEnvInfo(async ({ storePath }) => {
      await runAcpTurnWithTextDeltas({ chunks: ["ACP_", "OK"] });
      expectPersistedAcpTranscript({
        assistantText: "ACP_OK",
        storePath,
        userContent: "ping",
      });
    });
  });

  it("preserves exact ACP transcript text without trimming whitespace", async () => {
    await withAcpSessionEnvInfo(async ({ storePath }) => {
      await runAcpTurnWithTextDeltas({
        chunks: ["  ACP_OK\n"],
        message: "  ping\n",
      });
      expectPersistedAcpTranscript({
        assistantText: "  ACP_OK\n",
        storePath,
        userContent: "  ping\n",
      });
    });
  });

  it("suppresses ACP NO_REPLY lead fragments before emitting assistant text", async () => {
    await withAcpSessionEnv(async () => {
      const { assistantEvents, logLines } = await runAcpTurnWithAssistantEvents([
        "NO",
        "NO_",
        "NO_RE",
        "NO_REPLY",
        "Actual answer",
      ]);

      expect(assistantEvents).toEqual([{ delta: "Actual answer", text: "Actual answer" }]);
      expect(logLines.some((line) => line.includes("NO_REPLY"))).toBe(false);
      expect(logLines.some((line) => line.includes("Actual answer"))).toBe(true);
    });
  });

  it("keeps silent-only ACP turns out of assistant output", async () => {
    await withAcpSessionEnv(async () => {
      const { assistantEvents, logLines } = await runAcpTurnWithAssistantEvents([
        "NO",
        "NO_",
        "NO_RE",
        "NO_REPLY",
      ]);
      expect(assistantEvents.map((event) => event.text).filter(Boolean)).toEqual([]);
      expect(logLines.some((line) => line.includes("NO_REPLY"))).toBe(false);
      expect(logLines.some((line) => line.includes("No reply from agent."))).toBe(true);
    });
  });

  it("preserves repeated identical ACP delta chunks", async () => {
    await withAcpSessionEnv(async () => {
      const { assistantEvents, logLines } = await runAcpTurnWithAssistantEvents([
        "b",
        "o",
        "o",
        "k",
      ]);

      expect(assistantEvents).toEqual([
        { delta: "b", text: "b" },
        { delta: "o", text: "bo" },
        { delta: "o", text: "boo" },
        { delta: "k", text: "book" },
      ]);
      expect(logLines.some((line) => line.includes("book"))).toBe(true);
    });
  });

  it("re-emits buffered NO prefix when ACP text becomes visible content", async () => {
    await withAcpSessionEnv(async () => {
      const { assistantEvents, logLines } = await runAcpTurnWithAssistantEvents(["NO", "W"]);

      expect(assistantEvents).toEqual([{ delta: "NOW", text: "NOW" }]);
      expect(logLines.some((line) => line.includes("NOW"))).toBe(true);
    });
  });

  it("fails closed for ACP-shaped session keys missing ACP metadata", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify(
          {
            "agent:codex:acp:stale": {
              sessionId: "stale-1",
              updatedAt: Date.now(),
            },
          },
          null,
          2,
        ),
      );
      mockConfig(home, storePath);

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        resolveSession: ({ sessionKey }) => ({
          kind: "stale",
          sessionKey,
          error: new AcpRuntimeError(
            "ACP_SESSION_INIT_FAILED",
            `ACP metadata is missing for session ${sessionKey}.`,
          ),
        }),
        runTurn: (params: unknown) => runTurn(params),
      });

      await expect(
        agentCommand({ message: "ping", sessionKey: "agent:codex:acp:stale" }, runtime),
      ).rejects.toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
        message: expect.stringContaining("ACP metadata is missing"),
      });
      expect(runTurn).not.toHaveBeenCalled();
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      acpOverrides: { enabled: false } satisfies Partial<NonNullable<OpenClawConfig["acp"]>>,
      name: "blocks ACP turns when ACP is disabled by policy",
    },
    {
      acpOverrides: {
        dispatch: { enabled: false },
      } satisfies Partial<NonNullable<OpenClawConfig["acp"]>>,
      name: "blocks ACP turns when ACP dispatch is disabled by policy",
    },
  ])("$name", async ({ acpOverrides }) => {
    await runAcpSessionWithPolicyOverrides({ acpOverrides });
  });

  it("blocks ACP turns when ACP agent is disallowed by policy", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath);
      mockConfigWithAcpOverrides(home, storePath, {
        allowedAgents: ["claude"],
      });

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        resolveSession: ({ sessionKey }) => resolveReadySession(sessionKey, "codex"),
        runTurn: (params: unknown) => runTurn(params),
      });

      await expect(
        agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime),
      ).rejects.toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
        message: expect.stringContaining("not allowed by policy"),
      });
      expect(runTurn).not.toHaveBeenCalled();
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
  });

  it("allows ACP turns for kimi when policy allowlists kimi", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath, "kimi");
      mockConfigWithAcpOverrides(home, storePath, {
        allowedAgents: ["kimi"],
      });

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        resolveSession: ({ sessionKey }) => resolveReadySession(sessionKey, "kimi"),
        runTurn: (params: unknown) => runTurn(params),
      });

      await agentCommand({ message: "ping", sessionKey: "agent:kimi:acp:test" }, runtime);

      expect(runTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:kimi:acp:test",
          text: "ping",
        }),
      );
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
  });
});
