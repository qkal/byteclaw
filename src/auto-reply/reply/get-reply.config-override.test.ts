import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  initSessionState: vi.fn(),
  resolveReplyDirectives: vi.fn(),
}));
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
vi.mock("./session.js", () => ({
  initSessionState: (...args: unknown[]) => mocks.initSessionState(...args),
}));

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let loadConfigMock: typeof import("../../config/config.js").loadConfig;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ loadConfig: loadConfigMock } = await import("../../config/config.js"));
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

describe("getReplyFromConfig configOverride", () => {
  beforeEach(async () => {
    await loadGetReplyRuntimeForTest();
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
    vi.mocked(loadConfigMock).mockReset();

    vi.mocked(loadConfigMock).mockReturnValue({});
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
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

  it("merges configOverride over fresh loadConfig()", async () => {
    vi.mocked(loadConfigMock).mockReturnValue({
      agents: {
        defaults: {
          userTimezone: "UTC",
        },
      },
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
});
