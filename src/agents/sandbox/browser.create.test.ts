import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collectDockerFlagValues, findDockerArgsCall } from "./test-args.js";
import type { SandboxConfig } from "./types.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

let BROWSER_BRIDGES: Map<string, unknown>;
let ensureSandboxBrowser: typeof import("./browser.js").ensureSandboxBrowser;
let resetNoVncObserverTokensForTests: typeof import("./novnc-auth.js").resetNoVncObserverTokensForTests;

const dockerMocks = vi.hoisted(() => ({
  dockerContainerState: vi.fn(),
  execDocker: vi.fn(),
  readDockerContainerEnvVar: vi.fn(),
  readDockerContainerLabel: vi.fn(),
  readDockerPort: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  readBrowserRegistry: vi.fn(),
  updateBrowserRegistry: vi.fn(),
}));

const bridgeMocks = vi.hoisted(() => ({
  startBrowserBridgeServer: vi.fn(),
  stopBrowserBridgeServer: vi.fn(),
}));

vi.mock("./docker.js", async () => {
  const actual = await vi.importActual<typeof import("./docker.js")>("./docker.js");
  return {
    ...actual,
    dockerContainerState: dockerMocks.dockerContainerState,
    execDocker: dockerMocks.execDocker,
    readDockerContainerEnvVar: dockerMocks.readDockerContainerEnvVar,
    readDockerContainerLabel: dockerMocks.readDockerContainerLabel,
    readDockerPort: dockerMocks.readDockerPort,
  };
});

vi.mock("./registry.js", () => ({
  readBrowserRegistry: registryMocks.readBrowserRegistry,
  updateBrowserRegistry: registryMocks.updateBrowserRegistry,
}));

vi.mock("../../plugin-sdk/browser-bridge.js", () => ({
  startBrowserBridgeServer: bridgeMocks.startBrowserBridgeServer,
  stopBrowserBridgeServer: bridgeMocks.stopBrowserBridgeServer,
}));

async function loadFreshBrowserModulesForTest() {
  vi.resetModules();
  ({ BROWSER_BRIDGES } = await import("./browser-bridges.js"));
  ({ ensureSandboxBrowser } = await import("./browser.js"));
  ({ resetNoVncObserverTokensForTests } = await import("./novnc-auth.js"));
}

function buildConfig(enableNoVnc: boolean): SandboxConfig {
  return {
    backend: "docker",
    browser: {
      allowHostControl: false,
      autoStart: true,
      autoStartTimeoutMs: 12_000,
      cdpPort: 9222,
      containerPrefix: "openclaw-sbx-browser-",
      enableNoVnc,
      enabled: true,
      headless: false,
      image: "openclaw-sandbox-browser:bookworm-slim",
      network: "openclaw-sandbox-browser",
      noVncPort: 6080,
      vncPort: 5900,
    },
    docker: {
      capDrop: ["ALL"],
      containerPrefix: "openclaw-sbx-",
      env: { LANG: "C.UTF-8" },
      image: "openclaw-sandbox:bookworm-slim",
      network: "none",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      workdir: "/workspace",
    },
    mode: "all",
    prune: {
      idleHours: 24,
      maxAgeDays: 7,
    },
    scope: "session",
    ssh: {
      command: "ssh",
      strictHostKeyChecking: true,
      updateHostKeys: true,
      workspaceRoot: "/tmp/openclaw-sandboxes",
    },
    tools: {
      allow: ["browser"],
      deny: [],
    },
    workspaceAccess: "none",
    workspaceRoot: "/tmp/openclaw-sandboxes",
  };
}

