import { describe, expect, it } from "vitest";
import { buildEmbeddedSandboxInfo } from "./pi-embedded-runner.js";
import type { SandboxContext } from "./sandbox.js";

function createSandboxContext(overrides?: Partial<SandboxContext>): SandboxContext {
  const base = {
    agentWorkspaceDir: "/tmp/openclaw-workspace",
    backendId: "docker",
    browser: {
      bridgeUrl: "http://localhost:9222",
      containerName: "openclaw-sbx-browser-test",
      noVncUrl: "http://localhost:6080",
    },
    browserAllowHostControl: true,
    containerName: "openclaw-sbx-test",
    containerWorkdir: "/workspace",
    docker: {
      capDrop: ["ALL"],
      containerPrefix: "openclaw-sbx-",
      env: { LANG: "C.UTF-8" },
      image: "openclaw-sandbox:bookworm-slim",
      network: "none",
      readOnlyRoot: true,
      tmpfs: ["/tmp"],
      user: "1000:1000",
      workdir: "/workspace",
    },
    enabled: true,
    runtimeId: "openclaw-sbx-test",
    runtimeLabel: "openclaw-sbx-test",
    sessionKey: "session:test",
    tools: {
      allow: ["exec"],
      deny: ["browser"],
    },
    workspaceAccess: "none",
    workspaceDir: "/tmp/openclaw-sandbox",
  } satisfies SandboxContext;
  return { ...base, ...overrides };
}

describe("buildEmbeddedSandboxInfo", () => {
  it("returns undefined when sandbox is missing", () => {
    expect(buildEmbeddedSandboxInfo()).toBeUndefined();
  });

  it("maps sandbox context into prompt info", () => {
    const sandbox = createSandboxContext();

    expect(buildEmbeddedSandboxInfo(sandbox)).toEqual({
      agentWorkspaceMount: undefined,
      browserBridgeUrl: "http://localhost:9222",
      browserNoVncUrl: "http://localhost:6080",
      containerWorkspaceDir: "/workspace",
      enabled: true,
      hostBrowserAllowed: true,
      workspaceAccess: "none",
      workspaceDir: "/tmp/openclaw-sandbox",
    });
  });

  it("includes elevated info when allowed", () => {
    const sandbox = createSandboxContext({
      browser: undefined,
      browserAllowHostControl: false,
    });

    expect(
      buildEmbeddedSandboxInfo(sandbox, {
        allowed: true,
        defaultLevel: "on",
        enabled: true,
      }),
    ).toEqual({
      agentWorkspaceMount: undefined,
      containerWorkspaceDir: "/workspace",
      elevated: { allowed: true, defaultLevel: "on" },
      enabled: true,
      hostBrowserAllowed: false,
      workspaceAccess: "none",
      workspaceDir: "/tmp/openclaw-sandbox",
    });
  });
});
