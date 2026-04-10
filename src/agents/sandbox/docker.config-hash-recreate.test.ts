import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeSandboxConfigHash } from "./config-hash.js";
import { collectDockerFlagValues } from "./test-args.js";
import type { SandboxConfig } from "./types.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

interface SpawnCall {
  command: string;
  args: string[];
}

type MockDockerChild = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: { end: (input?: string | Buffer) => void };
  kill: (signal?: NodeJS.Signals) => void;
};

const spawnState = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  inspectRunning: true,
  labelHash: "",
}));

const registryMocks = vi.hoisted(() => ({
  readRegistry: vi.fn(),
  updateRegistry: vi.fn(),
}));

vi.mock("./registry.js", () => ({
  readRegistry: registryMocks.readRegistry,
  updateRegistry: registryMocks.updateRegistry,
}));

function createMockDockerChild(): MockDockerChild {
  const child = new EventEmitter() as MockDockerChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = { end: () => undefined };
  child.kill = () => undefined;
  return child;
}

function spawnDockerProcess(command: string, args: string[]) {
  spawnState.calls.push({ args, command });
  const child = createMockDockerChild();

  let code = 0;
  let stdout = "";
  let stderr = "";
  if (command !== "docker") {
    code = 1;
    stderr = `unexpected command: ${command}`;
  } else if (args[0] === "inspect" && args[1] === "-f" && args[2] === "{{.State.Running}}") {
    stdout = spawnState.inspectRunning ? "true\n" : "false\n";
  } else if (
    args[0] === "inspect" &&
    args[1] === "-f" &&
    args[2]?.includes('index .Config.Labels "openclaw.configHash"')
  ) {
    stdout = `${spawnState.labelHash}\n`;
  } else if (
    (args[0] === "rm" && args[1] === "-f") ||
    (args[0] === "image" && args[1] === "inspect") ||
    args[0] === "create" ||
    args[0] === "start"
  ) {
    code = 0;
  } else {
    code = 1;
    stderr = `unexpected docker args: ${args.join(" ")}`;
  }

  queueMicrotask(() => {
    if (stdout) {
      child.stdout.emit("data", Buffer.from(stdout));
    }
    if (stderr) {
      child.stderr.emit("data", Buffer.from(stderr));
    }
    child.emit("close", code);
  });
  return child;
}

async function createChildProcessMock() {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnDockerProcess,
  };
}

vi.mock("node:child_process", async () => createChildProcessMock());

let ensureSandboxContainer: typeof import("./docker.js").ensureSandboxContainer;

async function loadFreshDockerModuleForTest() {
  vi.resetModules();
  vi.doMock("./registry.js", () => ({
    readRegistry: registryMocks.readRegistry,
    updateRegistry: registryMocks.updateRegistry,
  }));
  vi.doMock("node:child_process", async () => createChildProcessMock());
  ({ ensureSandboxContainer } = await import("./docker.js"));
}

function createSandboxConfig(
  dns: string[],
  binds?: string[],
  workspaceAccess: "rw" | "ro" | "none" = "rw",
): SandboxConfig {
  return {
    backend: "docker",
    browser: {
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 5000,
      cdpPort: 9222,
      containerPrefix: "oc-browser-",
      enableNoVnc: false,
      enabled: false,
      headless: true,
      image: "openclaw-browser:test",
      network: "openclaw-sandbox-browser",
      noVncPort: 6080,
      vncPort: 5900,
    },
    docker: {
      binds: binds ?? ["/tmp/workspace:/workspace:rw"],
      capDrop: ["ALL"],
      containerPrefix: "oc-test-",
      dangerouslyAllowReservedContainerTargets: true,
      dns,
      env: { LANG: "C.UTF-8" },
      extraHosts: ["host.docker.internal:host-gateway"],
      image: "openclaw-sandbox:test",
      network: "none",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      workdir: "/workspace",
    },
    mode: "all",
    prune: { idleHours: 24, maxAgeDays: 7 },
    scope: "shared",
    ssh: {
      command: "ssh",
      strictHostKeyChecking: true,
      updateHostKeys: true,
      workspaceRoot: "/tmp/openclaw-sandboxes",
    },
    tools: { allow: [], deny: [] },
    workspaceAccess,
    workspaceRoot: "~/.openclaw/sandboxes",
  };
}

