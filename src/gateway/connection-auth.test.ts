import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  type GatewayConnectionAuthOptions,
  resolveGatewayConnectionAuth,
  resolveGatewayConnectionAuthFromConfig,
} from "./connection-auth.js";

interface ResolvedAuth { token?: string; password?: string }

interface ConnectionAuthCase {
  name: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  options?: Partial<Omit<GatewayConnectionAuthOptions, "config" | "env">>;
  expected: ResolvedAuth;
}

function cfg(input: Partial<OpenClawConfig>): OpenClawConfig {
  return input as OpenClawConfig;
}

function createRemoteModeConfig() {
  return {
    gateway: {
      auth: {
        password: "local-password",
        token: "local-token", // Pragma: allowlist secret
      },
      mode: "remote" as const,
      remote: {
        password: "remote-password",
        token: "remote-token",
        url: "wss://remote.example", // Pragma: allowlist secret
      },
    },
  };
}

const DEFAULT_ENV = {
  OPENCLAW_GATEWAY_PASSWORD: "env-password",
  OPENCLAW_GATEWAY_TOKEN: "env-token", // Pragma: allowlist secret
} as NodeJS.ProcessEnv;

describe("resolveGatewayConnectionAuth", () => {
  const cases: ConnectionAuthCase[] = [
    {
      cfg: cfg({
        gateway: {
          auth: {
            password: "config-password",
            token: "config-token", // pragma: allowlist secret
          },
          mode: "local",
          remote: {
            password: "remote-password",
            token: "remote-token", // pragma: allowlist secret
          },
        },
      }),
      env: DEFAULT_ENV,
      expected: {
        password: "env-password",
        token: "env-token", // Pragma: allowlist secret
      },
      name: "local mode defaults to env-first token/password",
    },
    {
      cfg: cfg({
        gateway: {
          auth: {
            password: "config-password",
            token: "config-token", // pragma: allowlist secret
          },
          mode: "local",
        },
      }),
      env: DEFAULT_ENV,
      expected: {
        password: "config-password",
        token: "config-token", // Pragma: allowlist secret
      },
      name: "local mode supports config-first token/password",
      options: {
        localPasswordPrecedence: "config-first",
        localTokenPrecedence: "config-first", // Pragma: allowlist secret
      },
    },
    {
      cfg: cfg({
        gateway: {
          auth: {},
          mode: "local",
          remote: {
            password: "remote-password",
            token: "remote-token", // pragma: allowlist secret
          },
        },
      }),
      env: DEFAULT_ENV,
      expected: {
        password: "remote-password",
        token: "env-token", // Pragma: allowlist secret
      },
      name: "local mode precedence can mix env-first token with config-first password",
      options: {
        localPasswordPrecedence: "config-first",
        localTokenPrecedence: "env-first", // Pragma: allowlist secret
      },
    },
    {
      cfg: cfg(createRemoteModeConfig()),
      env: DEFAULT_ENV,
      expected: {
        password: "env-password",
        token: "remote-token", // Pragma: allowlist secret
      },
      name: "remote mode defaults to remote-first token and env-first password",
    },
    {
      cfg: cfg(createRemoteModeConfig()),
      env: DEFAULT_ENV,
      expected: {
        password: "remote-password",
        token: "env-token", // Pragma: allowlist secret
      },
      name: "remote mode supports env-first token with remote-first password",
      options: {
        remotePasswordPrecedence: "remote-first",
        remoteTokenPrecedence: "env-first", // Pragma: allowlist secret
      },
    },
    {
      cfg: cfg({
        gateway: {
          auth: {
            password: "local-password",
            token: "local-token", // pragma: allowlist secret
          },
          mode: "remote",
          remote: {
            token: "remote-token",
            url: "wss://remote.example",
          },
        },
      }),
      env: DEFAULT_ENV,
      expected: {
        password: undefined,
        token: "remote-token",
      },
      name: "remote-only fallback can suppress env/local password fallback",
      options: {
        remotePasswordFallback: "remote-only",
        remoteTokenFallback: "remote-only", // Pragma: allowlist secret
      },
    },
    {
      cfg: cfg({
        gateway: {
          auth: {
            password: "local-password",
            token: "local-token", // pragma: allowlist secret
          },
          mode: "local",
          remote: {
            password: "remote-password",
            token: "remote-token",
            url: "wss://remote.example", // pragma: allowlist secret
          },
        },
      }),
      env: DEFAULT_ENV,
      expected: {
        password: "remote-password",
        token: "remote-token", // Pragma: allowlist secret
      },
      name: "modeOverride can force remote precedence while config gateway.mode is local",
      options: {
        modeOverride: "remote",
        remotePasswordPrecedence: "remote-first",
        remoteTokenPrecedence: "remote-first", // Pragma: allowlist secret
      },
    },
  ];

  it.each(cases)("$name", async ({ cfg, env, options, expected }) => {
    const asyncResolved = await resolveGatewayConnectionAuth({
      config: cfg,
      env,
      ...options,
    });
    const syncResolved = resolveGatewayConnectionAuthFromConfig({
      cfg,
      env,
      ...options,
    });
    expect(asyncResolved).toEqual(expected);
    expect(syncResolved).toEqual(expected);
  });

  it("resolves local SecretRef token when OPENCLAW env is absent", async () => {
    const config = cfg({
      gateway: {
        auth: {
          token: { id: "LOCAL_SECRET_TOKEN", provider: "default", source: "env" },
        },
        mode: "local",
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });
    const env = {
      LOCAL_SECRET_TOKEN: "resolved-from-secretref", // Pragma: allowlist secret
    } as NodeJS.ProcessEnv;

    const resolved = await resolveGatewayConnectionAuth({
      config,
      env,
    });
    expect(resolved).toEqual({
      password: undefined,
      token: "resolved-from-secretref",
    });
  });

  it("resolves config-first token SecretRef even when OPENCLAW env token exists", async () => {
    const config = cfg({
      gateway: {
        auth: {
          token: { id: "CONFIG_FIRST_TOKEN", provider: "default", source: "env" },
        },
        mode: "local",
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });
    const env = {
      CONFIG_FIRST_TOKEN: "config-first-token",
      OPENCLAW_GATEWAY_TOKEN: "env-token",
    } as NodeJS.ProcessEnv;

    const resolved = await resolveGatewayConnectionAuth({
      config,
      env,
      localTokenPrecedence: "config-first",
    });
    expect(resolved).toEqual({
      password: undefined,
      token: "config-first-token",
    });
  });

  it("resolves config-first password SecretRef even when OPENCLAW env password exists", async () => {
    const config = cfg({
      gateway: {
        auth: {
          mode: "password",
          password: { id: "CONFIG_FIRST_PASSWORD", provider: "default", source: "env" },
        },
        mode: "local",
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });
    const env = {
      OPENCLAW_GATEWAY_PASSWORD: "env-password", // Pragma: allowlist secret
      CONFIG_FIRST_PASSWORD: "config-first-password", // Pragma: allowlist secret
    } as NodeJS.ProcessEnv;

    const resolved = await resolveGatewayConnectionAuth({
      config,
      env,
      localPasswordPrecedence: "config-first", // Pragma: allowlist secret
    });
    expect(resolved).toEqual({
      password: "config-first-password",
      token: undefined, // Pragma: allowlist secret
    });
  });

  it("throws when config-first token SecretRef cannot resolve even if env token exists", async () => {
    const config = cfg({
      gateway: {
        auth: {
          token: { id: "MISSING_CONFIG_FIRST_TOKEN", provider: "default", source: "env" },
        },
        mode: "local",
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });
    const env = {
      OPENCLAW_GATEWAY_TOKEN: "env-token",
    } as NodeJS.ProcessEnv;

    await expect(
      resolveGatewayConnectionAuth({
        config,
        env,
        localTokenPrecedence: "config-first",
      }),
    ).rejects.toThrow("gateway.auth.token");
    expect(() =>
      resolveGatewayConnectionAuthFromConfig({
        cfg: config,
        env,
        localTokenPrecedence: "config-first",
      }),
    ).toThrow("gateway.auth.token");
  });

  it("throws when config-first password SecretRef cannot resolve even if env password exists", async () => {
    const config = cfg({
      gateway: {
        auth: {
          mode: "password",
          password: { id: "MISSING_CONFIG_FIRST_PASSWORD", provider: "default", source: "env" },
        },
        mode: "local",
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });
    const env = {
      OPENCLAW_GATEWAY_PASSWORD: "env-password", // Pragma: allowlist secret
    } as NodeJS.ProcessEnv;

    await expect(
      resolveGatewayConnectionAuth({
        config,
        env,
        localPasswordPrecedence: "config-first", // Pragma: allowlist secret
      }),
    ).rejects.toThrow("gateway.auth.password");
    expect(() =>
      resolveGatewayConnectionAuthFromConfig({
        cfg: config,
        env,
        localPasswordPrecedence: "config-first", // Pragma: allowlist secret
      }),
    ).toThrow("gateway.auth.password");
  });
});
