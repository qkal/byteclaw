import { beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.js";

const state = vi.hoisted(() => ({
  abortEmbeddedPiRunMock: vi.fn(),
  consumeEmbeddedRunModelSwitchMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  piEmbeddedModuleImported: false,
  requestEmbeddedRunModelSwitchMock: vi.fn(),
  resolveDefaultModelForAgentMock: vi.fn(),
  resolvePersistedSelectedModelRefMock: vi.fn(),
  resolveStorePathMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
}));

vi.mock("./pi-embedded.js", () => {
  state.piEmbeddedModuleImported = true;
  return {};
});

vi.mock("./pi-embedded-runner/runs.js", () => ({
  abortEmbeddedPiRun: (...args: unknown[]) => state.abortEmbeddedPiRunMock(...args),
  consumeEmbeddedRunModelSwitch: (...args: unknown[]) =>
    state.consumeEmbeddedRunModelSwitchMock(...args),
  requestEmbeddedRunModelSwitch: (...args: unknown[]) =>
    state.requestEmbeddedRunModelSwitchMock(...args),
}));

vi.mock("./model-selection.js", () => ({
  normalizeStoredOverrideModel: (params: { providerOverride?: string; modelOverride?: string }) => {
    const providerOverride = params.providerOverride?.trim();
    const modelOverride = params.modelOverride?.trim();
    if (!providerOverride || !modelOverride) {
      return {
        modelOverride,
        providerOverride,
      };
    }
    const providerPrefix = `${providerOverride.toLowerCase()}/`;
    return {
      modelOverride: modelOverride.toLowerCase().startsWith(providerPrefix)
        ? modelOverride.slice(providerOverride.length + 1).trim() || modelOverride
        : modelOverride,
      providerOverride,
    };
  },
  resolveDefaultModelForAgent: (...args: unknown[]) =>
    state.resolveDefaultModelForAgentMock(...args),
  resolvePersistedSelectedModelRef: (...args: unknown[]) =>
    state.resolvePersistedSelectedModelRefMock(...args),
}));

vi.mock("../config/sessions/store.js", () => ({
  loadSessionStore: (...args: unknown[]) => state.loadSessionStoreMock(...args),
  updateSessionStore: (...args: unknown[]) => state.updateSessionStoreMock(...args),
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: (...args: unknown[]) => state.resolveStorePathMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: (...args: unknown[]) => state.loadSessionStoreMock(...args),
  resolveStorePath: (...args: unknown[]) => state.resolveStorePathMock(...args),
  updateSessionStore: (...args: unknown[]) => state.updateSessionStoreMock(...args),
}));

async function loadModule() {
  return await importFreshModule<typeof import("./live-model-switch.js")>(
    import.meta.url,
    `./live-model-switch.js?scope=${Math.random().toString(36).slice(2)}`,
  );
}

describe("live model switch", () => {
  beforeEach(() => {
    state.abortEmbeddedPiRunMock.mockReset().mockReturnValue(false);
    state.requestEmbeddedRunModelSwitchMock.mockReset();
    state.consumeEmbeddedRunModelSwitchMock.mockReset();
    state.piEmbeddedModuleImported = false;
    state.resolveDefaultModelForAgentMock
      .mockReset()
      .mockReturnValue({ model: "claude-opus-4-6", provider: "anthropic" });
    state.resolvePersistedSelectedModelRefMock
      .mockReset()
      .mockImplementation(
        (params: {
          defaultProvider: string;
          runtimeProvider?: string;
          runtimeModel?: string;
          overrideProvider?: string;
          overrideModel?: string;
        }) => {
          const defaultProvider = params.defaultProvider.trim();
          const overrideProvider = params.overrideProvider?.trim();
          const overrideModel = params.overrideModel?.trim();
          if (overrideModel) {
            if (overrideProvider) {
              return { model: overrideModel, provider: overrideProvider };
            }
            const slash = overrideModel.indexOf("/");
            if (slash <= 0 || slash === overrideModel.length - 1) {
              return { model: overrideModel, provider: defaultProvider };
            }
            return {
              model: overrideModel.slice(slash + 1),
              provider: overrideModel.slice(0, slash),
            };
          }
          const runtimeProvider = params.runtimeProvider?.trim();
          const runtimeModel = params.runtimeModel?.trim();
          if (runtimeModel) {
            if (runtimeProvider) {
              return { model: runtimeModel, provider: runtimeProvider };
            }
            const slash = runtimeModel.indexOf("/");
            if (slash <= 0 || slash === runtimeModel.length - 1) {
              return { model: runtimeModel, provider: defaultProvider };
            }
            return {
              model: runtimeModel.slice(slash + 1),
              provider: runtimeModel.slice(0, slash),
            };
          }
          return null;
        },
      );
    state.loadSessionStoreMock.mockReset().mockReturnValue({});
    state.resolveStorePathMock.mockReset().mockReturnValue("/tmp/session-store.json");
    state.updateSessionStoreMock
      .mockReset()
      .mockImplementation(
        async (_path: string, updater: (store: Record<string, unknown>) => void) => {
          const store: Record<string, unknown> = {};
          updater(store);
        },
      );
  });
  it("resolves persisted session overrides ahead of agent defaults", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        authProfileOverride: "profile-gpt",
        authProfileOverrideSource: "user",
        modelOverride: "gpt-5.4",
        providerOverride: "openai",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        agentId: "reply",
        cfg: { session: { store: "/tmp/custom-store.json" } },
        defaultModel: "claude-opus-4-6",
        defaultProvider: "anthropic",
        sessionKey: "main",
      }),
    ).toEqual({
      authProfileId: "profile-gpt",
      authProfileIdSource: "user",
      model: "gpt-5.4",
      provider: "openai",
    });
    expect(state.resolveDefaultModelForAgentMock).toHaveBeenCalledWith({
      agentId: "reply",
      cfg: { session: { store: "/tmp/custom-store.json" } },
    });
    expect(state.resolveStorePathMock).toHaveBeenCalledWith("/tmp/custom-store.json", {
      agentId: "reply",
    });
  });

  it("prefers persisted session overrides ahead of stale runtime model fields", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        model: "claude-sonnet-4-6",
        modelOverride: "claude-opus-4-6",
        modelProvider: "anthropic",
        providerOverride: "anthropic",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        agentId: "reply",
        cfg: { session: { store: "/tmp/custom-store.json" } },
        defaultModel: "gpt-5.4",
        defaultProvider: "openai",
        sessionKey: "main",
      }),
    ).toEqual({
      authProfileId: undefined,
      authProfileIdSource: undefined,
      model: "claude-opus-4-6",
      provider: "anthropic",
    });
  });

  it("splits legacy combined session overrides when providerOverride is missing", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        modelOverride: "ollama-beelink2/qwen2.5-coder:7b",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        agentId: "reply",
        cfg: { session: { store: "/tmp/custom-store.json" } },
        defaultModel: "claude-opus-4-6",
        defaultProvider: "anthropic",
        sessionKey: "main",
      }),
    ).toEqual({
      authProfileId: undefined,
      authProfileIdSource: undefined,
      model: "qwen2.5-coder:7b",
      provider: "ollama-beelink2",
    });
  });

  it("preserves provider when runtime model is a vendor-prefixed OpenRouter id", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        model: "anthropic/claude-haiku-4.5",
        modelProvider: "openrouter",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        agentId: "reply",
        cfg: { session: { store: "/tmp/custom-store.json" } },
        defaultModel: "claude-opus-4-6",
        defaultProvider: "anthropic",
        sessionKey: "main",
      }),
    ).toEqual({
      authProfileId: undefined,
      authProfileIdSource: undefined,
      model: "anthropic/claude-haiku-4.5",
      provider: "openrouter",
    });
  });

  it("keeps nested model ids under the persisted provider override", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        modelOverride: "moonshotai/kimi-k2.5",
        providerOverride: "nvidia",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        agentId: "reply",
        cfg: { session: { store: "/tmp/custom-store.json" } },
        defaultModel: "claude-opus-4-6",
        defaultProvider: "anthropic",
        sessionKey: "main",
      }),
    ).toEqual({
      authProfileId: undefined,
      authProfileIdSource: undefined,
      model: "moonshotai/kimi-k2.5",
      provider: "nvidia",
    });
  });

  it("strips duplicated provider prefixes from persisted overrides", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        modelOverride: "openai-codex/gpt-5.4",
        providerOverride: "openai-codex",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        agentId: "reply",
        cfg: { session: { store: "/tmp/custom-store.json" } },
        defaultModel: "claude-opus-4-6",
        defaultProvider: "anthropic",
        sessionKey: "main",
      }),
    ).toEqual({
      authProfileId: undefined,
      authProfileIdSource: undefined,
      model: "gpt-5.4",
      provider: "openai-codex",
    });
  });

  it("routes normalized overrides back through persisted ref resolution", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        modelOverride: "z-ai/deepseek-chat",
        providerOverride: "z-ai",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    resolveLiveSessionModelSelection({
      agentId: "reply",
      cfg: { session: { store: "/tmp/custom-store.json" } },
      defaultModel: "claude-opus-4-6",
      defaultProvider: "anthropic",
      sessionKey: "main",
    });

    expect(state.resolvePersistedSelectedModelRefMock).toHaveBeenCalledWith({
      defaultProvider: "anthropic",
      overrideModel: "deepseek-chat",
      overrideProvider: "z-ai",
      runtimeModel: undefined,
      runtimeProvider: undefined,
    });
  });

  it("queues a live switch only when an active run was aborted", async () => {
    state.abortEmbeddedPiRunMock.mockReturnValue(true);

    const { requestLiveSessionModelSwitch } = await loadModule();

    expect(
      requestLiveSessionModelSwitch({
        selection: { authProfileId: "profile-gpt", model: "gpt-5.4", provider: "openai" },
        sessionEntry: { sessionId: "session-1" },
      }),
    ).toBe(true);
    expect(state.abortEmbeddedPiRunMock).toHaveBeenCalledWith("session-1");
    expect(state.requestEmbeddedRunModelSwitchMock).toHaveBeenCalledWith("session-1", {
      authProfileId: "profile-gpt",
      model: "gpt-5.4",
      provider: "openai",
    });
  });

  it("does not import the broad pi-embedded barrel on module load", async () => {
    await loadModule();

    expect(state.piEmbeddedModuleImported).toBe(false);
  });

  it("treats auth-profile-source changes as no-op when no auth profile is selected", async () => {
    const { hasDifferentLiveSessionModelSelection } = await loadModule();

    expect(
      hasDifferentLiveSessionModelSelection(
        {
          authProfileIdSource: "auto",
          model: "gpt-5.4",
          provider: "openai",
        },
        {
          model: "gpt-5.4",
          provider: "openai",
        },
      ),
    ).toBe(false);
  });

  it("does not track persisted live selection when the run started on a transient model override", async () => {
    const { shouldTrackPersistedLiveSessionModelSelection } = await loadModule();

    expect(
      shouldTrackPersistedLiveSessionModelSelection(
        {
          model: "claude-haiku-4-5",
          provider: "anthropic",
        },
        {
          model: "claude-sonnet-4-6",
          provider: "anthropic",
        },
      ),
    ).toBe(false);
  });

  describe("shouldSwitchToLiveModel", () => {
    it("returns the persisted selection when liveModelSwitchPending is true and model differs", async () => {
      state.loadSessionStoreMock.mockReturnValue({
        main: {
          liveModelSwitchPending: true,
          modelOverride: "gpt-5.4",
          providerOverride: "openai",
        },
      });

      const { shouldSwitchToLiveModel } = await loadModule();

      const result = shouldSwitchToLiveModel({
        agentId: "reply",
        cfg: { session: { store: "/tmp/custom-store.json" } },
        currentModel: "claude-opus-4-6",
        currentProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
        defaultProvider: "anthropic",
        sessionKey: "main",
      });

      expect(result).toEqual({
        authProfileId: undefined,
        authProfileIdSource: undefined,
        model: "gpt-5.4",
        provider: "openai",
      });
    });

    it("returns undefined when liveModelSwitchPending is false", async () => {
      state.loadSessionStoreMock.mockReturnValue({
        main: {
          modelOverride: "gpt-5.4",
          providerOverride: "openai",
        },
      });

      const { shouldSwitchToLiveModel } = await loadModule();

      const result = shouldSwitchToLiveModel({
        agentId: "reply",
        cfg: { session: { store: "/tmp/custom-store.json" } },
        currentModel: "claude-opus-4-6",
        currentProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
        defaultProvider: "anthropic",
        sessionKey: "main",
      });

      expect(result).toBeUndefined();
    });

    it("returns undefined when liveModelSwitchPending is true but models match", async () => {
      state.loadSessionStoreMock.mockReturnValue({
        main: {
          liveModelSwitchPending: true,
          modelOverride: "claude-opus-4-6",
          providerOverride: "anthropic",
        },
      });

      const { shouldSwitchToLiveModel } = await loadModule();

      const result = shouldSwitchToLiveModel({
        agentId: "reply",
        cfg: { session: { store: "/tmp/custom-store.json" } },
        currentModel: "claude-opus-4-6",
        currentProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
        defaultProvider: "anthropic",
        sessionKey: "main",
      });

      expect(result).toBeUndefined();
    });

    it("clears the stale liveModelSwitchPending flag when models already match", async () => {
      const sessionEntry = {
        liveModelSwitchPending: true,
        modelOverride: "claude-opus-4-6",
        providerOverride: "anthropic",
      };
      state.loadSessionStoreMock.mockReturnValue({ main: sessionEntry });
      state.updateSessionStoreMock.mockImplementation(
        async (_path: string, updater: (store: Record<string, unknown>) => void) => {
          const store: Record<string, typeof sessionEntry> = { main: sessionEntry };
          updater(store);
        },
      );

      const { shouldSwitchToLiveModel } = await loadModule();

      const result = shouldSwitchToLiveModel({
        agentId: "reply",
        cfg: { session: { store: "/tmp/custom-store.json" } },
        currentModel: "claude-opus-4-6",
        currentProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
        defaultProvider: "anthropic",
        sessionKey: "main",
      });

      expect(result).toBeUndefined();
      // Give the fire-and-forget clearLiveModelSwitchPending a tick to resolve
      await new Promise((r) => setTimeout(r, 10));
      expect(state.updateSessionStoreMock).toHaveBeenCalledTimes(1);
      expect(sessionEntry).not.toHaveProperty("liveModelSwitchPending");
    });

    it("returns undefined when sessionKey is missing", async () => {
      const { shouldSwitchToLiveModel } = await loadModule();

      const result = shouldSwitchToLiveModel({
        agentId: "reply",
        cfg: { session: { store: "/tmp/custom-store.json" } },
        currentModel: "claude-opus-4-6",
        currentProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
        defaultProvider: "anthropic",
        sessionKey: undefined,
      });

      expect(result).toBeUndefined();
    });
  });

  describe("clearLiveModelSwitchPending", () => {
    it("calls updateSessionStore to clear the flag", async () => {
      const { clearLiveModelSwitchPending } = await loadModule();

      await clearLiveModelSwitchPending({
        agentId: "reply",
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
      });

      expect(state.updateSessionStoreMock).toHaveBeenCalledTimes(1);
      expect(state.resolveStorePathMock).toHaveBeenCalledWith("/tmp/custom-store.json", {
        agentId: "reply",
      });
    });

    it("deletes liveModelSwitchPending from the session entry", async () => {
      const sessionEntry = { liveModelSwitchPending: true, sessionId: "s-1" };
      state.updateSessionStoreMock.mockImplementation(
        async (_path: string, updater: (store: Record<string, unknown>) => void) => {
          const store: Record<string, typeof sessionEntry> = { main: sessionEntry };
          updater(store);
        },
      );

      const { clearLiveModelSwitchPending } = await loadModule();

      await clearLiveModelSwitchPending({
        agentId: "reply",
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
      });

      expect(sessionEntry).not.toHaveProperty("liveModelSwitchPending");
    });

    it("is a no-op when sessionKey is missing", async () => {
      const { clearLiveModelSwitchPending } = await loadModule();

      await clearLiveModelSwitchPending({
        agentId: "reply",
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: undefined,
      });

      expect(state.updateSessionStoreMock).not.toHaveBeenCalled();
    });
  });
});
