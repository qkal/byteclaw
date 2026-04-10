import { describe, expect, it, vi } from "vitest";
import { renderRootHelpText } from "./root-help.js";

const getPluginCliCommandDescriptorsMock = vi.fn(
  async (_config?: unknown, _env?: unknown, _loaderOptions?: unknown) => [
    {
      description: "Matrix channel utilities",
      hasSubcommands: true,
      name: "matrix",
    },
  ],
);

vi.mock("./core-command-descriptors.js", () => ({
  getCoreCliCommandDescriptors: () => [
    {
      description: "Show status",
      hasSubcommands: false,
      name: "status",
    },
  ],
  getCoreCliCommandsWithSubcommands: () => [],
}));

vi.mock("./subcli-descriptors.js", () => ({
  getSubCliCommandsWithSubcommands: () => ["config"],
  getSubCliEntries: () => [
    {
      description: "Manage config",
      hasSubcommands: true,
      name: "config",
    },
  ],
}));

vi.mock("../../plugins/cli.js", () => ({
  getPluginCliCommandDescriptors: (...args: [unknown?, unknown?, unknown?]) =>
    getPluginCliCommandDescriptorsMock(...args),
}));

describe("root help", () => {
  it("passes isolated config and env through to plugin CLI descriptor loading", async () => {
    const config = {
      agents: {
        defaults: {
          workspace: "/tmp/openclaw-root-help-workspace",
        },
      },
    };
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-root-help-state" } as NodeJS.ProcessEnv;

    await renderRootHelpText({ config, env, pluginSdkResolution: "src" });

    expect(getPluginCliCommandDescriptorsMock).toHaveBeenCalledWith(config, env, {
      pluginSdkResolution: "src",
    });
  });

  it("includes plugin CLI descriptors alongside core and sub-CLI commands", async () => {
    const text = await renderRootHelpText();

    expect(text).toContain("status");
    expect(text).toContain("config");
    expect(text).toContain("matrix");
    expect(text).toContain("Matrix channel utilities");
  });
});
