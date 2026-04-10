import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { checkQmdBinaryAvailability as checkQmdBinaryAvailabilityFn } from "../memory-host-sdk/engine-qmd.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const note = vi.hoisted(() => vi.fn());
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "agent-default"));
const resolveAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent-default"));
const resolveAgentWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/agent-default/workspace"));
const resolveMemorySearchConfig = vi.hoisted(() => vi.fn());
const resolveApiKeyForProvider = vi.hoisted(() => vi.fn());
const resolveActiveMemoryBackendConfig = vi.hoisted(() => vi.fn());
const getActiveMemorySearchManager = vi.hoisted(() => vi.fn());
type CheckQmdBinaryAvailability = typeof checkQmdBinaryAvailabilityFn;
const checkQmdBinaryAvailability = vi.hoisted(() =>
  vi.fn<CheckQmdBinaryAvailability>(async () => ({ available: true })),
);
const auditShortTermPromotionArtifacts = vi.hoisted(() => vi.fn());
const repairShortTermPromotionArtifacts = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider,
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager,
  resolveActiveMemoryBackendConfig,
}));

vi.mock("../memory-host-sdk/engine-qmd.js", () => ({
  checkQmdBinaryAvailability,
}));

vi.mock("../plugin-sdk/memory-core-engine-runtime.js", () => ({
  auditShortTermPromotionArtifacts,
  getBuiltinMemoryEmbeddingProviderDoctorMetadata: vi.fn((provider: string) => {
    if (provider === "gemini") {
      return { authProviderId: "google", envVars: ["GEMINI_API_KEY"] };
    }
    if (provider === "mistral") {
      return { authProviderId: "mistral", envVars: ["MISTRAL_API_KEY"] };
    }
    if (provider === "openai") {
      return { authProviderId: "openai", envVars: ["OPENAI_API_KEY"] };
    }
    return null;
  }),
  listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata: vi.fn(() => [
    {
      authProviderId: "openai",
      envVars: ["OPENAI_API_KEY"],
      providerId: "openai",
      transport: "remote",
    },
    { authProviderId: "local", envVars: [], providerId: "local", transport: "local" },
  ]),
  repairShortTermPromotionArtifacts,
}));

import { noteMemorySearchHealth } from "./doctor-memory-search.js";
import { maybeRepairMemoryRecallHealth, noteMemoryRecallHealth } from "./doctor-memory-search.js";
import { detectLegacyWorkspaceDirs } from "./doctor-workspace.js";

