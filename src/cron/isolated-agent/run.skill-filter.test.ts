import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  buildWorkspaceSkillSnapshotMock,
  getCliSessionIdMock,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  lookupContextTokensMock,
  makeCronSession,
  makeCronSessionEntry,
  resolveAgentConfigMock,
  resolveAgentSkillsFilterMock,
  resolveAllowedModelRefMock,
  resolveCronSessionMock,
  runCliAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const makeSkillJob = makeIsolatedAgentTurnJob;
const makeSkillParams = makeIsolatedAgentTurnParams;

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — skill filter", () => {
  setupRunCronIsolatedAgentTurnSuite();

  async function runSkillFilterCase(overrides?: Record<string, unknown>) {
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams(overrides));
    expect(result.status).toBe("ok");
    return result;
  }

  function expectDefaultModelCall(params: { primary: string; fallbacks: string[] }) {
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    const callCfg = runWithModelFallbackMock.mock.calls[0][0].cfg;
    const model = callCfg?.agents?.defaults?.model as { primary?: string; fallbacks?: string[] };
    expect(model?.primary).toBe(params.primary);
    expect(model?.fallbacks).toEqual(params.fallbacks);
  }

  function mockCliFallbackInvocation() {
    runWithModelFallbackMock.mockImplementationOnce(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        const result = await params.run("claude-cli", "claude-opus-4-6");
        return { attempts: [], model: "claude-opus-4-6", provider: "claude-cli", result };
      },
    );
  }

  it("passes agent-level skillFilter to buildWorkspaceSkillSnapshot", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue(["meme-factory", "weather"]);

    await runSkillFilterCase({
      agentId: "scout",
      cfg: { agents: { list: [{ id: "scout", skills: ["meme-factory", "weather"] }] } },
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    expect(buildWorkspaceSkillSnapshotMock.mock.calls[0][1]).toHaveProperty("skillFilter", [
      "meme-factory",
      "weather",
    ]);
  });

  it("omits skillFilter when agent has no skills config", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue(undefined);

    await runSkillFilterCase({
      agentId: "general",
      cfg: { agents: { list: [{ id: "general" }] } },
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    // When no skills config, skillFilter should be undefined (no filtering applied)
    expect(buildWorkspaceSkillSnapshotMock.mock.calls[0][1].skillFilter).toBeUndefined();
  });

  it("passes empty skillFilter when agent explicitly disables all skills", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue([]);

    await runSkillFilterCase({
      agentId: "silent",
      cfg: { agents: { list: [{ id: "silent", skills: [] }] } },
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    // Explicit empty skills list should forward [] to filter out all skills
    expect(buildWorkspaceSkillSnapshotMock.mock.calls[0][1]).toHaveProperty("skillFilter", []);
  });

  it("refreshes cached snapshot when skillFilter changes without version bump", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue(["weather"]);
    resolveCronSessionMock.mockReturnValue({
      isNewSession: true,
      sessionEntry: {
        sessionId: "test-session-id",
        skillsSnapshot: {
          prompt: "<available_skills><skill>meme-factory</skill></available_skills>",
          skills: [{ name: "meme-factory" }],
          version: 42,
        },
        systemSent: false,
        updatedAt: 0,
      },
      store: {},
      storePath: "/tmp/store.json",
      systemSent: false,
    });

    await runSkillFilterCase({
      agentId: "weather-bot",
      cfg: { agents: { list: [{ id: "weather-bot", skills: ["weather"] }] } },
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    expect(buildWorkspaceSkillSnapshotMock.mock.calls[0][1]).toHaveProperty("skillFilter", [
      "weather",
    ]);
  });

  it("forces a fresh session for isolated cron runs", async () => {
    await runSkillFilterCase();
    expect(resolveCronSessionMock).toHaveBeenCalledOnce();
    expect(resolveCronSessionMock.mock.calls[0]?.[0]).toMatchObject({
      forceNew: true,
    });
  });

  it("reuses cached snapshot when version and normalized skillFilter are unchanged", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue([" weather ", "meme-factory", "weather"]);
    resolveCronSessionMock.mockReturnValue({
      isNewSession: true,
      sessionEntry: {
        sessionId: "test-session-id",
        skillsSnapshot: {
          prompt: "<available_skills><skill>weather</skill></available_skills>",
          skillFilter: ["meme-factory", "weather"],
          skills: [{ name: "weather" }],
          version: 42,
        },
        systemSent: false,
        updatedAt: 0,
      },
      store: {},
      storePath: "/tmp/store.json",
      systemSent: false,
    });

    await runSkillFilterCase({
      agentId: "weather-bot",
      cfg: { agents: { list: [{ id: "weather-bot", skills: ["weather", "meme-factory"] }] } },
    });
    expect(buildWorkspaceSkillSnapshotMock).not.toHaveBeenCalled();
  });

  describe("model fallbacks", () => {
    const defaultFallbacks = [
      "anthropic/claude-opus-4-6",
      "google-gemini-cli/gemini-3-pro-preview",
      "nvidia/deepseek-ai/deepseek-v3.2",
    ];

    async function expectPrimaryOverridePreservesDefaults(modelOverride: unknown) {
      resolveAgentConfigMock.mockReturnValue({ model: modelOverride });
      await runSkillFilterCase({
        agentId: "scout",
        cfg: {
          agents: {
            defaults: {
              model: { fallbacks: defaultFallbacks, primary: "openai-codex/gpt-5.4" },
            },
          },
        },
      });

      expectDefaultModelCall({
        fallbacks: defaultFallbacks,
        primary: "anthropic/claude-sonnet-4-6",
      });
    }

    it("preserves defaults when agent overrides primary as string", async () => {
      await expectPrimaryOverridePreservesDefaults("anthropic/claude-sonnet-4-6");
    });

    it("preserves defaults when agent overrides primary in object form", async () => {
      await expectPrimaryOverridePreservesDefaults({ primary: "anthropic/claude-sonnet-4-6" });
    });

    it("applies payload.model override when model is allowed", async () => {
      resolveAllowedModelRefMock.mockReturnValueOnce({
        ref: { model: "claude-sonnet-4-6", provider: "anthropic" },
      });

      const result = await runCronIsolatedAgentTurn(
        makeSkillParams({
          job: makeSkillJob({
            payload: { kind: "agentTurn", message: "test", model: "anthropic/claude-sonnet-4-6" },
          }),
        }),
      );

      expect(result.status).toBe("ok");
      expect(logWarnMock).not.toHaveBeenCalled();
      expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
      const runParams = runWithModelFallbackMock.mock.calls[0][0];
      expect(runParams.provider).toBe("anthropic");
      expect(runParams.model).toBe("claude-sonnet-4-6");
    });

    it("falls back to agent defaults when payload.model is not allowed", async () => {
      resolveAllowedModelRefMock.mockReturnValueOnce({
        error: "model not allowed: anthropic/claude-sonnet-4-6",
      });

      await runSkillFilterCase({
        cfg: {
          agents: {
            defaults: {
              model: { fallbacks: defaultFallbacks, primary: "openai-codex/gpt-5.4" },
            },
          },
        },
        job: makeSkillJob({
          payload: { kind: "agentTurn", message: "test", model: "anthropic/claude-sonnet-4-6" },
        }),
      });
      expect(logWarnMock).toHaveBeenCalledWith(
        "cron: payload.model 'anthropic/claude-sonnet-4-6' not allowed, falling back to agent defaults",
      );
      expectDefaultModelCall({
        fallbacks: defaultFallbacks,
        primary: "openai-codex/gpt-5.4",
      });
    });

    it("returns an error when payload.model is invalid", async () => {
      resolveAllowedModelRefMock.mockReturnValueOnce({
        error: "invalid model: openai/",
      });

      const result = await runCronIsolatedAgentTurn(
        makeSkillParams({
          job: makeSkillJob({
            payload: { kind: "agentTurn", message: "test", model: "openai/" },
          }),
        }),
      );

      expect(result.status).toBe("error");
      expect(result.error).toBe("invalid model: openai/");
      expect(logWarnMock).not.toHaveBeenCalled();
      expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    });
  });

  describe("CLI session handoff (issue #29774)", () => {
    it("does not pass stored cliSessionId on fresh isolated runs (isNewSession=true)", async () => {
      // Simulate a persisted CLI session ID from a previous run.
      getCliSessionIdMock.mockReturnValue("prev-cli-session-abc");
      isCliProviderMock.mockReturnValue(true);
      runCliAgentMock.mockResolvedValue({
        meta: { agentMeta: { sessionId: "new-cli-session-xyz", usage: { input: 5, output: 10 } } },
        payloads: [{ text: "output" }],
      });
      // Make runWithModelFallback invoke the run callback so the CLI path executes.
      mockCliFallbackInvocation();
      resolveCronSessionMock.mockReturnValue({
        isNewSession: true,
        sessionEntry: {
          sessionId: "test-session-fresh",
          updatedAt: 0,
          systemSent: false,
          skillsSnapshot: undefined,
          // A stored CLI session ID that should NOT be reused on fresh runs.
          cliSessionIds: { "claude-cli": "prev-cli-session-abc" },
        },
        store: {},
        storePath: "/tmp/store.json",
        systemSent: false,
      });

      await runCronIsolatedAgentTurn(makeSkillParams());

      expect(runCliAgentMock).toHaveBeenCalledOnce();
      // Fresh session: cliSessionId must be undefined, not the stored value.
      expect(runCliAgentMock.mock.calls[0][0]).toHaveProperty("cliSessionId", undefined);
    });

    it("reuses stored cliSessionId on continuation runs (isNewSession=false)", async () => {
      getCliSessionIdMock.mockReturnValue("existing-cli-session-def");
      isCliProviderMock.mockReturnValue(true);
      runCliAgentMock.mockResolvedValue({
        meta: {
          agentMeta: { sessionId: "existing-cli-session-def", usage: { input: 5, output: 10 } },
        },
        payloads: [{ text: "output" }],
      });
      mockCliFallbackInvocation();
      resolveCronSessionMock.mockReturnValue({
        isNewSession: false,
        sessionEntry: {
          cliSessionIds: { "claude-cli": "existing-cli-session-def" },
          sessionId: "test-session-continuation",
          skillsSnapshot: undefined,
          systemSent: false,
          updatedAt: 0,
        },
        store: {},
        storePath: "/tmp/store.json",
        systemSent: false,
      });

      await runCronIsolatedAgentTurn(makeSkillParams());

      expect(runCliAgentMock).toHaveBeenCalledOnce();
      // Continuation: cliSessionId should be passed through for session resume.
      expect(runCliAgentMock.mock.calls[0][0]).toHaveProperty(
        "cliSessionId",
        "existing-cli-session-def",
      );
    });
  });

  describe("context token fallback", () => {
    it("preserves existing session contextTokens when no configured or cached model window is loaded", async () => {
      const session = makeCronSession({
        sessionEntry: makeCronSessionEntry({
          contextTokens: 222_000,
        }),
      });
      resolveCronSessionMock.mockReturnValue(session);
      lookupContextTokensMock.mockReturnValue(undefined);

      const result = await runSkillFilterCase();

      expect(result.status).toBe("ok");
      expect(session.sessionEntry.contextTokens).toBe(222_000);
    });

    it("prefers sync-configured model contextTokens over the previous session value", async () => {
      const session = makeCronSession({
        sessionEntry: makeCronSessionEntry({
          contextTokens: 222_000,
        }),
      });
      resolveCronSessionMock.mockReturnValue(session);
      lookupContextTokensMock.mockReturnValue(512_000);

      const result = await runSkillFilterCase();

      expect(result.status).toBe("ok");
      expect(session.sessionEntry.contextTokens).toBe(512_000);
      expect(lookupContextTokensMock).toHaveBeenCalledWith("gpt-4", {
        allowAsyncLoad: false,
      });
    });
  });
});
