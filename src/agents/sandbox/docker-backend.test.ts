import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const dockerMocks = vi.hoisted(() => ({
  dockerContainerState: vi.fn(),
  ensureSandboxContainer: vi.fn(),
  execDocker: vi.fn(),
  execDockerRaw: vi.fn(),
}));

vi.mock("./docker.js", async () => {
  const actual = await vi.importActual<typeof import("./docker.js")>("./docker.js");
  return {
    ...actual,
    dockerContainerState: dockerMocks.dockerContainerState,
    ensureSandboxContainer: dockerMocks.ensureSandboxContainer,
    execDocker: dockerMocks.execDocker,
    execDockerRaw: dockerMocks.execDockerRaw,
  };
});

const { dockerSandboxBackendManager } = await import("./docker-backend.js");

function createConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          browser: {
            enabled: true,
            image: "openclaw-sandbox-browser:bookworm-slim",
          },
          docker: {
            image: "openclaw-sandbox:bookworm-slim",
          },
          mode: "all",
          scope: "session",
          workspaceAccess: "none",
        },
      },
      list: [],
    },
  };
}

describe("docker sandbox backend manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dockerMocks.dockerContainerState.mockResolvedValue({
      exists: true,
      running: true,
    });
    dockerMocks.execDocker.mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "unused-image",
    });
  });

  it("matches ordinary sandbox runtimes against sandbox.docker.image", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce({
      code: 0,
      stderr: "",
      stdout: "openclaw-sandbox:bookworm-slim\n",
    });

    const result = await dockerSandboxBackendManager.describeRuntime({
      agentId: "coder",
      config: createConfig(),
      entry: {
        backendId: "docker",
        configLabelKind: "Image",
        containerName: "sandbox-1",
        createdAtMs: 1,
        image: "stale-entry-image",
        lastUsedAtMs: 1,
        runtimeLabel: "sandbox-1",
        sessionKey: "agent:coder:main",
      },
    });

    expect(result).toEqual({
      actualConfigLabel: "openclaw-sandbox:bookworm-slim",
      configLabelMatch: true,
      running: true,
    });
  });

  it("matches browser runtimes against sandbox.browser.image", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce({
      code: 0,
      stderr: "",
      stdout: "openclaw-sandbox-browser:bookworm-slim\n",
    });

    const result = await dockerSandboxBackendManager.describeRuntime({
      agentId: "coder",
      config: createConfig(),
      entry: {
        backendId: "docker",
        configLabelKind: "BrowserImage",
        containerName: "browser-1",
        createdAtMs: 1,
        image: "stale-entry-image",
        lastUsedAtMs: 1,
        runtimeLabel: "browser-1",
        sessionKey: "agent:coder:main",
      },
    });

    expect(result).toEqual({
      actualConfigLabel: "openclaw-sandbox-browser:bookworm-slim",
      configLabelMatch: true,
      running: true,
    });
  });

  it("defaults docker-backed runtime matching to sandbox.docker.image when label kind is missing", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce({
      code: 0,
      stderr: "",
      stdout: "openclaw-sandbox:bookworm-slim\n",
    });

    const result = await dockerSandboxBackendManager.describeRuntime({
      agentId: "coder",
      config: createConfig(),
      entry: {
        backendId: "docker",
        containerName: "sandbox-legacy",
        createdAtMs: 1,
        image: "stale-entry-image",
        lastUsedAtMs: 1,
        runtimeLabel: "sandbox-legacy",
        sessionKey: "agent:coder:main",
      },
    });

    expect(result).toEqual({
      actualConfigLabel: "openclaw-sandbox:bookworm-slim",
      configLabelMatch: true,
      running: true,
    });
  });
});
