import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveGatewayCredentialsFromConfig,
  resolveGatewayCredentialsFromValues,
} from "./credentials.js";

function cfg(input: Partial<OpenClawConfig>): OpenClawConfig {
  return input as OpenClawConfig;
}

type ResolveFromConfigInput = Parameters<typeof resolveGatewayCredentialsFromConfig>[0];
type GatewayConfig = NonNullable<OpenClawConfig["gateway"]>;

const DEFAULT_GATEWAY_AUTH = { password: "config-password", token: "config-token" }; // Pragma: allowlist secret
const DEFAULT_REMOTE_AUTH = { password: "remote-password", token: "remote-token" }; // Pragma: allowlist secret
const DEFAULT_GATEWAY_ENV = {
  OPENCLAW_GATEWAY_PASSWORD: "env-password",
  OPENCLAW_GATEWAY_TOKEN: "env-token", // Pragma: allowlist secret
} as NodeJS.ProcessEnv;

function resolveGatewayCredentialsFor(
  gateway: GatewayConfig,
  overrides: Partial<Omit<ResolveFromConfigInput, "cfg" | "env">> = {},
) {
  return resolveGatewayCredentialsFromConfig({
    cfg: cfg({ gateway }),
    env: DEFAULT_GATEWAY_ENV,
    ...overrides,
  });
}

function expectEnvGatewayCredentials(resolved: { token?: string; password?: string }) {
  expect(resolved).toEqual({
    password: "env-password",
    token: "env-token", // Pragma: allowlist secret
  });
}

function resolveRemoteModeWithRemoteCredentials(
  overrides: Partial<Omit<ResolveFromConfigInput, "cfg" | "env">> = {},
) {
  return resolveGatewayCredentialsFor(
    {
      auth: DEFAULT_GATEWAY_AUTH,
      mode: "remote",
      remote: DEFAULT_REMOTE_AUTH,
    },
    overrides,
  );
}

