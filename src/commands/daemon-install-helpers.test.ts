import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeStateDirDotEnv } from "../config/test-helpers.js";

const mocks = vi.hoisted(() => ({
  buildServiceEnvironment: vi.fn(),
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
  resolveGatewayProgramArguments: vi.fn(),
  resolvePreferredNodePath: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  loadAuthProfileStoreForSecretsRuntime: mocks.loadAuthProfileStoreForSecretsRuntime,
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
  resolvePreferredNodePath: mocks.resolvePreferredNodePath,
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments: mocks.resolveGatewayProgramArguments,
}));

vi.mock("../daemon/service-env.js", () => ({
  buildServiceEnvironment: mocks.buildServiceEnvironment,
}));

import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
  resolveGatewayDevMode,
} from "./daemon-install-helpers.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("resolveGatewayDevMode", () => {
  it("detects dev mode for src ts entrypoints", () => {
    expect(resolveGatewayDevMode(["node", "/Users/me/openclaw/src/cli/index.ts"])).toBe(true);
    expect(resolveGatewayDevMode(["node", String.raw`C:\Users\me\openclaw\src\cli\index.ts`])).toBe(
      true,
    );
    expect(resolveGatewayDevMode(["node", "/Users/me/openclaw/dist/cli/index.js"])).toBe(false);
  });
});

function mockNodeGatewayPlanFixture(
  params: {
    workingDirectory?: string;
    version?: string;
    supported?: boolean;
    warning?: string;
    serviceEnvironment?: Record<string, string>;
  } = {},
) {
  const {
    workingDirectory = "/Users/me",
    version = "22.0.0",
    supported = true,
    warning,
    serviceEnvironment = { OPENCLAW_PORT: "3000" },
  } = params;
  mocks.resolvePreferredNodePath.mockResolvedValue("/opt/node");
  mocks.resolveGatewayProgramArguments.mockResolvedValue({
    programArguments: ["node", "gateway"],
    workingDirectory,
  });
  mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
    profiles: {},
    version: 1,
  });
  mocks.resolveSystemNodeInfo.mockResolvedValue({
    path: "/opt/node",
    supported,
    version,
  });
  mocks.renderSystemNodeWarning.mockReturnValue(warning);
  mocks.buildServiceEnvironment.mockReturnValue(serviceEnvironment);
}

