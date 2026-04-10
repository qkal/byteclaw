import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadValidConfigOrThrow, updateConfig } from "./shared.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
  replaceConfigFile: (...args: unknown[]) => mocks.replaceConfigFile(...args),
}));

describe("models/shared", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockClear();
    mocks.replaceConfigFile.mockClear();
  });

  it("returns config when snapshot is valid", async () => {
    const cfg = { providers: {} } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue({
      config: cfg,
      runtimeConfig: cfg,
      valid: true,
    });

    await expect(loadValidConfigOrThrow()).resolves.toBe(cfg);
  });

  it("throws formatted issues when snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      issues: [{ message: "Required", path: "providers.openai.apiKey" }],
      path: "/tmp/openclaw.json",
      valid: false,
    });

    await expect(loadValidConfigOrThrow()).rejects.toThrowError(
      "Invalid config at /tmp/openclaw.json\n- providers.openai.apiKey: Required",
    );
  });

  it("updateConfig writes mutated config", async () => {
    const cfg = { update: { channel: "stable" } } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue({
      config: cfg,
      hash: "config-1",
      sourceConfig: cfg,
      valid: true,
    });
    mocks.replaceConfigFile.mockResolvedValue(undefined);

    await updateConfig((current) => ({
      ...current,
      update: { channel: "beta" },
    }));

    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      baseHash: "config-1",
      nextConfig: expect.objectContaining({
        update: { channel: "beta" },
      }),
    });
  });
});