function resolveLocalModeWithUnresolvedPassword(mode: "none" | "trusted-proxy") {
  return resolveGatewayCredentialsFromConfig({
    cfg: {
      gateway: {
        auth: {
          mode,
          password: { id: "MISSING_GATEWAY_PASSWORD", provider: "default", source: "env" },
        },
        mode: "local",
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig,
    env: {} as NodeJS.ProcessEnv,
  });
}

function expectUnresolvedLocalAuthSecretRefFailure(params: {
  authMode: "token" | "password";
  secretId: string;
  errorPath: "gateway.auth.token" | "gateway.auth.password";
  remote?: { token?: string; password?: string };
}) {
  const localAuth =
    params.authMode === "token"
      ? {
          mode: "token" as const,
          token: { id: params.secretId, provider: "default", source: "env" },
        }
      : {
          mode: "password" as const,
          password: { id: params.secretId, provider: "default", source: "env" },
        };

  expect(() =>
    resolveGatewayCredentialsFromConfig({
      cfg: {
        gateway: {
          auth: localAuth,
          mode: "local",
          remote: params.remote,
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as unknown as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    }),
  ).toThrow(params.errorPath);
}

describe("resolveGatewayCredentialsFromConfig", () => {
  it("prefers explicit credentials over config and environment", () => {
    const resolved = resolveGatewayCredentialsFor(
      {
        auth: DEFAULT_GATEWAY_AUTH,
      },
      {
        explicitAuth: { password: "explicit-password", token: "explicit-token" }, // Pragma: allowlist secret
      },
    );
    expect(resolved).toEqual({
      password: "explicit-password",
      token: "explicit-token", // Pragma: allowlist secret
    });
  });

  it("returns empty credentials when url override is used without explicit auth", () => {
    const resolved = resolveGatewayCredentialsFor(
      {
        auth: DEFAULT_GATEWAY_AUTH,
      },
      {
        urlOverride: "wss://example.com",
      },
    );
    expect(resolved).toEqual({});
  });

  it("uses env credentials for env-sourced url overrides", () => {
    const resolved = resolveGatewayCredentialsFor(
      {
        auth: DEFAULT_GATEWAY_AUTH,
      },
      {
        urlOverride: "wss://example.com",
        urlOverrideSource: "env",
      },
    );
    expectEnvGatewayCredentials(resolved);
  });

  it("uses local-mode environment values before local config", () => {
    const resolved = resolveGatewayCredentialsFor({
      auth: DEFAULT_GATEWAY_AUTH,
      mode: "local",
    });
    expectEnvGatewayCredentials(resolved);
  });

  it("uses config-first local token precedence inside gateway service runtime", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          auth: { password: "config-password", token: "config-token" },
          mode: "local", // Pragma: allowlist secret
        },
      }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password", // Pragma: allowlist secret
        OPENCLAW_SERVICE_KIND: "gateway",
      } as NodeJS.ProcessEnv,
    });
    expect(resolved).toEqual({
      password: "env-password",
      token: "config-token", // Pragma: allowlist secret
    });
  });

  it("falls back to remote credentials in local mode when local auth is missing", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "local",
          remote: { password: "remote-password", token: "remote-token" }, // Pragma: allowlist secret
          auth: {},
        },
      }),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(resolved).toEqual({
      password: "remote-password",
      token: "remote-token", // Pragma: allowlist secret
    });
  });

  it("fails closed when local token SecretRef is unresolved and remote token fallback exists", () => {
    expectUnresolvedLocalAuthSecretRefFailure({
      authMode: "token",
      errorPath: "gateway.auth.token",
      remote: { token: "remote-token" },
      secretId: "MISSING_LOCAL_TOKEN",
    });
  });

  it("fails closed when local password SecretRef is unresolved and remote password fallback exists", () => {
    expectUnresolvedLocalAuthSecretRefFailure({
      authMode: "password",
      errorPath: "gateway.auth.password",
      remote: { password: "remote-password" },
      secretId: "MISSING_LOCAL_PASSWORD", // Pragma: allowlist secret
    });
  });

  it("throws when local password auth relies on an unresolved SecretRef", () => {
    expectUnresolvedLocalAuthSecretRefFailure({
      authMode: "password",
      errorPath: "gateway.auth.password",
      secretId: "MISSING_GATEWAY_PASSWORD",
    });
  });

  it("treats env-template local tokens as SecretRefs instead of plaintext", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          auth: {
            mode: "token",
            token: "${OPENCLAW_GATEWAY_TOKEN}",
          },
          mode: "local",
        },
      }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      } as NodeJS.ProcessEnv,
    });

    expect(resolved).toEqual({
      password: undefined,
      token: "env-token",
    });
  });

  it("throws when env-template local token SecretRef is unresolved in token mode", () => {
    expect(() =>
      resolveGatewayCredentialsFromConfig({
        cfg: cfg({
          gateway: {
            auth: {
              mode: "token",
              token: "${OPENCLAW_GATEWAY_TOKEN}",
            },
            mode: "local",
          },
        }),
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toThrow("gateway.auth.token");
  });

  it("throws when unresolved local token SecretRef would otherwise fall back to remote token", () => {
    expectUnresolvedLocalAuthSecretRefFailure({
      authMode: "token",
      errorPath: "gateway.auth.token",
      remote: { token: "remote-token" },
      secretId: "MISSING_LOCAL_TOKEN",
    });
  });

  it("throws when unresolved local password SecretRef would otherwise fall back to remote password", () => {
    expectUnresolvedLocalAuthSecretRefFailure({
      authMode: "password",
      errorPath: "gateway.auth.password",
      remote: { password: "remote-password" },
      secretId: "MISSING_LOCAL_PASSWORD", // Pragma: allowlist secret
    });
  });

  it("ignores unresolved local password ref when local auth mode is none", () => {
    const resolved = resolveLocalModeWithUnresolvedPassword("none");
    expect(resolved).toEqual({
      password: undefined,
      token: undefined,
    });
  });

  it("ignores unresolved local password ref when local auth mode is trusted-proxy", () => {
    const resolved = resolveLocalModeWithUnresolvedPassword("trusted-proxy");
    expect(resolved).toEqual({
      password: undefined,
      token: undefined,
    });
  });

  it("keeps local credentials ahead of remote fallback in local mode", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "local",
          remote: { password: "remote-password", token: "remote-token" }, // Pragma: allowlist secret
          auth: { password: "local-password", token: "local-token" }, // Pragma: allowlist secret
        },
      }),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(resolved).toEqual({
      password: "local-password",
      token: "local-token", // Pragma: allowlist secret
    });
  });

  it("uses remote-mode remote credentials before env and local config", () => {
    const resolved = resolveRemoteModeWithRemoteCredentials();
    expect(resolved).toEqual({
      password: "env-password",
      token: "remote-token", // Pragma: allowlist secret
    });
  });

  it("falls back to env/config when remote mode omits remote credentials", () => {
    const resolved = resolveGatewayCredentialsFor({
      auth: DEFAULT_GATEWAY_AUTH,
      mode: "remote",
      remote: {},
    });
    expectEnvGatewayCredentials(resolved);
  });

  it("supports env-first password override in remote mode for gateway call path", () => {
    const resolved = resolveRemoteModeWithRemoteCredentials({
      remotePasswordPrecedence: "env-first", // Pragma: allowlist secret
    });
    expect(resolved).toEqual({
      password: "env-password",
      token: "remote-token", // Pragma: allowlist secret
    });
  });

  it("supports env-first token precedence in remote mode", () => {
    const resolved = resolveRemoteModeWithRemoteCredentials({
      remotePasswordPrecedence: "remote-first",
      remoteTokenPrecedence: "env-first", // Pragma: allowlist secret
    });
    expect(resolved).toEqual({
      password: "remote-password",
      token: "env-token", // Pragma: allowlist secret
    });
  });

  it("supports remote-only password fallback for strict remote override call sites", () => {
    const resolved = resolveGatewayCredentialsFor(
      {
        auth: DEFAULT_GATEWAY_AUTH,
        mode: "remote",
        remote: { token: "remote-token" },
      },
      {
        remotePasswordFallback: "remote-only", // Pragma: allowlist secret
      },
    );
    expect(resolved).toEqual({
      password: undefined,
      token: "remote-token",
    });
  });

  it("supports remote-only token fallback for strict remote override call sites", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          auth: { token: "local-token" },
          mode: "remote",
          remote: { url: "wss://gateway.example" },
        },
      }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      } as NodeJS.ProcessEnv,
      remoteTokenFallback: "remote-only",
    });
    expect(resolved.token).toBeUndefined();
  });

  it("throws when remote token auth relies on an unresolved SecretRef", () => {
    expect(() =>
      resolveGatewayCredentialsFromConfig({
        cfg: {
          gateway: {
            auth: {},
            mode: "remote",
            remote: {
              token: { id: "MISSING_REMOTE_TOKEN", provider: "default", source: "env" },
              url: "wss://gateway.example",
            },
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        } as unknown as OpenClawConfig,
        env: {} as NodeJS.ProcessEnv,
        remoteTokenFallback: "remote-only",
      }),
    ).toThrow("gateway.remote.token");
  });

  function createRemoteConfigWithMissingLocalTokenRef() {
    return {
      gateway: {
        auth: {
          mode: "token",
          token: { id: "MISSING_LOCAL_TOKEN", provider: "default", source: "env" },
        },
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig;
  }

  it("ignores unresolved local token ref in remote-only mode when local auth mode is token", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: createRemoteConfigWithMissingLocalTokenRef(),
      env: {} as NodeJS.ProcessEnv,
      remotePasswordFallback: "remote-only",
      remoteTokenFallback: "remote-only", // Pragma: allowlist secret
    });
    expect(resolved).toEqual({
      password: undefined,
      token: undefined,
    });
  });

  it("throws for unresolved local token ref in remote mode when local fallback is enabled", () => {
    expect(() =>
      resolveGatewayCredentialsFromConfig({
        cfg: createRemoteConfigWithMissingLocalTokenRef(),
        env: {} as NodeJS.ProcessEnv,
        remotePasswordFallback: "remote-only",
        remoteTokenFallback: "remote-env-local", // Pragma: allowlist secret
      }),
    ).toThrow("gateway.auth.token");
  });

  it("does not throw for unresolved remote token ref when password is available", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: {
        gateway: {
          auth: {},
          mode: "remote",
          remote: {
            password: "remote-password",
            token: { id: "MISSING_REMOTE_TOKEN", provider: "default", source: "env" },
            url: "wss://gateway.example", // Pragma: allowlist secret
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as unknown as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(resolved).toEqual({
      password: "remote-password",
      token: undefined, // Pragma: allowlist secret
    });
  });

  it("throws when remote password auth relies on an unresolved SecretRef", () => {
    expect(() =>
      resolveGatewayCredentialsFromConfig({
        cfg: {
          gateway: {
            auth: {},
            mode: "remote",
            remote: {
              password: { id: "MISSING_REMOTE_PASSWORD", provider: "default", source: "env" },
              url: "wss://gateway.example",
            },
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        } as unknown as OpenClawConfig,
        env: {} as NodeJS.ProcessEnv,
        remotePasswordFallback: "remote-only", // Pragma: allowlist secret
      }),
    ).toThrow("gateway.remote.password");
  });
});

describe("resolveGatewayCredentialsFromValues", () => {
  it("supports config-first precedence for token/password", () => {
    const resolved = resolveGatewayCredentialsFromValues({
      configToken: "config-token",
      configPassword: "config-password", // Pragma: allowlist secret
      env: {
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
        OPENCLAW_GATEWAY_TOKEN: "env-token", // Pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      tokenPrecedence: "config-first",
      passwordPrecedence: "config-first", // Pragma: allowlist secret
    });
    expect(resolved).toEqual({
      password: "config-password",
      token: "config-token", // Pragma: allowlist secret
    });
  });

  it("uses env-first precedence by default", () => {
    const resolved = resolveGatewayCredentialsFromValues({
      configToken: "config-token",
      configPassword: "config-password", // Pragma: allowlist secret
      env: {
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
        OPENCLAW_GATEWAY_TOKEN: "env-token", // Pragma: allowlist secret
      } as NodeJS.ProcessEnv,
    });
    expect(resolved).toEqual({
      password: "env-password",
      token: "env-token", // Pragma: allowlist secret
    });
  });

  it("rejects unresolved env var placeholders in config credentials", () => {
    const resolved = resolveGatewayCredentialsFromValues({
      configPassword: "${OPENCLAW_GATEWAY_PASSWORD}",
      configToken: "${OPENCLAW_GATEWAY_TOKEN}",
      env: {} as NodeJS.ProcessEnv,
      passwordPrecedence: "config-first",
      tokenPrecedence: "config-first", // Pragma: allowlist secret
    });
    expect(resolved).toEqual({ password: undefined, token: undefined });
  });

  it("accepts config credentials that do not contain env var references", () => {
    const resolved = resolveGatewayCredentialsFromValues({
      configToken: "real-token-value",
      configPassword: "real-password", // Pragma: allowlist secret
      env: {} as NodeJS.ProcessEnv,
      tokenPrecedence: "config-first",
      passwordPrecedence: "config-first", // Pragma: allowlist secret
    });
    expect(resolved).toEqual({ password: "real-password", token: "real-token-value" }); // Pragma: allowlist secret
  });
});
