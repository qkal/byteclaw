import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadConfigMock as loadConfig,
  resolveConfigPathMock as resolveConfigPath,
  resolveGatewayPortMock as resolveGatewayPort,
  resolveStateDirMock as resolveStateDir,
} from "../gateway/gateway-connection.test-mocks.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";

vi.mock("../config/config.js", async () => {
  const mocks = await import("../gateway/gateway-connection.test-mocks.js");
  return {
    loadConfig: mocks.loadConfigMock,
    resolveConfigPath: mocks.resolveConfigPathMock,
    resolveGatewayPort: mocks.resolveGatewayPortMock,
    resolveStateDir: mocks.resolveStateDirMock,
  };
});

vi.mock("../gateway/net.js", async () => {
  const mocks = await import("../gateway/gateway-connection.test-mocks.js");
  return {
    isLoopbackHost: mocks.isLoopbackHostMock,
    isSecureWebSocketUrl: mocks.isSecureWebSocketUrlMock,
    pickPrimaryLanIPv4: mocks.pickPrimaryLanIPv4Mock,
  };
});

const { GatewayChatClient, resolveGatewayConnection } = await import("./gateway-chat.js");

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

interface ModeExecProviderFixture {
  tokenMarker: string;
  passwordMarker: string;
  providers: {
    tokenProvider: {
      source: "exec";
      command: string;
      args: string[];
      allowInsecurePath: true;
    };
    passwordProvider: {
      source: "exec";
      command: string;
      args: string[];
      allowInsecurePath: true;
    };
  };
}

