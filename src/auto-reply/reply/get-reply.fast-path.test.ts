import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import {
  initFastReplySessionState,
  markCompleteReplyConfig,
  withFastReplyConfig,
} from "./get-reply-fast-path.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  ensureAgentWorkspace: vi.fn(),
  initSessionState: vi.fn(),
  resolveReplyDirectives: vi.fn(),
}));

vi.mock("../../agents/workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/workspace.js")>();
  return {
    ...actual,
    ensureAgentWorkspace: (...args: unknown[]) => mocks.ensureAgentWorkspace(...args),
  };
});
vi.mock("./directive-handling.defaults.js", () => ({
  resolveDefaultModel: vi.fn(() => ({
    aliasIndex: new Map(),
    defaultModel: "gpt-4o-mini",
    defaultProvider: "openai",
  })),
}));
vi.mock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: (...args: unknown[]) => mocks.resolveReplyDirectives(...args),
}));
vi.mock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: vi.fn(async () => ({ kind: "reply", reply: { text: "ok" } })),
}));
vi.mock("./session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session.js")>();
  return {
    ...actual,
    initSessionState: (...args: unknown[]) => mocks.initSessionState(...args),
  };
});

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let loadConfigMock: typeof import("../../config/config.js").loadConfig;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ loadConfig: loadConfigMock } = await import("../../config/config.js"));
  ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
}

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Body: "hello",
    BodyForAgent: "hello",
    ChatType: "direct",
    CommandBody: "hello",
    From: "telegram:user:42",
    Provider: "telegram",
    RawBody: "hello",
    SessionKey: "agent:main:telegram:123",
    Surface: "telegram",
    Timestamp: 1_710_000_000_000,
    To: "telegram:123",
    ...overrides,
  };
}

describe("getReplyFromConfig fast test bootstrap", () => {
  beforeEach(async () => {
    await loadGetReplyRuntimeForTest();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    mocks.ensureAgentWorkspace.mockReset();
    mocks.initSessionState.mockReset();
    mocks.resolveReplyDirectives.mockReset();
    vi.mocked(loadConfigMock).mockReset();
    vi.mocked(runPreparedReplyMock).mockReset();
    vi.mocked(loadConfigMock).mockReturnValue({});
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    vi.mocked(runPreparedReplyMock).mockResolvedValue({ text: "ok" });
    mocks.initSessionState.mockResolvedValue({
      abortedLastRun: false,
      bodyStripped: "",
      groupResolution: undefined,
      isGroup: false,
      isNewSession: false,
      previousSessionEntry: {},
      resetTriggered: false,
      sessionCtx: {},
      sessionEntry: {},
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:123",
      sessionScope: "per-chat",
      sessionStore: {},
      storePath: "/tmp/sessions.json",
      systemSent: false,
      triggerBodyNormalized: "",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails fast on unmarked config overrides in strict fast-test mode", async () => {
    await expect(getReplyFromConfig(buildCtx(), undefined, {} as OpenClawConfig)).rejects.toThrow(
      /withFastReplyConfig\(\)\/markCompleteReplyConfig\(\)/,
    );
    expect(vi.mocked(loadConfigMock)).not.toHaveBeenCalled();
  });

  it("skips loadConfig, workspace bootstrap, and session bootstrap for marked test configs", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fast-reply-"));
    const cfg = markCompleteReplyConfig({
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-6",
          workspace: path.join(home, "openclaw"),
        },
      },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { store: path.join(home, "sessions.json") },
    } as OpenClawConfig);

    await expect(getReplyFromConfig(buildCtx(), undefined, cfg)).resolves.toEqual({ text: "ok" });
    expect(vi.mocked(loadConfigMock)).not.toHaveBeenCalled();
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
      }),
    );
  });

  it("still merges partial config overrides against loadConfig()", async () => {
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    vi.mocked(loadConfigMock).mockReturnValue({
      channels: {
        telegram: {
          botToken: "resolved-telegram-token",
        },
      },
    } satisfies OpenClawConfig);

    await getReplyFromConfig(buildCtx(), undefined, {
      agents: {
        defaults: {
          userTimezone: "America/New_York",
        },
      },
    } as OpenClawConfig);

    expect(vi.mocked(loadConfigMock)).toHaveBeenCalledOnce();
    expect(mocks.initSessionState).toHaveBeenCalledOnce();
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({
              userTimezone: "America/New_York",
            }),
          }),
          channels: expect.objectContaining({
            telegram: expect.objectContaining({
              botToken: "resolved-telegram-token",
            }),
          }),
        }),
      }),
    );
  });

  it("marks configs through withFastReplyConfig()", async () => {
    const cfg = withFastReplyConfig({ session: { store: "/tmp/sessions.json" } } as OpenClawConfig);

    await expect(getReplyFromConfig(buildCtx(), undefined, cfg)).resolves.toEqual({ text: "ok" });
    expect(vi.mocked(loadConfigMock)).not.toHaveBeenCalled();
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
  });

  it("uses native command target session keys during fast bootstrap", () => {
    const result = initFastReplySessionState({
      agentId: "main",
      cfg: { session: { store: "/tmp/sessions.json" } } as OpenClawConfig,
      commandAuthorized: true,
      ctx: buildCtx({
        CommandSource: "native",
        CommandTargetSessionKey: "agent:main:main",
        SessionKey: "telegram:slash:123",
      }),
      workspaceDir: "/tmp/workspace",
    });

    expect(result.sessionKey).toBe("agent:main:main");
    expect(result.sessionCtx.SessionKey).toBe("agent:main:main");
  });
});
