import { describe, expect, it } from "vitest";
import { computeSandboxBrowserConfigHash, computeSandboxConfigHash } from "./config-hash.js";
import type { SandboxDockerConfig } from "./types.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

function createDockerConfig(overrides?: Partial<SandboxDockerConfig>): SandboxDockerConfig {
  return {
    binds: ["/tmp/workspace:/workspace:rw", "/tmp/cache:/cache:ro"],
    capDrop: ["ALL"],
    containerPrefix: "openclaw-sbx-",
    dns: ["1.1.1.1", "8.8.8.8"],
    env: { LANG: "C.UTF-8" },
    extraHosts: ["host.docker.internal:host-gateway"],
    image: "openclaw-sandbox:test",
    network: "none",
    readOnlyRoot: true,
    tmpfs: ["/tmp", "/var/tmp", "/run"],
    workdir: "/workspace",
    ...overrides,
  };
}

type DockerArrayField = "tmpfs" | "capDrop" | "dns" | "extraHosts" | "binds";

const ORDER_SENSITIVE_ARRAY_CASES: readonly {
  field: DockerArrayField;
  before: string[];
  after: string[];
}[] = [
  {
    after: ["/run", "/var/tmp", "/tmp"],
    before: ["/tmp", "/var/tmp", "/run"],
    field: "tmpfs",
  },
  {
    after: ["CHOWN", "ALL"],
    before: ["ALL", "CHOWN"],
    field: "capDrop",
  },
  {
    after: ["8.8.8.8", "1.1.1.1"],
    before: ["1.1.1.1", "8.8.8.8"],
    field: "dns",
  },
  {
    after: ["db.local:10.0.0.5", "host.docker.internal:host-gateway"],
    before: ["host.docker.internal:host-gateway", "db.local:10.0.0.5"],
    field: "extraHosts",
  },
  {
    after: ["/tmp/cache:/cache:ro", "/tmp/workspace:/workspace:rw"],
    before: ["/tmp/workspace:/workspace:rw", "/tmp/cache:/cache:ro"],
    field: "binds",
  },
];

describe("computeSandboxConfigHash", () => {
  it("ignores object key order", () => {
    const shared = {
      agentWorkspaceDir: "/tmp/workspace",
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
    };
    const left = computeSandboxConfigHash({
      ...shared,
      docker: createDockerConfig({
        env: {
          A: "1",
          B: "2",
          LANG: "C.UTF-8",
        },
      }),
    });
    const right = computeSandboxConfigHash({
      ...shared,
      docker: createDockerConfig({
        env: {
          A: "1",
          B: "2",
          LANG: "C.UTF-8",
        },
      }),
    });
    expect(left).toBe(right);
  });

  it.each(ORDER_SENSITIVE_ARRAY_CASES)("treats $field order as significant", (testCase) => {
    const shared = {
      agentWorkspaceDir: "/tmp/workspace",
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
    };
    const left = computeSandboxConfigHash({
      ...shared,
      docker: createDockerConfig({
        [testCase.field]: testCase.before,
      } as Partial<SandboxDockerConfig>),
    });
    const right = computeSandboxConfigHash({
      ...shared,
      docker: createDockerConfig({
        [testCase.field]: testCase.after,
      } as Partial<SandboxDockerConfig>),
    });
    expect(left).not.toBe(right);
  });
});

describe("computeSandboxBrowserConfigHash", () => {
  it("treats docker bind order as significant", () => {
    const shared = {
      agentWorkspaceDir: "/tmp/workspace",
      browser: {
        autoStartTimeoutMs: 12_000,
        cdpPort: 9222,
        cdpSourceRange: undefined,
        enableNoVnc: true,
        headless: false,
        noVncPort: 6080,
        vncPort: 5900,
      },
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      securityEpoch: "epoch-v1",
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
    };
    const left = computeSandboxBrowserConfigHash({
      ...shared,
      docker: createDockerConfig({
        binds: ["/tmp/workspace:/workspace:rw", "/tmp/cache:/cache:ro"],
      }),
    });
    const right = computeSandboxBrowserConfigHash({
      ...shared,
      docker: createDockerConfig({
        binds: ["/tmp/cache:/cache:ro", "/tmp/workspace:/workspace:rw"],
      }),
    });
    expect(left).not.toBe(right);
  });

  it("changes when security epoch changes", () => {
    const shared = {
      agentWorkspaceDir: "/tmp/workspace",
      browser: {
        autoStartTimeoutMs: 12_000,
        cdpPort: 9222,
        cdpSourceRange: undefined,
        enableNoVnc: true,
        headless: false,
        noVncPort: 6080,
        vncPort: 5900,
      },
      docker: createDockerConfig(),
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
    };
    const left = computeSandboxBrowserConfigHash({
      ...shared,
      securityEpoch: "epoch-v1",
    });
    const right = computeSandboxBrowserConfigHash({
      ...shared,
      securityEpoch: "epoch-v2",
    });
    expect(left).not.toBe(right);
  });

  it("changes when cdp source range changes", () => {
    const shared = {
      agentWorkspaceDir: "/tmp/workspace",
      browser: {
        autoStartTimeoutMs: 12_000,
        cdpPort: 9222,
        enableNoVnc: true,
        headless: false,
        noVncPort: 6080,
        vncPort: 5900,
      },
      docker: createDockerConfig(),
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      securityEpoch: "epoch-v1",
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
    };
    const left = computeSandboxBrowserConfigHash({
      ...shared,
      browser: { ...shared.browser, cdpSourceRange: "172.21.0.1/32" },
    });
    const right = computeSandboxBrowserConfigHash({
      ...shared,
      browser: { ...shared.browser, cdpSourceRange: "172.22.0.1/32" },
    });
    expect(left).not.toBe(right);
  });

  it("changes when mount format version changes", () => {
    const shared = {
      agentWorkspaceDir: "/tmp/workspace",
      browser: {
        autoStartTimeoutMs: 12_000,
        cdpPort: 9222,
        cdpSourceRange: undefined,
        enableNoVnc: true,
        headless: false,
        noVncPort: 6080,
        vncPort: 5900,
      },
      docker: createDockerConfig(),
      securityEpoch: "epoch-v1",
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
    };
    const left = computeSandboxBrowserConfigHash({
      ...shared,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    });
    const right = computeSandboxBrowserConfigHash({
      ...shared,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION - 1,
    });
    expect(left).not.toBe(right);
  });
});