async function withModeExecProviderFixture(
  label: string,
  run: (fixture: ModeExecProviderFixture) => Promise<void>,
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-tui-mode-${label}-`));
  const tokenMarker = path.join(tempDir, "token-provider-ran");
  const passwordMarker = path.join(tempDir, "password-provider-ran");
  const tokenExecProgram = [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(tokenMarker)},'1');`,
    "process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { TOKEN_SECRET: 'token-from-exec' } }));", // Pragma: allowlist secret
  ].join("");
  const passwordExecProgram = [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(passwordMarker)},'1');`,
    "process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { PASSWORD_SECRET: 'password-from-exec' } }));", // Pragma: allowlist secret
  ].join("");

  try {
    await run({
      passwordMarker,
      providers: {
        passwordProvider: {
          allowInsecurePath: true,
          args: ["-e", passwordExecProgram],
          command: process.execPath,
          source: "exec",
        },
        tokenProvider: {
          allowInsecurePath: true,
          args: ["-e", tokenExecProgram],
          command: process.execPath,
          source: "exec",
        },
      },
      tokenMarker,
    });
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}

describe("resolveGatewayConnection", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_GATEWAY_URL",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
    ]);
    loadConfig.mockReset();
    resolveGatewayPort.mockReset();
    resolveStateDir.mockReset();
    resolveConfigPath.mockReset();
    resolveGatewayPort.mockReturnValue(18_789);
    resolveStateDir.mockImplementation(
      (env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw",
    );
    resolveConfigPath.mockImplementation(
      (env: NodeJS.ProcessEnv, stateDir: string) =>
        env.OPENCLAW_CONFIG_PATH ?? `${stateDir}/openclaw.json`,
    );
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("throws when url override is missing explicit credentials", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local" } });

    await expect(resolveGatewayConnection({ url: "wss://override.example/ws" })).rejects.toThrow(
      "explicit credentials",
    );
  });

  it.each([
    {
      auth: { token: "explicit-token" },
      expected: { password: undefined, token: "explicit-token" },
      label: "token",
    },
    {
      auth: { password: "explicit-password" },
      expected: { password: "explicit-password", token: undefined },
      label: "password",
    },
  ])("uses explicit $label when url override is set", async ({ auth, expected }) => {
    loadConfig.mockReturnValue({ gateway: { mode: "local" } });

    const result = await resolveGatewayConnection({
      url: "wss://override.example/ws",
      ...auth,
    });

    expect(result).toEqual({
      url: "wss://override.example/ws",
      ...expected,
      allowInsecureLocalOperatorUi: false,
    });
  });
  it("uses config auth token for local mode when both config and env tokens are set", async () => {
    loadConfig.mockReturnValue({ gateway: { auth: { token: "config-token" }, mode: "local" } });

    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, async () => {
      const result = await resolveGatewayConnection({});
      expect(result.token).toBe("config-token");
    });
  });

  it("falls back to OPENCLAW_GATEWAY_TOKEN when config token is missing", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local" } });

    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, async () => {
      const result = await resolveGatewayConnection({});
      expect(result.token).toBe("env-token");
    });
  });

  it("uses local password auth when gateway.auth.mode is unset and password-only is configured", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          password: "config-password", // Pragma: allowlist secret
        },
        mode: "local",
      },
    });

    const result = await resolveGatewayConnection({});
    expect(result.password).toBe("config-password");
    expect(result.token).toBeUndefined();
  });

  it("fails when both local token and password are configured but gateway.auth.mode is unset", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          password: "config-password",
          token: "config-token", // Pragma: allowlist secret
        },
        mode: "local",
      },
    });

    await expect(resolveGatewayConnection({})).rejects.toThrow(
      "gateway.auth.mode is unset. Set gateway.auth.mode to token or password.",
    );
  });

  it("resolves env-template config auth token from referenced env var", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: { token: "${CUSTOM_GATEWAY_TOKEN}" },
        mode: "local",
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });

    await withEnvAsync({ CUSTOM_GATEWAY_TOKEN: "custom-token" }, async () => {
      const result = await resolveGatewayConnection({});
      expect(result.token).toBe("custom-token");
    });
  });

  it("fails with guidance when env-template config auth token is unresolved", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: { token: "${MISSING_GATEWAY_TOKEN}" },
        mode: "local",
      },
    });

    await expect(resolveGatewayConnection({})).rejects.toThrow(
      "gateway.auth.token SecretRef is unresolved",
    );
  });

  it("prefers OPENCLAW_GATEWAY_PASSWORD over remote password fallback", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: { password: "remote-pass", token: "remote-token", url: "wss://remote.example/ws" }, // Pragma: allowlist secret
      },
    });

    const gatewayPasswordEnv = "OPENCLAW_GATEWAY_PASSWORD"; // Pragma: allowlist secret
    const gatewayPassword = "env-pass"; // Pragma: allowlist secret
    await withEnvAsync({ [gatewayPasswordEnv]: gatewayPassword }, async () => {
      const result = await resolveGatewayConnection({});
      expect(result.password).toBe(gatewayPassword);
    });
  });

  it.runIf(process.platform !== "win32")(
    "resolves file-backed SecretRef token for local mode",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tui-file-secret-"));
      const secretFile = path.join(tempDir, "secrets.json");
      await fs.writeFile(secretFile, JSON.stringify({ gatewayToken: "file-secret-token" }), "utf8");
      await fs.chmod(secretFile, 0o600);

      loadConfig.mockReturnValue({
        gateway: {
          auth: {
            token: { id: "/gatewayToken", provider: "fileProvider", source: "file" },
          },
          mode: "local",
        },
        secrets: {
          providers: {
            fileProvider: {
              allowInsecurePath: true,
              mode: "json",
              path: secretFile,
              source: "file",
            },
          },
        },
      });

      try {
        const result = await resolveGatewayConnection({});
        expect(result.token).toBe("file-secret-token");
      } finally {
        await fs.rm(tempDir, { force: true, recursive: true });
      }
    },
  );

  it("resolves exec-backed SecretRef token for local mode", async () => {
    const execProgram = [
      "process.stdout.write(",
      "JSON.stringify({ protocolVersion: 1, values: { EXEC_GATEWAY_TOKEN: 'exec-secret-token' } })",
      ");",
    ].join("");

    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: { id: "EXEC_GATEWAY_TOKEN", provider: "execProvider", source: "exec" },
        },
        mode: "local",
      },
      secrets: {
        providers: {
          execProvider: {
            allowInsecurePath: true,
            args: ["-e", execProgram],
            command: process.execPath,
            source: "exec",
          },
        },
      },
    });

    const result = await resolveGatewayConnection({});
    expect(result.token).toBe("exec-secret-token");
  });

  it("resolves only token SecretRef when gateway.auth.mode is token", async () => {
    await withModeExecProviderFixture(
      "token",
      async ({ tokenMarker, passwordMarker, providers }) => {
        loadConfig.mockReturnValue({
          gateway: {
            auth: {
              mode: "token",
              password: { id: "PASSWORD_SECRET", provider: "passwordProvider", source: "exec" },
              token: { id: "TOKEN_SECRET", provider: "tokenProvider", source: "exec" },
            },
            mode: "local",
          },
          secrets: {
            providers,
          },
        });

        const result = await resolveGatewayConnection({});
        expect(result.token).toBe("token-from-exec");
        expect(result.password).toBeUndefined();
        expect(await fileExists(tokenMarker)).toBe(true);
        expect(await fileExists(passwordMarker)).toBe(false);
      },
    );
  });

  it("resolves only password SecretRef when gateway.auth.mode is password", async () => {
    await withModeExecProviderFixture(
      "password",
      async ({ tokenMarker, passwordMarker, providers }) => {
        loadConfig.mockReturnValue({
          gateway: {
            auth: {
              mode: "password",
              password: { id: "PASSWORD_SECRET", provider: "passwordProvider", source: "exec" },
              token: { id: "TOKEN_SECRET", provider: "tokenProvider", source: "exec" },
            },
            mode: "local",
          },
          secrets: {
            providers,
          },
        });

        const result = await resolveGatewayConnection({});
        expect(result.password).toBe("password-from-exec");
        expect(result.token).toBeUndefined();
        expect(await fileExists(tokenMarker)).toBe(false);
        expect(await fileExists(passwordMarker)).toBe(true);
      },
    );
  });

  it("marks loopback local connections for insecure operator ui auth when enabled", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          mode: "token",
          token: "config-token",
        },
        controlUi: {
          allowInsecureAuth: true,
        },
        mode: "local",
      },
    });

    const result = await resolveGatewayConnection({});
    expect(result.allowInsecureLocalOperatorUi).toBe(true);
  });

  it("preserves insecure local operator ui auth when a loopback url override is provided", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          mode: "token",
          token: "config-token",
        },
        controlUi: {
          allowInsecureAuth: true,
        },
        mode: "local",
      },
    });

    const result = await resolveGatewayConnection({
      token: "override-token",
      url: "ws://127.0.0.1:18791",
    });
    expect(result.allowInsecureLocalOperatorUi).toBe(true);
    expect(result.token).toBe("override-token");
  });
});

describe("GatewayChatClient", () => {
  it("identifies the TUI as a tui client and skips device identity on insecure local ui paths", () => {
    const client = new GatewayChatClient({
      allowInsecureLocalOperatorUi: true,
      token: "test-token",
      url: "ws://127.0.0.1:18789",
    });

    expect(
      (client as unknown as { client: { opts: { clientName?: string; mode?: string } } }).client
        .opts.clientName,
    ).toBe("openclaw-tui");
    expect(
      (client as unknown as { client: { opts: { clientName?: string; mode?: string } } }).client
        .opts.mode,
    ).toBe("ui");
    expect(
      (client as unknown as { client: { opts: { deviceIdentity?: unknown } } }).client.opts
        .deviceIdentity,
    ).toBeUndefined();
  });
});