describe("buildGatewayInstallPlan", () => {
  // Prevent tests from reading the developer's real ~/.openclaw/.env when
  // Passing `env: {}` (which falls back to os.homedir for state-dir resolution).
  let isolatedHome: string;
  beforeEach(() => {
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-plan-test-"));
  });
  afterEach(() => {
    fs.rmSync(isolatedHome, { force: true, recursive: true });
  });

  it("uses provided nodePath and returns plan", async () => {
    mockNodeGatewayPlanFixture();

    const plan = await buildGatewayInstallPlan({
      env: { HOME: isolatedHome },
      nodePath: "/custom/node",
      port: 3000,
      runtime: "node",
    });

    expect(plan.programArguments).toEqual(["node", "gateway"]);
    expect(plan.workingDirectory).toBe("/Users/me");
    expect(plan.environment).toEqual({ OPENCLAW_PORT: "3000" });
    expect(mocks.resolvePreferredNodePath).not.toHaveBeenCalled();
    expect(mocks.buildServiceEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { HOME: isolatedHome },
        extraPathDirs: ["/custom"],
        port: 3000,
      }),
    );
  });

  it("does not prepend '.' when nodePath is a bare executable name", async () => {
    mockNodeGatewayPlanFixture();

    await buildGatewayInstallPlan({
      env: { HOME: isolatedHome },
      nodePath: "node",
      port: 3000,
      runtime: "node",
    });

    expect(mocks.buildServiceEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        extraPathDirs: undefined,
      }),
    );
  });

  it("emits warnings when renderSystemNodeWarning returns one", async () => {
    const warn = vi.fn();
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {},
      supported: false,
      version: "18.0.0",
      warning: "Node too old",
      workingDirectory: undefined,
    });

    await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      warn,
    });

    expect(warn).toHaveBeenCalledWith("Node too old", "Gateway runtime");
    expect(mocks.resolvePreferredNodePath).toHaveBeenCalled();
  });

  it("merges config env vars into the environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/Users/me",
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      config: {
        env: {
          CUSTOM_VAR: "custom-value",
          vars: {
            GOOGLE_API_KEY: "test-key", // Pragma: allowlist secret
          },
        },
      },
      env: {},
      port: 3000,
      runtime: "node",
    });

    // Config env vars should be present
    expect(plan.environment.GOOGLE_API_KEY).toBe("test-key");
    expect(plan.environment.CUSTOM_VAR).toBe("custom-value");
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("CUSTOM_VAR,GOOGLE_API_KEY");
    // Service environment vars should take precedence
    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
    expect(plan.environment.HOME).toBe("/Users/me");
  });

  it("drops dangerous config env vars before service merge", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      config: {
        env: {
          vars: {
            NODE_OPTIONS: "--require /tmp/evil.js",
            SAFE_KEY: "safe-value",
          },
        },
      },
      env: {},
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.NODE_OPTIONS).toBeUndefined();
    expect(plan.environment.SAFE_KEY).toBe("safe-value");
  });

  it("does not include empty config env values", async () => {
    mockNodeGatewayPlanFixture();

    const plan = await buildGatewayInstallPlan({
      config: {
        env: {
          vars: {
            EMPTY_KEY: "",
            VALID_KEY: "valid",
          },
        },
      },
      env: {},
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.VALID_KEY).toBe("valid");
    expect(plan.environment.EMPTY_KEY).toBeUndefined();
  });

  it("drops whitespace-only config env values", async () => {
    mockNodeGatewayPlanFixture({ serviceEnvironment: {} });

    const plan = await buildGatewayInstallPlan({
      config: {
        env: {
          TRIMMED_KEY: "  ",
          vars: {
            VALID_KEY: "valid",
          },
        },
      },
      env: {},
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.VALID_KEY).toBe("valid");
    expect(plan.environment.TRIMMED_KEY).toBeUndefined();
  });

  it("keeps service env values over config env vars", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/Users/service",
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      config: {
        env: {
          HOME: "/Users/config",
          vars: {
            OPENCLAW_PORT: "9999",
          },
        },
      },
      env: {},
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.HOME).toBe("/Users/service");
    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
  });

  it("merges env-backed auth-profile refs into the service environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      profiles: {
        "anthropic:default": {
          provider: "anthropic",
          tokenRef: { id: "ANTHROPIC_TOKEN", provider: "default", source: "env" },
          type: "token",
        },
        "openai:default": {
          keyRef: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
          provider: "openai",
          type: "api_key",
        },
      },
      version: 1,
    });

    const plan = await buildGatewayInstallPlan({
      env: {
        OPENAI_API_KEY: "sk-openai-test", // Pragma: allowlist secret
        ANTHROPIC_TOKEN: "ant-test-token",
      },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.OPENAI_API_KEY).toBe("sk-openai-test");
    expect(plan.environment.ANTHROPIC_TOKEN).toBe("ant-test-token");
  });

  it("blocks dangerous auth-profile env refs from the service environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      profiles: {
        "git:default": {
          provider: "git",
          tokenRef: { id: "GIT_ASKPASS", provider: "default", source: "env" },
          type: "token",
        },
        "node:default": {
          provider: "node",
          tokenRef: { id: "NODE_OPTIONS", provider: "default", source: "env" },
          type: "token",
        },
        "openai:default": {
          keyRef: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
          provider: "openai",
          type: "api_key",
        },
      },
      version: 1,
    });

    const warn = vi.fn();
    const plan = await buildGatewayInstallPlan({
      env: {
        GIT_ASKPASS: "/tmp/askpass.sh",
        NODE_OPTIONS: "--require ./pwn.js",
        OPENAI_API_KEY: "sk-openai-test", // Pragma: allowlist secret
      },
      port: 3000,
      runtime: "node",
      warn,
    });

    expect(plan.environment.NODE_OPTIONS).toBeUndefined();
    expect(plan.environment.GIT_ASKPASS).toBeUndefined();
    expect(plan.environment.OPENAI_API_KEY).toBe("sk-openai-test");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NODE_OPTIONS"), "Auth profile");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("GIT_ASKPASS"), "Auth profile");
  });

  it("skips non-portable auth-profile env ref keys", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      profiles: {
        "broken:default": {
          provider: "broken",
          tokenRef: { id: "BAD KEY", provider: "default", source: "env" },
          type: "token",
        },
      },
      version: 1,
    });

    const plan = await buildGatewayInstallPlan({
      env: {
        "BAD KEY": "should-not-pass",
      },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment["BAD KEY"]).toBeUndefined();
  });

  it("skips unresolved auth-profile env refs", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      profiles: {
        "openai:default": {
          keyRef: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
          provider: "openai",
          type: "api_key",
        },
      },
      version: 1,
    });

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("buildGatewayInstallPlan — dotenv merge", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-plan-dotenv-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { force: true, recursive: true });
  });

  it("merges .env file vars into the install plan", async () => {
    await writeStateDirDotEnv("BRAVE_API_KEY=BSA-from-env\nOPENROUTER_API_KEY=or-key\n", {
      stateDir: path.join(tmpDir, ".openclaw"),
    });
    mockNodeGatewayPlanFixture({ serviceEnvironment: { OPENCLAW_PORT: "3000" } });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.BRAVE_API_KEY).toBe("BSA-from-env");
    expect(plan.environment.OPENROUTER_API_KEY).toBe("or-key");
    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
  });

  it("config env vars override .env file vars", async () => {
    await writeStateDirDotEnv("MY_KEY=from-dotenv\n", {
      stateDir: path.join(tmpDir, ".openclaw"),
    });
    mockNodeGatewayPlanFixture({ serviceEnvironment: {} });

    const plan = await buildGatewayInstallPlan({
      config: {
        env: {
          vars: {
            MY_KEY: "from-config",
          },
        },
      },
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.MY_KEY).toBe("from-config");
  });

  it("service env overrides .env file vars", async () => {
    await writeStateDirDotEnv("HOME=/from-dotenv\n", {
      stateDir: path.join(tmpDir, ".openclaw"),
    });
    mockNodeGatewayPlanFixture({
      serviceEnvironment: { HOME: "/from-service" },
    });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.HOME).toBe("/from-service");
  });

  it("preserves safe custom vars from an existing service env and merges PATH", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
        PATH: "/managed/bin:/usr/bin",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      existingEnvironment: {
        BLOGWATCHER_HOME: "/Users/test/.blogwatcher",
        GOBIN: "/Users/test/.local/gopath/bin",
        GOPATH: "/Users/test/.local/gopath",
        NODE_OPTIONS: "--require /tmp/evil.js",
        OPENCLAW_SERVICE_MARKER: "openclaw",
        PATH: "/custom/go/bin:/usr/bin",
      },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.PATH).toBe("/managed/bin:/usr/bin:/custom/go/bin");
    expect(plan.environment.GOBIN).toBe("/Users/test/.local/gopath/bin");
    expect(plan.environment.BLOGWATCHER_HOME).toBe("/Users/test/.blogwatcher");
    expect(plan.environment.NODE_OPTIONS).toBeUndefined();
    expect(plan.environment.GOPATH).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MARKER).toBeUndefined();
  });

  it("drops non-absolute and temp PATH entries from an existing service env", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
        PATH: "/managed/bin:/usr/bin",
        TMPDIR: "/tmp",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      existingEnvironment: {
        PATH: ".:/tmp/evil:/custom/go/bin:/usr/bin",
      },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.PATH).toBe("/managed/bin:/usr/bin:/custom/go/bin");
  });

  it("drops keys that were previously tracked as managed service env", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
        PATH: "/managed/bin:/usr/bin",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      existingEnvironment: {
        BLOGWATCHER_HOME: "/Users/test/.blogwatcher",
        GOBIN: "/Users/test/.local/gopath/bin",
        GOPATH: "/Users/test/.local/gopath",
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "GOBIN,GOPATH",
        PATH: "/custom/go/bin:/usr/bin",
      },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.PATH).toBe("/managed/bin:/usr/bin:/custom/go/bin");
    expect(plan.environment.GOBIN).toBeUndefined();
    expect(plan.environment.BLOGWATCHER_HOME).toBe("/Users/test/.blogwatcher");
    expect(plan.environment.GOPATH).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
  });

  it("works when .env file does not exist", async () => {
    mockNodeGatewayPlanFixture({ serviceEnvironment: { OPENCLAW_PORT: "3000" } });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
  });
});

describe("gatewayInstallErrorHint", () => {
  it("returns platform-specific hints", () => {
    expect(gatewayInstallErrorHint("win32")).toContain("Startup-folder login item");
    expect(gatewayInstallErrorHint("win32")).toContain("elevated PowerShell");
    expect(gatewayInstallErrorHint("linux")).toMatch(
      /(?:openclaw|openclaw)( --profile isolated)? gateway install/,
    );
  });
});