describe("noteMemorySearchHealth", () => {
  const cfg = {} as OpenClawConfig;

  async function expectNoWarningWithConfiguredRemoteApiKey(provider: string) {
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider,
      remote: { apiKey: "from-config" },
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    note.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentDir.mockClear();
    resolveAgentWorkspaceDir.mockClear();
    resolveMemorySearchConfig.mockReset();
    resolveApiKeyForProvider.mockReset();
    resolveApiKeyForProvider.mockRejectedValue(new Error("missing key"));
    resolveActiveMemoryBackendConfig.mockReset();
    resolveActiveMemoryBackendConfig.mockReturnValue({ backend: "builtin", citations: "auto" });
    getActiveMemorySearchManager.mockReset();
    getActiveMemorySearchManager.mockResolvedValue({
      manager: {
        close: vi.fn(async () => {}),
        status: () => ({ backend: "builtin", workspaceDir: "/tmp/agent-default/workspace" }),
      },
    });
    checkQmdBinaryAvailability.mockReset();
    checkQmdBinaryAvailability.mockResolvedValue({ available: true });
    auditShortTermPromotionArtifacts.mockReset();
    auditShortTermPromotionArtifacts.mockResolvedValue({
      conceptTaggedEntryCount: 1,
      entryCount: 1,
      exists: true,
      invalidEntryCount: 0,
      issues: [],
      lockPath: "/tmp/agent-default/workspace/memory/.dreams/short-term-promotion.lock",
      promotedCount: 0,
      spacedEntryCount: 0,
      storePath: "/tmp/agent-default/workspace/memory/.dreams/short-term-recall.json",
    });
    repairShortTermPromotionArtifacts.mockReset();
    repairShortTermPromotionArtifacts.mockResolvedValue({
      changed: false,
      removedInvalidEntries: 0,
      removedStaleLock: false,
      rewroteStore: false,
    });
  });

  it("does not warn when local provider is set with no explicit modelPath (default model fallback)", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "local",
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
  });

  it("warns when local provider with default model but gateway probe reports not ready", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "local",
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, error: "node-llama-cpp not installed", ready: false },
    });

    expect(note).toHaveBeenCalledTimes(1);
    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("gateway reports local embeddings are not ready");
    expect(message).toContain("node-llama-cpp not installed");
  });

  it("does not warn when local provider with default model and gateway probe is ready", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "local",
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: true },
    });

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when local provider has an explicit hf: modelPath", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      local: { modelPath: "hf:some-org/some-model-GGUF/model.gguf" },
      provider: "local",
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when QMD backend is active", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue({
      backend: "qmd",
      citations: "auto",
      qmd: { command: "qmd" },
    });
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "auto",
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
    expect(checkQmdBinaryAvailability).toHaveBeenCalledWith({
      command: "qmd",
      cwd: "/tmp/agent-default/workspace",
      env: process.env,
    });
  });

  it("warns when QMD backend is active but the qmd binary is unavailable", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue({
      backend: "qmd",
      citations: "auto",
      qmd: { command: "qmd" },
    });
    checkQmdBinaryAvailability.mockResolvedValueOnce({
      available: false,
      error: "spawn qmd ENOENT",
    });
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "auto",
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).toHaveBeenCalledTimes(1);
    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("QMD memory backend is configured");
    expect(message).toContain("spawn qmd ENOENT");
    expect(message).toContain("npm install -g @tobilu/qmd");
    expect(message).toContain("bun install -g @tobilu/qmd");
  });

  it("does not warn when remote apiKey is configured for explicit provider", async () => {
    await expectNoWarningWithConfiguredRemoteApiKey("openai");
  });

  it("treats SecretRef remote apiKey as configured for explicit provider", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "openai",
      remote: {
        apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
      },
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("does not warn in auto mode when remote apiKey is configured", async () => {
    await expectNoWarningWithConfiguredRemoteApiKey("auto");
  });

  it("treats SecretRef remote apiKey as configured in auto mode", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "auto",
      remote: {
        apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
      },
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("resolves provider auth from the default agent directory", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "gemini",
      remote: {},
    });
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "k",
      mode: "api-key",
      source: "env: GEMINI_API_KEY",
    });

    await noteMemorySearchHealth(cfg, {});

    expect(resolveApiKeyForProvider).toHaveBeenCalledWith({
      agentDir: "/tmp/agent-default",
      cfg,
      provider: "google",
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("resolves mistral auth for explicit mistral embedding provider", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "mistral",
      remote: {},
    });
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "k",
      mode: "api-key",
      source: "env: MISTRAL_API_KEY",
    });

    await noteMemorySearchHealth(cfg);

    expect(resolveApiKeyForProvider).toHaveBeenCalledWith({
      agentDir: "/tmp/agent-default",
      cfg,
      provider: "mistral",
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("notes when gateway probe reports embeddings ready and CLI API key is missing", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "gemini",
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: true },
    });

    const message = note.mock.calls[0]?.[0] as string;
    expect(message).toContain("reports memory embeddings are ready");
  });

  it("uses model configure hint when gateway probe is unavailable and API key is missing", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "gemini",
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: {
        checked: true,
        error: "gateway memory probe unavailable: timeout",
        ready: false,
      },
    });

    const message = note.mock.calls[0]?.[0] as string;
    expect(message).toContain("Gateway memory probe for default agent is not ready");
    expect(message).toContain("openclaw configure --section model");
    expect(message).not.toContain("openclaw auth add --provider");
  });

  it("warns in auto mode when no local modelPath and no API keys are configured", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "auto",
      remote: {},
    });

    await noteMemorySearchHealth(cfg);

    // In auto mode, canAutoSelectLocal requires an explicit local file path.
    // DEFAULT_LOCAL_MODEL fallback does NOT apply to auto — only to explicit
    // Provider: "local". So with no local file and no API keys, warn.
    expect(note).toHaveBeenCalledTimes(1);
    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("needs at least one embedding provider");
    expect(message).toContain("openclaw configure --section model");
  });

  it("still warns in auto mode when only ollama credentials exist", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "auto",
      remote: {},
    });
    resolveApiKeyForProvider.mockImplementation(async ({ provider }: { provider: string }) => {
      if (provider === "ollama") {
        return {
          apiKey: "ollama-local", // Pragma: allowlist secret
          source: "env: OLLAMA_API_KEY",
          mode: "api-key",
        };
      }
      throw new Error("missing key");
    });

    await noteMemorySearchHealth(cfg);

    expect(note).toHaveBeenCalledTimes(1);
    const providerCalls = resolveApiKeyForProvider.mock.calls as [{ provider: string }][];
    const providersChecked = providerCalls.map(([arg]) => arg.provider);
    expect(providersChecked).toEqual(["openai"]);
  });

  it("uses runtime-derived env var hints for explicit providers", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "gemini",
      remote: {},
    });

    await noteMemorySearchHealth(cfg);

    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("GEMINI_API_KEY");
    expect(message).toContain('provider is set to "gemini"');
  });

  it("uses runtime-derived env var hints in auto mode", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      local: {},
      provider: "auto",
      remote: {},
    });

    await noteMemorySearchHealth(cfg);

    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("OPENAI_API_KEY");
  });
});

