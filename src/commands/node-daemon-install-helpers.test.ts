import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildNodeServiceEnvironment: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
  resolveNodeProgramArguments: vi.fn(),
  resolvePreferredNodePath: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
  resolvePreferredNodePath: mocks.resolvePreferredNodePath,
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveNodeProgramArguments: mocks.resolveNodeProgramArguments,
}));

vi.mock("../daemon/service-env.js", () => ({
  buildNodeServiceEnvironment: mocks.buildNodeServiceEnvironment,
}));

import { buildNodeInstallPlan } from "./node-daemon-install-helpers.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("buildNodeInstallPlan", () => {
  it("passes the selected node bin directory into the node service environment", async () => {
    mocks.resolveNodeProgramArguments.mockResolvedValue({
      programArguments: ["node", "node-host"],
      workingDirectory: "/Users/me",
    });
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: "/opt/node/bin/node",
      supported: true,
      version: "22.0.0",
    });
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.buildNodeServiceEnvironment.mockReturnValue({
      OPENCLAW_SERVICE_VERSION: "2026.3.22",
    });

    const plan = await buildNodeInstallPlan({
      env: {},
      host: "127.0.0.1",
      nodePath: "/custom/node/bin/node",
      port: 18_789,
      runtime: "node",
    });

    expect(plan.environment).toEqual({
      OPENCLAW_SERVICE_VERSION: "2026.3.22",
    });
    expect(mocks.resolvePreferredNodePath).not.toHaveBeenCalled();
    expect(mocks.buildNodeServiceEnvironment).toHaveBeenCalledWith({
      env: {},
      extraPathDirs: ["/custom/node/bin"],
    });
  });

  it("does not prepend '.' when nodePath is a bare executable name", async () => {
    mocks.resolveNodeProgramArguments.mockResolvedValue({
      programArguments: ["node", "node-host"],
      workingDirectory: "/Users/me",
    });
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: "/usr/bin/node",
      supported: true,
      version: "22.0.0",
    });
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.buildNodeServiceEnvironment.mockReturnValue({
      OPENCLAW_SERVICE_VERSION: "2026.3.22",
    });

    await buildNodeInstallPlan({
      env: {},
      host: "127.0.0.1",
      nodePath: "node",
      port: 18_789,
      runtime: "node",
    });

    expect(mocks.buildNodeServiceEnvironment).toHaveBeenCalledWith({
      env: {},
      extraPathDirs: undefined,
    });
  });
});
