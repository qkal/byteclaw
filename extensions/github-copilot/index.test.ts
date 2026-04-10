import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";

const resolveCopilotApiTokenMock = vi.hoisted(() => vi.fn());

vi.mock("./register.runtime.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
  fetchCopilotUsage: vi.fn(),
  githubCopilotLoginCommand: vi.fn(),
  resolveCopilotApiToken: resolveCopilotApiTokenMock,
}));

import plugin from "./index.js";

function _registerProvider() {
  return registerProviderWithPluginConfig({});
}

function registerProviderWithPluginConfig(pluginConfig: Record<string, unknown>) {
  const registerProviderMock = vi.fn();

  plugin.register(
    createTestPluginApi({
      config: {},
      id: "github-copilot",
      name: "GitHub Copilot",
      pluginConfig,
      registerProvider: registerProviderMock,
      runtime: {} as never,
      source: "test",
    }),
  );

  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return registerProviderMock.mock.calls[0]?.[0];
}

describe("github-copilot plugin", () => {
  it("skips catalog discovery when plugin discovery is disabled", async () => {
    const provider = registerProviderWithPluginConfig({ discovery: { enabled: false } });

    const result = await provider.catalog.run({
      agentDir: "/tmp/agent",
      config: {},
      env: { GH_TOKEN: "gh_test_token" },
      resolveProviderApiKey: () => ({ apiKey: "gh_test_token" }),
    } as never);

    expect(result).toBeNull();
    expect(resolveCopilotApiTokenMock).not.toHaveBeenCalled();
  });
});