describe("memory recall doctor integration", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    note.mockClear();
    auditShortTermPromotionArtifacts.mockReset();
    auditShortTermPromotionArtifacts.mockResolvedValue({
      conceptTaggedEntryCount: 1,
      entryCount: 1,
      exists: true,
      invalidEntryCount: 0,
      issues: [],
      lockPath: "/tmp/agent-default/workspace/memory/.dreams/short-term-promotion.lock",
      promotedCount: 0,
      spacedEntryCount: 0,
      storePath: "/tmp/agent-default/workspace/memory/.dreams/short-term-recall.json",
    });
    repairShortTermPromotionArtifacts.mockReset();
    repairShortTermPromotionArtifacts.mockResolvedValue({
      changed: false,
      removedInvalidEntries: 0,
      removedStaleLock: false,
      rewroteStore: false,
    });
  });

  function createPrompter(overrides: Partial<DoctorPrompter> = {}): DoctorPrompter {
    return {
      confirm: vi.fn(async () => true),
      confirmAggressiveAutoFix: vi.fn(async () => true),
      confirmAutoFix: vi.fn(async () => true),
      confirmRuntimeRepair: vi.fn(async () => true),
      repairMode: {
        canPrompt: true,
        nonInteractive: false,
        shouldForce: false,
        shouldRepair: true,
        updateInProgress: false,
      },
      select: vi.fn(async (_params, fallback) => fallback),
      shouldForce: false,
      shouldRepair: true,
      ...overrides,
    };
  }

  it("notes recall-store audit problems with doctor guidance", async () => {
    auditShortTermPromotionArtifacts.mockResolvedValueOnce({
      conceptTaggedEntryCount: 10,
      entryCount: 12,
      exists: true,
      invalidEntryCount: 1,
      issues: [
        {
          code: "recall-store-invalid",
          fixable: true,
          message: "Short-term recall store contains 1 invalid entry.",
          severity: "warn",
        },
        {
          code: "recall-lock-stale",
          fixable: true,
          message: "Short-term promotion lock appears stale.",
          severity: "warn",
        },
      ],
      lockPath: "/tmp/agent-default/workspace/memory/.dreams/short-term-promotion.lock",
      promotedCount: 4,
      spacedEntryCount: 2,
      storePath: "/tmp/agent-default/workspace/memory/.dreams/short-term-recall.json",
    });

    await noteMemoryRecallHealth(cfg);

    expect(auditShortTermPromotionArtifacts).toHaveBeenCalledWith({
      qmd: undefined,
      workspaceDir: "/tmp/agent-default/workspace",
    });
    expect(note).toHaveBeenCalledTimes(1);
    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("Memory recall artifacts need attention:");
    expect(message).toContain("doctor --fix");
    expect(message).toContain("memory status --fix");
  });

  it("runs memory recall repair during doctor --fix", async () => {
    auditShortTermPromotionArtifacts.mockResolvedValueOnce({
      conceptTaggedEntryCount: 10,
      entryCount: 12,
      exists: true,
      invalidEntryCount: 1,
      issues: [
        {
          code: "recall-store-invalid",
          fixable: true,
          message: "Short-term recall store contains 1 invalid entry.",
          severity: "warn",
        },
      ],
      lockPath: "/tmp/agent-default/workspace/memory/.dreams/short-term-promotion.lock",
      promotedCount: 4,
      spacedEntryCount: 2,
      storePath: "/tmp/agent-default/workspace/memory/.dreams/short-term-recall.json",
    });
    repairShortTermPromotionArtifacts.mockResolvedValueOnce({
      changed: true,
      removedInvalidEntries: 1,
      removedStaleLock: true,
      rewroteStore: true,
    });
    const prompter = createPrompter();

    await maybeRepairMemoryRecallHealth({ cfg, prompter });

    expect(prompter.confirmRuntimeRepair).toHaveBeenCalled();
    expect(repairShortTermPromotionArtifacts).toHaveBeenCalledWith({
      workspaceDir: "/tmp/agent-default/workspace",
    });
    expect(note).toHaveBeenCalledTimes(1);
    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("Memory recall artifacts repaired:");
    expect(message).toContain("rewrote recall store");
    expect(message).toContain("removed stale promotion lock");
  });
});

describe("detectLegacyWorkspaceDirs", () => {
  it("returns active workspace and no legacy dirs", () => {
    const workspaceDir = "/home/user/openclaw";
    const detection = detectLegacyWorkspaceDirs({ workspaceDir });
    expect(detection.activeWorkspace).toBe(path.resolve(workspaceDir));
    expect(detection.legacyDirs).toEqual([]);
  });
});