describe("ensureSandboxBrowser create args", () => {
  beforeAll(async () => {
    await loadFreshBrowserModulesForTest();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    BROWSER_BRIDGES.clear();
    resetNoVncObserverTokensForTests();
    dockerMocks.dockerContainerState.mockClear();
    dockerMocks.execDocker.mockClear();
    dockerMocks.readDockerContainerEnvVar.mockClear();
    dockerMocks.readDockerContainerLabel.mockClear();
    dockerMocks.readDockerPort.mockClear();
    registryMocks.readBrowserRegistry.mockClear();
    registryMocks.updateBrowserRegistry.mockClear();
    bridgeMocks.startBrowserBridgeServer.mockClear();
    bridgeMocks.stopBrowserBridgeServer.mockClear();

    dockerMocks.dockerContainerState.mockResolvedValue({ exists: false, running: false });
    dockerMocks.execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { code: 0, stderr: "", stdout: "[]" };
      }
      return { code: 0, stderr: "", stdout: "" };
    });
    dockerMocks.readDockerContainerLabel.mockResolvedValue(null);
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue(null);
    dockerMocks.readDockerPort.mockImplementation(async (_containerName: string, port: number) => {
      if (port === 9222) {
        return 49_100;
      }
      if (port === 6080) {
        return 49_101;
      }
      return null;
    });
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });
    registryMocks.updateBrowserRegistry.mockResolvedValue(undefined);
    bridgeMocks.startBrowserBridgeServer.mockResolvedValue({
      baseUrl: "http://127.0.0.1:19000",
      port: 19_000,
      server: {} as never,
      state: {
        port: 19_000,
        profiles: new Map(),
        resolved: { profiles: {} },
        server: null,
      },
    });
    bridgeMocks.stopBrowserBridgeServer.mockResolvedValue(undefined);
  });

  it("publishes noVNC on loopback and injects noVNC password env", async () => {
    const result = await ensureSandboxBrowser({
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(true),
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");

    expect(createArgs).toBeDefined();
    expect(createArgs).toContain("127.0.0.1::6080");
    const envEntries = collectDockerFlagValues(createArgs ?? [], "-e");
    expect(envEntries).toContain("OPENCLAW_BROWSER_NO_SANDBOX=1");
    const passwordEntry = envEntries.find((entry) =>
      entry.startsWith("OPENCLAW_BROWSER_NOVNC_PASSWORD="),
    );
    expect(passwordEntry).toMatch(/^OPENCLAW_BROWSER_NOVNC_PASSWORD=[A-Za-z0-9]{8}$/);
    expect(result?.noVncUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sandbox\/novnc\?token=/);
    expect(result?.noVncUrl).not.toContain("password=");
  });

  it("does not inject noVNC password env when noVNC is disabled", async () => {
    const result = await ensureSandboxBrowser({
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");
    const envEntries = collectDockerFlagValues(createArgs ?? [], "-e");
    expect(envEntries.some((entry) => entry.startsWith("OPENCLAW_BROWSER_NOVNC_PASSWORD="))).toBe(
      false,
    );
    expect(result?.noVncUrl).toBeUndefined();
  });

  it("mounts the main workspace read-only when workspaceAccess is none", async () => {
    const cfg = buildConfig(false);
    cfg.workspaceAccess = "none";

    await ensureSandboxBrowser({
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");

    expect(createArgs).toBeDefined();
    expect(createArgs).toContain("/tmp/workspace:/workspace:ro,z");
  });

  it("keeps the main workspace writable when workspaceAccess is rw", async () => {
    const cfg = buildConfig(false);
    cfg.workspaceAccess = "rw";

    await ensureSandboxBrowser({
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");

    expect(createArgs).toBeDefined();
    expect(createArgs).toContain("/tmp/workspace:/workspace:z");
    expect(createArgs).not.toContain("/tmp/workspace:/workspace:ro,z");
  });

  it("stamps the mount format version label on browser containers", async () => {
    await ensureSandboxBrowser({
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");
    const labels = collectDockerFlagValues(createArgs ?? [], "--label");
    expect(labels).toContain(`openclaw.mountFormatVersion=${SANDBOX_MOUNT_FORMAT_VERSION}`);
  });

  it("force-removes the browser container when CDP never becomes reachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    bridgeMocks.startBrowserBridgeServer.mockImplementationOnce(async (params) => {
      await params.onEnsureAttachTarget?.({});
      return {
        baseUrl: "http://127.0.0.1:19000",
        port: 19_000,
        server: {} as never,
        state: {
          port: 19_000,
          profiles: new Map(),
          resolved: { profiles: {} },
          server: null,
        },
      };
    });

    const cfg = buildConfig(false);
    cfg.browser.autoStartTimeoutMs = 1;

    await expect(
      ensureSandboxBrowser({
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
        scopeKey: "session:test",
        workspaceDir: "/tmp/workspace",
      }),
    ).rejects.toThrow("hung container has been forcefully removed");

    expect(dockerMocks.execDocker).toHaveBeenCalledWith(
      ["rm", "-f", expect.stringMatching(/^openclaw-sbx-browser-session-test-/)],
      { allowFailure: true },
    );
  });
});
