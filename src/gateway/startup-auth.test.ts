import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { expectGeneratedTokenPersistedToGatewayAuth } from "../test-utils/auth-token-assertions.js";

const mocks = vi.hoisted(() => ({
  replaceConfigFile: vi.fn(async (_params: { nextConfig: OpenClawConfig }) => {}),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

let assertHooksTokenSeparateFromGatewayAuth: typeof import("./startup-auth.js").assertHooksTokenSeparateFromGatewayAuth;
let ensureGatewayStartupAuth: typeof import("./startup-auth.js").ensureGatewayStartupAuth;

async function loadFreshStartupAuthModuleForTest() {
  vi.resetModules();
  ({ assertHooksTokenSeparateFromGatewayAuth, ensureGatewayStartupAuth } =
    await import("./startup-auth.js"));
}

describe("ensureGatewayStartupAuth", () => {
  async function expectEphemeralGeneratedTokenWhenOverridden(cfg: OpenClawConfig) {
    const result = await ensureGatewayStartupAuth({
      authOverride: { mode: "token" },
      cfg,
      env: {} as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toMatch(/^[0-9a-f]{48}$/);
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe(result.generatedToken);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    mocks.replaceConfigFile.mockClear();
    await loadFreshStartupAuthModuleForTest();
  });

  async function expectNoTokenGeneration(cfg: OpenClawConfig, mode: string) {
    const result = await ensureGatewayStartupAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe(mode);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  }

  async function expectResolvedToken(params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    expectedToken: string;
    expectedConfiguredToken?: unknown;
  }) {
    const result = await ensureGatewayStartupAuth({
      cfg: params.cfg,
      env: params.env,
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe(params.expectedToken);
    if ("expectedConfiguredToken" in params) {
      expect(result.cfg.gateway?.auth?.token).toEqual(params.expectedConfiguredToken);
    }
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  }

  function createMissingGatewayTokenSecretRefConfig(): OpenClawConfig {
    return {
      gateway: {
        auth: {
          mode: "token",
          token: { id: "MISSING_GW_TOKEN", provider: "default", source: "env" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
  }

  it("generates and persists a token when startup auth is missing", async () => {
    const result = await ensureGatewayStartupAuth({
      cfg: {},
      env: {} as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toMatch(/^[0-9a-f]{48}$/);
    expect(result.persistedGeneratedToken).toBe(true);
    expect(result.auth.mode).toBe("token");
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
    const persistedParams = mocks.replaceConfigFile.mock.calls[0]?.[0] as
      | { nextConfig: OpenClawConfig }
      | undefined;
    expectGeneratedTokenPersistedToGatewayAuth({
      authToken: result.auth.token,
      generatedToken: result.generatedToken,
      persistedConfig: persistedParams?.nextConfig,
    });
  });

  it("does not generate when token already exists", async () => {
    await expectResolvedToken({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: "configured-token",
          },
        },
      },
      env: {} as NodeJS.ProcessEnv,
      expectedToken: "configured-token",
    });
  });

  it("does not generate in password mode", async () => {
    await expectNoTokenGeneration(
      {
        gateway: {
          auth: {
            mode: "password",
          },
        },
      },
      "password",
    );
  });

  it("resolves gateway.auth.password SecretRef before startup auth checks", async () => {
    const result = await ensureGatewayStartupAuth({
      cfg: {
        gateway: {
          auth: {
            mode: "password",
            password: { id: "GW_PASSWORD", provider: "default", source: "env" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
      env: {
        GW_PASSWORD: "resolved-password", // Pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.auth.mode).toBe("password");
    expect(result.auth.password).toBe("resolved-password");
    expect(result.cfg.gateway?.auth?.password).toEqual({
      id: "GW_PASSWORD",
      provider: "default",
      source: "env",
    });
  });

  it("resolves gateway.auth.token SecretRef before startup auth checks", async () => {
    await expectResolvedToken({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: { id: "GW_TOKEN", provider: "default", source: "env" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
      env: {
        GW_TOKEN: "resolved-token",
      } as NodeJS.ProcessEnv,
      expectedConfiguredToken: {
        id: "GW_TOKEN",
        provider: "default",
        source: "env",
      },
      expectedToken: "resolved-token",
    });
  });

  it("resolves env-template gateway.auth.token before env-token short-circuiting", async () => {
    await expectResolvedToken({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: "${OPENCLAW_GATEWAY_TOKEN}",
          },
        },
      },
      env: {
        OPENCLAW_GATEWAY_TOKEN: "resolved-token",
      } as NodeJS.ProcessEnv,
      expectedConfiguredToken: "${OPENCLAW_GATEWAY_TOKEN}",
      expectedToken: "resolved-token",
    });
  });

  it("uses OPENCLAW_GATEWAY_TOKEN without resolving configured token SecretRef", async () => {
    await expectResolvedToken({
      cfg: createMissingGatewayTokenSecretRefConfig(),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "token-from-env",
      } as NodeJS.ProcessEnv,
      expectedToken: "token-from-env",
    });
  });

  it("fails when gateway.auth.token SecretRef is active and unresolved", async () => {
    await expect(
      ensureGatewayStartupAuth({
        cfg: createMissingGatewayTokenSecretRefConfig(),
        env: {} as NodeJS.ProcessEnv,
        persist: true,
      }),
    ).rejects.toThrow(/MISSING_GW_TOKEN/i);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("requires explicit gateway.auth.mode when token and password are both configured", async () => {
    await expect(
      ensureGatewayStartupAuth({
        cfg: {
          gateway: {
            auth: {
              password: "configured-password",
              token: "configured-token", // Pragma: allowlist secret
            },
          },
        },
        env: {} as NodeJS.ProcessEnv,
        persist: true,
      }),
    ).rejects.toThrow(/gateway\.auth\.mode is unset/i);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("uses OPENCLAW_GATEWAY_PASSWORD without resolving configured password SecretRef", async () => {
    const result = await ensureGatewayStartupAuth({
      cfg: {
        gateway: {
          auth: {
            mode: "password",
            password: { id: "MISSING_GW_PASSWORD", provider: "default", source: "env" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
      env: {
        OPENCLAW_GATEWAY_PASSWORD: "password-from-env", // Pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.auth.mode).toBe("password");
    expect(result.auth.password).toBe("password-from-env");
  });

  it("does not resolve gateway.auth.password SecretRef when token mode is explicit", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          password: { id: "GW_PASSWORD", provider: "missing", source: "env" },
          token: "configured-token",
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };

    const result = await ensureGatewayStartupAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe("configured-token");
  });

  it("does not generate in trusted-proxy mode", async () => {
    await expectNoTokenGeneration(
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
        },
      },
      "trusted-proxy",
    );
  });

  it("does not generate in explicit none mode", async () => {
    await expectNoTokenGeneration(
      {
        gateway: {
          auth: {
            mode: "none",
          },
        },
      },
      "none",
    );
  });

  it("treats undefined token override as no override", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "from-config",
        },
      },
    };
    const result = await ensureGatewayStartupAuth({
      authOverride: { mode: "token", token: undefined },
      cfg,
      env: {} as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe("from-config");
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("keeps generated token ephemeral when runtime override flips explicit non-token mode", async () => {
    await expectEphemeralGeneratedTokenWhenOverridden({
      gateway: {
        auth: {
          mode: "password",
        },
      },
    });
  });

  it("keeps generated token ephemeral when runtime override flips explicit none mode", async () => {
    await expectEphemeralGeneratedTokenWhenOverridden({
      gateway: {
        auth: {
          mode: "none",
        },
      },
    });
  });

  it("keeps generated token ephemeral when runtime override flips implicit password mode", async () => {
    await expectEphemeralGeneratedTokenWhenOverridden({
      gateway: {
        auth: {
          password: "configured-password", // Pragma: allowlist secret
        },
      },
    });
  });

  it("throws when hooks token reuses gateway token resolved from env", async () => {
    await expect(
      ensureGatewayStartupAuth({
        cfg: {
          hooks: {
            enabled: true,
            token: "shared-gateway-token-1234567890",
          },
        },
        env: {
          OPENCLAW_GATEWAY_TOKEN: "shared-gateway-token-1234567890",
        } as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/hooks\.token must not match gateway auth token/i);
  });
});

describe("assertHooksTokenSeparateFromGatewayAuth", () => {
  it("throws when hooks token reuses gateway token auth", () => {
    expect(() =>
      assertHooksTokenSeparateFromGatewayAuth({
        auth: {
          allowTailscale: false,
          mode: "token",
          modeSource: "config",
          token: "shared-gateway-token-1234567890",
        },
        cfg: {
          hooks: {
            enabled: true,
            token: "shared-gateway-token-1234567890",
          },
        },
      }),
    ).toThrow(/hooks\.token must not match gateway auth token/i);
  });

  it("allows hooks token when gateway auth is not token mode", () => {
    expect(() =>
      assertHooksTokenSeparateFromGatewayAuth({
        auth: {
          mode: "password",
          modeSource: "config",
          password: "pw", // Pragma: allowlist secret
          allowTailscale: false,
        },
        cfg: {
          hooks: {
            enabled: true,
            token: "shared-gateway-token-1234567890",
          },
        },
      }),
    ).not.toThrow();
  });

  it("allows matching values when hooks are disabled", () => {
    expect(() =>
      assertHooksTokenSeparateFromGatewayAuth({
        auth: {
          allowTailscale: false,
          mode: "token",
          modeSource: "config",
          token: "shared-gateway-token-1234567890",
        },
        cfg: {
          hooks: {
            enabled: false,
            token: "shared-gateway-token-1234567890",
          },
        },
      }),
    ).not.toThrow();
  });
});
