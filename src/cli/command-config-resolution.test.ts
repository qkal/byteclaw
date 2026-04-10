import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyPluginAutoEnable: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
}));

vi.mock("./command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

import { resolveCommandConfigWithSecrets } from "./command-config-resolution.js";

describe("resolveCommandConfigWithSecrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs diagnostics and preserves resolved config when auto-enable is off", async () => {
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } as const;
    const config = { channels: {} };
    const resolvedConfig = { channels: { telegram: {} } };
    const targetIds = new Set(["channels.telegram.token"]);
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      diagnostics: ["resolved channels.telegram.token"],
      resolvedConfig,
    });

    const result = await resolveCommandConfigWithSecrets({
      commandName: "status",
      config,
      mode: "read_only_status",
      runtime,
      targetIds,
    });

    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
      commandName: "status",
      config,
      mode: "read_only_status",
      targetIds,
    });
    expect(runtime.log).toHaveBeenCalledWith("[secrets] resolved channels.telegram.token");
    expect(mocks.applyPluginAutoEnable).not.toHaveBeenCalled();
    expect(result).toEqual({
      diagnostics: ["resolved channels.telegram.token"],
      effectiveConfig: resolvedConfig,
      resolvedConfig,
    });
  });

  it("returns auto-enabled config when requested", async () => {
    const resolvedConfig = { channels: {} };
    const effectiveConfig = { channels: {}, plugins: { allow: ["telegram"] } };
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      diagnostics: [],
      resolvedConfig,
    });
    mocks.applyPluginAutoEnable.mockReturnValue({
      changes: ["enabled telegram"],
      config: effectiveConfig,
    });

    const result = await resolveCommandConfigWithSecrets({
      autoEnable: true,
      commandName: "message",
      config: resolvedConfig,
      env: { OPENCLAW_AUTO_ENABLE: "1" } as NodeJS.ProcessEnv,
      targetIds: new Set(["channels.telegram.token"]),
    });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: resolvedConfig,
      env: { OPENCLAW_AUTO_ENABLE: "1" },
    });
    expect(result.effectiveConfig).toBe(effectiveConfig);
  });
});
