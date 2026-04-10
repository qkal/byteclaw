import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getModelsCommandSecretTargetIds: vi.fn(),
  getRuntimeConfig: vi.fn(),
  readSourceConfigSnapshotForWrite: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
  setRuntimeConfigSnapshot: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  readSourceConfigSnapshotForWrite: mocks.readSourceConfigSnapshotForWrite,
  setRuntimeConfigSnapshot: mocks.setRuntimeConfigSnapshot,
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../../cli/command-secret-targets.js", () => ({
  getModelsCommandSecretTargetIds: mocks.getModelsCommandSecretTargetIds,
}));

import { loadModelsConfig, loadModelsConfigWithSource } from "./load-config.js";

describe("models load-config", () => {
  const runtimeConfig = {
    models: { providers: { openai: { apiKey: "sk-runtime" } } }, // Pragma: allowlist secret
  };
  const resolvedConfig = {
    models: { providers: { openai: { apiKey: "sk-resolved" } } }, // Pragma: allowlist secret
  };
  const targetIds = new Set(["models.providers.*.apiKey"]);

  function mockResolvedConfigFlow(params: { sourceConfig: unknown; diagnostics: string[] }) {
    mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
    mocks.readSourceConfigSnapshotForWrite.mockResolvedValue({
      snapshot: { resolved: params.sourceConfig, sourceConfig: params.sourceConfig, valid: true },
      writeOptions: {},
    });
    mocks.getModelsCommandSecretTargetIds.mockReturnValue(targetIds);
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      diagnostics: params.diagnostics,
      resolvedConfig,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns source+resolved configs and sets runtime snapshot", async () => {
    const sourceConfig = {
      models: {
        providers: {
          openai: {
            apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" }, // Pragma: allowlist secret
          },
        },
      },
    };
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };

    mockResolvedConfigFlow({ diagnostics: ["diag-one", "diag-two"], sourceConfig });

    const result = await loadModelsConfigWithSource({ commandName: "models list", runtime });

    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
      commandName: "models list",
      config: runtimeConfig,
      targetIds,
    });
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenCalledWith(resolvedConfig, sourceConfig);
    expect(runtime.log).toHaveBeenNthCalledWith(1, "[secrets] diag-one");
    expect(runtime.log).toHaveBeenNthCalledWith(2, "[secrets] diag-two");
    expect(result).toEqual({
      diagnostics: ["diag-one", "diag-two"],
      resolvedConfig,
      sourceConfig,
    });
  });

  it("loadModelsConfig returns resolved config while preserving runtime snapshot behavior", async () => {
    const sourceConfig = { models: { providers: {} } };
    mockResolvedConfigFlow({ diagnostics: [], sourceConfig });

    await expect(loadModelsConfig({ commandName: "models list" })).resolves.toBe(resolvedConfig);
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenCalledWith(resolvedConfig, sourceConfig);
  });
});
