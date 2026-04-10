import { describe, expect, it } from "vitest";
import { OPENCLAW_CLI_ENV_VALUE } from "../infra/openclaw-exec-env.js";
import { buildSandboxCreateArgs } from "./sandbox/docker.js";
import type { SandboxDockerConfig } from "./sandbox/types.js";

describe("buildSandboxCreateArgs", () => {
  function createSandboxConfig(
    overrides: Partial<SandboxDockerConfig> = {},
    binds?: string[],
  ): SandboxDockerConfig {
    return {
      capDrop: [],
      containerPrefix: "openclaw-sbx-",
      image: "openclaw-sandbox:bookworm-slim",
      network: "none",
      readOnlyRoot: false,
      tmpfs: [],
      workdir: "/workspace",
      ...(binds ? { binds } : {}),
      ...overrides,
    };
  }

  function expectBuildToThrow(
    name: string,
    cfg: SandboxDockerConfig,
    expectedMessage: RegExp,
  ): void {
    expect(
      () =>
        buildSandboxCreateArgs({
          cfg,
          createdAtMs: 1_700_000_000_000,
          name,
          scopeKey: "main",
        }),
      name,
    ).toThrow(expectedMessage);
  }

  it("includes hardening and resource flags", () => {
    const cfg: SandboxDockerConfig = {
      apparmorProfile: "openclaw-sandbox",
      capDrop: ["ALL"],
      containerPrefix: "openclaw-sbx-",
      cpus: 1.5,
      dns: ["1.1.1.1"],
      env: { LANG: "C.UTF-8" },
      extraHosts: ["internal.service:10.0.0.5"],
      image: "openclaw-sandbox:bookworm-slim",
      memory: "512m",
      memorySwap: 1024,
      network: "none",
      pidsLimit: 256,
      readOnlyRoot: true,
      seccompProfile: "/tmp/seccomp.json",
      tmpfs: ["/tmp"],
      ulimits: {
        core: "0",
        nofile: { hard: 2048, soft: 1024 },
        nproc: 128,
      },
      user: "1000:1000",
      workdir: "/workspace",
    };

    const args = buildSandboxCreateArgs({
      cfg,
      createdAtMs: 1_700_000_000_000,
      labels: { "openclaw.sandboxBrowser": "1" },
      name: "openclaw-sbx-test",
      scopeKey: "main",
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "create",
        "--name",
        "openclaw-sbx-test",
        "--label",
        "openclaw.sandbox=1",
        "--label",
        "openclaw.sessionKey=main",
        "--label",
        "openclaw.createdAtMs=1700000000000",
        "--label",
        "openclaw.sandboxBrowser=1",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--network",
        "none",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--security-opt",
        "seccomp=/tmp/seccomp.json",
        "--security-opt",
        "apparmor=openclaw-sandbox",
        "--dns",
        "1.1.1.1",
        "--add-host",
        "internal.service:10.0.0.5",
        "--pids-limit",
        "256",
        "--memory",
        "512m",
        "--memory-swap",
        "1024",
        "--cpus",
        "1.5",
      ]),
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--env",
        "LANG=C.UTF-8",
        "--env",
        `OPENCLAW_CLI=${OPENCLAW_CLI_ENV_VALUE}`,
      ]),
    );

    const ulimitValues: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--ulimit") {
        const value = args[i + 1];
        if (value) {
          ulimitValues.push(value);
        }
      }
    }
    expect(ulimitValues).toEqual(
      expect.arrayContaining(["nofile=1024:2048", "nproc=128", "core=0"]),
    );
  });

  it("preserves the OpenClaw exec marker when strict env sanitization is enabled", () => {
    const cfg = createSandboxConfig({
      env: {
        NODE_ENV: "test",
      },
    });

    const args = buildSandboxCreateArgs({
      cfg,
      createdAtMs: 1_700_000_000_000,
      envSanitizationOptions: {
        strictMode: true,
      },
      name: "openclaw-sbx-marker",
      scopeKey: "main",
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--env",
        "NODE_ENV=test",
        "--env",
        `OPENCLAW_CLI=${OPENCLAW_CLI_ENV_VALUE}`,
      ]),
    );
  });

  it("emits -v flags for safe custom binds", () => {
    const cfg: SandboxDockerConfig = {
      binds: ["/home/user/source:/source:rw", "/var/data/myapp:/data:ro"],
      capDrop: [],
      containerPrefix: "openclaw-sbx-",
      image: "openclaw-sandbox:bookworm-slim",
      network: "none",
      readOnlyRoot: false,
      tmpfs: [],
      workdir: "/workspace",
    };

    const args = buildSandboxCreateArgs({
      cfg,
      createdAtMs: 1_700_000_000_000,
      name: "openclaw-sbx-binds",
      scopeKey: "main",
    });

    expect(args).toContain("-v");
    const vFlags: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-v") {
        const value = args[i + 1];
        if (value) {
          vFlags.push(value);
        }
      }
    }
    expect(vFlags).toContain("/home/user/source:/source:rw");
    expect(vFlags).toContain("/var/data/myapp:/data:ro");
  });

  it.each([
    {
      cfg: createSandboxConfig({}, ["/var/run/docker.sock:/var/run/docker.sock"]),
      containerName: "openclaw-sbx-dangerous",
      expected: /blocked path/,
      name: "dangerous Docker socket bind mounts",
    },
    {
      cfg: createSandboxConfig({}, ["/run:/run"]),
      containerName: "openclaw-sbx-dangerous-parent",
      expected: /blocked path/,
      name: "dangerous parent bind mounts",
    },
    {
      cfg: createSandboxConfig({ network: "host" }),
      containerName: "openclaw-sbx-host",
      expected: /network mode "host" is blocked/,
      name: "network host mode",
    },
    {
      cfg: createSandboxConfig({ network: "container:peer" }),
      containerName: "openclaw-sbx-container-network",
      expected: /network mode "container:peer" is blocked by default/,
      name: "network container namespace join",
    },
    {
      cfg: createSandboxConfig({ seccompProfile: "unconfined" }),
      containerName: "openclaw-sbx-seccomp",
      expected: /seccomp profile "unconfined" is blocked/,
      name: "seccomp unconfined",
    },
    {
      cfg: createSandboxConfig({ apparmorProfile: "unconfined" }),
      containerName: "openclaw-sbx-apparmor",
      expected: /apparmor profile "unconfined" is blocked/,
      name: "apparmor unconfined",
    },
  ])("throws on $name", ({ containerName, cfg, expected }) => {
    expectBuildToThrow(containerName, cfg, expected);
  });

  it("omits -v flags when binds is empty or undefined", () => {
    const cfg: SandboxDockerConfig = {
      binds: [],
      capDrop: [],
      containerPrefix: "openclaw-sbx-",
      image: "openclaw-sandbox:bookworm-slim",
      network: "none",
      readOnlyRoot: false,
      tmpfs: [],
      workdir: "/workspace",
    };

    const args = buildSandboxCreateArgs({
      cfg,
      createdAtMs: 1_700_000_000_000,
      name: "openclaw-sbx-no-binds",
      scopeKey: "main",
    });

    // Count -v flags that are NOT workspace mounts (workspace mounts are internal)
    const customVFlags: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-v") {
        const value = args[i + 1];
        if (value && !value.includes("/workspace")) {
          customVFlags.push(value);
        }
      }
    }
    expect(customVFlags).toHaveLength(0);
  });

  it("blocks bind sources outside runtime allowlist roots", () => {
    const cfg = createSandboxConfig({}, ["/opt/external:/data:rw"]);
    expect(() =>
      buildSandboxCreateArgs({
        bindSourceRoots: ["/tmp/workspace", "/tmp/agent"],
        cfg,
        createdAtMs: 1_700_000_000_000,
        name: "openclaw-sbx-outside-roots",
        scopeKey: "main",
      }),
    ).toThrow(/outside allowed roots/);
  });

  it("allows bind sources outside runtime allowlist with explicit override", () => {
    const cfg = createSandboxConfig({}, ["/opt/external:/data:rw"]);
    const args = buildSandboxCreateArgs({
      allowSourcesOutsideAllowedRoots: true,
      bindSourceRoots: ["/tmp/workspace", "/tmp/agent"],
      cfg,
      createdAtMs: 1_700_000_000_000,
      name: "openclaw-sbx-outside-roots-override",
      scopeKey: "main",
    });
    expect(args).toEqual(expect.arrayContaining(["-v", "/opt/external:/data:rw"]));
  });

  it("blocks reserved /workspace target bind mounts by default", () => {
    const cfg = createSandboxConfig({}, ["/tmp/override:/workspace:rw"]);
    expectBuildToThrow("openclaw-sbx-reserved-target", cfg, /reserved container path/);
  });

  it("allows reserved /workspace target bind mounts with explicit dangerous override", () => {
    const cfg = createSandboxConfig({}, ["/tmp/override:/workspace:rw"]);
    const args = buildSandboxCreateArgs({
      allowReservedContainerTargets: true,
      cfg,
      createdAtMs: 1_700_000_000_000,
      name: "openclaw-sbx-reserved-target-override",
      scopeKey: "main",
    });
    expect(args).toEqual(expect.arrayContaining(["-v", "/tmp/override:/workspace:rw"]));
  });

  it("allows container namespace join with explicit dangerous override", () => {
    const cfg = createSandboxConfig({
      dangerouslyAllowContainerNamespaceJoin: true,
      network: "container:peer",
    });
    const args = buildSandboxCreateArgs({
      cfg,
      createdAtMs: 1_700_000_000_000,
      name: "openclaw-sbx-container-network-override",
      scopeKey: "main",
    });
    expect(args).toEqual(expect.arrayContaining(["--network", "container:peer"]));
  });
});