describe("ensureSandboxContainer config-hash recreation", () => {
  beforeEach(async () => {
    spawnState.calls.length = 0;
    spawnState.inspectRunning = true;
    spawnState.labelHash = "";
    registryMocks.readRegistry.mockClear();
    registryMocks.updateRegistry.mockClear();
    registryMocks.updateRegistry.mockResolvedValue(undefined);
    await loadFreshDockerModuleForTest();
  });

  it("recreates shared container when array-order change alters hash", async () => {
    const workspaceDir = "/tmp/workspace";
    const oldCfg = createSandboxConfig(["1.1.1.1", "8.8.8.8"]);
    const newCfg = createSandboxConfig(["8.8.8.8", "1.1.1.1"]);

    const oldHash = computeSandboxConfigHash({
      agentWorkspaceDir: workspaceDir,
      docker: oldCfg.docker,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      workspaceAccess: oldCfg.workspaceAccess,
      workspaceDir,
    });
    const newHash = computeSandboxConfigHash({
      agentWorkspaceDir: workspaceDir,
      docker: newCfg.docker,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      workspaceAccess: newCfg.workspaceAccess,
      workspaceDir,
    });
    expect(newHash).not.toBe(oldHash);

    spawnState.labelHash = oldHash;
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          configHash: oldHash,
          containerName: "oc-test-shared",
          createdAtMs: 1,
          image: newCfg.docker.image,
          lastUsedAtMs: 0,
          sessionKey: "shared",
        },
      ],
    });

    const containerName = await ensureSandboxContainer({
      agentWorkspaceDir: workspaceDir,
      cfg: newCfg,
      sessionKey: "agent:main:session-1",
      workspaceDir,
    });

    expect(containerName).toBe("oc-test-shared");
    const dockerCalls = spawnState.calls.filter((call) => call.command === "docker");
    expect(
      dockerCalls.some(
        (call) =>
          call.args[0] === "rm" && call.args[1] === "-f" && call.args[2] === "oc-test-shared",
      ),
    ).toBe(true);
    const createCall = dockerCalls.find((call) => call.args[0] === "create");
    expect(createCall).toBeDefined();
    expect(createCall?.args).toContain(`openclaw.configHash=${newHash}`);
    expect(registryMocks.updateRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        configHash: newHash,
        containerName: "oc-test-shared",
      }),
    );
  });

  it("applies custom binds after workspace mounts so overlapping binds can override", async () => {
    const workspaceDir = "/tmp/workspace";
    const cfg = createSandboxConfig(
      ["1.1.1.1"],
      ["/tmp/workspace-shared/USER.md:/workspace/USER.md:ro"],
    );
    cfg.docker.dangerouslyAllowExternalBindSources = true;
    const expectedHash = computeSandboxConfigHash({
      agentWorkspaceDir: workspaceDir,
      docker: cfg.docker,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
    });

    spawnState.inspectRunning = false;
    spawnState.labelHash = "stale-hash";
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          configHash: "stale-hash",
          containerName: "oc-test-shared",
          createdAtMs: 1,
          image: cfg.docker.image,
          lastUsedAtMs: 0,
          sessionKey: "shared",
        },
      ],
    });

    await ensureSandboxContainer({
      agentWorkspaceDir: workspaceDir,
      cfg,
      sessionKey: "agent:main:session-1",
      workspaceDir,
    });

    const createCall = spawnState.calls.find(
      (call) => call.command === "docker" && call.args[0] === "create",
    );
    expect(createCall).toBeDefined();
    expect(createCall?.args).toContain(`openclaw.configHash=${expectedHash}`);

    const bindArgs = collectDockerFlagValues(createCall?.args ?? [], "-v");
    const workspaceMountIdx = bindArgs.indexOf("/tmp/workspace:/workspace:z");
    const customMountIdx = bindArgs.indexOf("/tmp/workspace-shared/USER.md:/workspace/USER.md:ro");
    expect(workspaceMountIdx).toBeGreaterThanOrEqual(0);
    expect(customMountIdx).toBeGreaterThan(workspaceMountIdx);
  });

  it.each([
    { expectedMainMount: "/tmp/workspace:/workspace:z", workspaceAccess: "rw" as const },
    { expectedMainMount: "/tmp/workspace:/workspace:ro,z", workspaceAccess: "ro" as const },
    { expectedMainMount: "/tmp/workspace:/workspace:ro,z", workspaceAccess: "none" as const },
  ])(
    "uses expected main mount permissions when workspaceAccess=$workspaceAccess",
    async ({ workspaceAccess, expectedMainMount }) => {
      const workspaceDir = "/tmp/workspace";
      const cfg = createSandboxConfig([], undefined, workspaceAccess);

      spawnState.inspectRunning = false;
      spawnState.labelHash = "";
      registryMocks.readRegistry.mockResolvedValue({ entries: [] });
      registryMocks.updateRegistry.mockResolvedValue(undefined);

      await ensureSandboxContainer({
        agentWorkspaceDir: workspaceDir,
        cfg,
        sessionKey: "agent:main:session-1",
        workspaceDir,
      });

      const createCall = spawnState.calls.find(
        (call) => call.command === "docker" && call.args[0] === "create",
      );
      expect(createCall).toBeDefined();

      const bindArgs = collectDockerFlagValues(createCall?.args ?? [], "-v");
      expect(bindArgs).toContain(expectedMainMount);
    },
  );

  it("stamps the mount format version label on created containers", async () => {
    const workspaceDir = "/tmp/workspace";
    const cfg = createSandboxConfig([]);

    spawnState.inspectRunning = false;
    spawnState.labelHash = "";
    registryMocks.readRegistry.mockResolvedValue({ entries: [] });

    await ensureSandboxContainer({
      agentWorkspaceDir: workspaceDir,
      cfg,
      sessionKey: "agent:main:session-1",
      workspaceDir,
    });

    const createCall = spawnState.calls.find(
      (call) => call.command === "docker" && call.args[0] === "create",
    );
    expect(createCall).toBeDefined();
    expect(createCall?.args).toContain(
      `openclaw.mountFormatVersion=${SANDBOX_MOUNT_FORMAT_VERSION}`,
    );
  });
});
