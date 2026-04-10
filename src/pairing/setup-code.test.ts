import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretInput } from "../config/types.secrets.js";

vi.mock("../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: vi.fn(async () => ({
    expiresAtMs: 123,
    token: "bootstrap-123",
  })),
}));

let encodePairingSetupCode: typeof import("./setup-code.js").encodePairingSetupCode;
let resolvePairingSetupFromConfig: typeof import("./setup-code.js").resolvePairingSetupFromConfig;
let issueDeviceBootstrapTokenMock: typeof import("../infra/device-bootstrap.js").issueDeviceBootstrapToken;

describe("pairing setup code", () => {
  type ResolvedSetup = Awaited<ReturnType<typeof resolvePairingSetupFromConfig>>;
  type ResolveSetupConfig = Parameters<typeof resolvePairingSetupFromConfig>[0];
  type ResolveSetupOptions = Parameters<typeof resolvePairingSetupFromConfig>[1];
  type ResolveSetupEnv = NonNullable<ResolveSetupOptions>["env"];
  const defaultEnvSecretProviderConfig = {
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  } as const;
  const gatewayPasswordSecretRef: SecretInput = {
    id: "GW_PASSWORD",
    provider: "default",
    source: "env",
  };
  const missingGatewayTokenSecretRef: SecretInput = {
    id: "MISSING_GW_TOKEN",
    provider: "default",
    source: "env",
  };

  function createCustomGatewayConfig(
    auth: NonNullable<ResolveSetupConfig["gateway"]>["auth"],
    config: Omit<ResolveSetupConfig, "gateway"> = {},
  ): ResolveSetupConfig {
    return {
      ...config,
      gateway: {
        auth,
        bind: "custom",
        customBindHost: "127.0.0.1",
      },
    };
  }

  function createTailnetDnsRunner() {
    return vi.fn(async () => ({
      code: 0,
      stderr: "",
      stdout: '{"Self":{"DNSName":"mb-server.tailnet.ts.net."}}',
    }));
  }

  function createIpv4NetworkInterfaces(
    address: string,
  ): ReturnType<NonNullable<NonNullable<ResolveSetupOptions>["networkInterfaces"]>> {
    return {
      en0: [
        {
          address,
          cidr: `${address}/24`,
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          netmask: "255.255.255.0",
        },
      ],
    };
  }

  function expectResolvedSetupOk(
    resolved: ResolvedSetup,
    params: {
      authLabel: string;
      url?: string;
      urlSource?: string;
    },
  ) {
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("expected setup resolution to succeed");
    }
    expect(resolved.authLabel).toBe(params.authLabel);
    expect(resolved.payload.bootstrapToken).toBe("bootstrap-123");
    expect(issueDeviceBootstrapTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: {
          roles: ["node", "operator"],
          scopes: [
            "operator.approvals",
            "operator.read",
            "operator.talk.secrets",
            "operator.write",
          ],
        },
      }),
    );
    if (params.url) {
      expect(resolved.payload.url).toBe(params.url);
    }
    if (params.urlSource) {
      expect(resolved.urlSource).toBe(params.urlSource);
    }
  }

  function expectResolvedSetupError(resolved: ResolvedSetup, snippet: string) {
    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      throw new Error("expected setup resolution to fail");
    }
    expect(resolved.error).toContain(snippet);
  }

  async function expectResolvedSetupSuccessCase(params: {
    config: ResolveSetupConfig;
    options?: ResolveSetupOptions;
    expected: {
      authLabel: string;
      url: string;
      urlSource: string;
    };
    runCommandWithTimeout?: ReturnType<typeof vi.fn>;
    expectedRunCommandCalls?: number;
  }) {
    const resolved = await resolvePairingSetupFromConfig(params.config, params.options);
    expectResolvedSetupOk(resolved, params.expected);
    if (params.runCommandWithTimeout) {
      expect(params.runCommandWithTimeout).toHaveBeenCalledTimes(
        params.expectedRunCommandCalls ?? 0,
      );
    }
  }

  async function expectResolvedSetupFailureCase(params: {
    config: ResolveSetupConfig;
    options?: ResolveSetupOptions;
    expectedError: string;
  }) {
    try {
      const resolved = await resolvePairingSetupFromConfig(params.config, params.options);
      expectResolvedSetupError(resolved, params.expectedError);
    } catch (error) {
      expect(String(error)).toContain(params.expectedError);
    }
  }

  async function expectResolveCustomGatewayRejects(params: {
    auth: NonNullable<ResolveSetupConfig["gateway"]>["auth"];
    env?: ResolveSetupEnv;
    config?: Omit<ResolveSetupConfig, "gateway">;
    expectedError: RegExp | string;
  }) {
    await expect(
      resolveCustomGatewaySetup({
        auth: params.auth,
        config: params.config,
        env: params.env,
      }),
    ).rejects.toThrow(params.expectedError);
  }

  async function expectResolvedCustomGatewaySetupOk(params: {
    auth: NonNullable<ResolveSetupConfig["gateway"]>["auth"];
    env?: ResolveSetupEnv;
    config?: Omit<ResolveSetupConfig, "gateway">;
    expectedAuthLabel: string;
  }) {
    const resolved = await resolveCustomGatewaySetup({
      auth: params.auth,
      config: params.config,
      env: params.env,
    });
    expectResolvedSetupOk(resolved, { authLabel: params.expectedAuthLabel });
  }

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "");
  });

  beforeAll(async () => {
    ({ encodePairingSetupCode, resolvePairingSetupFromConfig } = await import("./setup-code.js"));
    ({ issueDeviceBootstrapToken: issueDeviceBootstrapTokenMock } =
      await import("../infra/device-bootstrap.js"));
  });

  beforeEach(() => {
    vi.mocked(issueDeviceBootstrapTokenMock).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      expected:
        "eyJ1cmwiOiJ3c3M6Ly9nYXRld2F5LmV4YW1wbGUuY29tOjQ0MyIsImJvb3RzdHJhcFRva2VuIjoiYWJjIn0",
      name: "encodes payload as base64url JSON",
      payload: {
        bootstrapToken: "abc",
        url: "wss://gateway.example.com:443",
      },
    },
  ] as const)("$name", ({ payload, expected }) => {
    expect(encodePairingSetupCode(payload)).toBe(expected);
  });

  async function resolveCustomGatewaySetup(params: {
    auth: NonNullable<ResolveSetupConfig["gateway"]>["auth"];
    env?: ResolveSetupEnv;
    config?: Omit<ResolveSetupConfig, "gateway">;
  }) {
    return await resolvePairingSetupFromConfig(
      createCustomGatewayConfig(params.auth, params.config),
      {
        env: params.env ?? {},
      },
    );
  }

  it.each([
    {
      auth: {
        mode: "password",
        password: gatewayPasswordSecretRef,
      } as const,
      env: {
        GW_PASSWORD: "resolved-password", // Pragma: allowlist secret
      },
      expectedAuthLabel: "password",
      name: "resolves gateway.auth.password SecretRef for pairing payload",
    },
    {
      auth: {
        mode: "password",
        password: { id: "MISSING_GW_PASSWORD", provider: "default", source: "env" },
      } as const,
      env: {
        OPENCLAW_GATEWAY_PASSWORD: "password-from-env", // Pragma: allowlist secret
      },
      expectedAuthLabel: "password",
      name: "uses OPENCLAW_GATEWAY_PASSWORD without resolving configured password SecretRef",
    },
    {
      auth: {
        mode: "token",
        password: { id: "GW_PASSWORD", provider: "missing", source: "env" },
        token: "tok_123",
      } as const,
      env: {},
      expectedAuthLabel: "token",
      name: "does not resolve gateway.auth.password SecretRef in token mode",
    },
    {
      auth: {
        mode: "token",
        token: { id: "GW_TOKEN", provider: "default", source: "env" },
      } as const,
      env: {
        GW_TOKEN: "resolved-token",
      },
      expectedAuthLabel: "token",
      name: "resolves gateway.auth.token SecretRef for pairing payload",
    },
  ] as const)("$name", async ({ auth, env, expectedAuthLabel }) => {
    await expectResolvedCustomGatewaySetupOk({
      auth,
      config: defaultEnvSecretProviderConfig,
      env,
      expectedAuthLabel,
    });
  });

  it.each([
    {
      config: createCustomGatewayConfig(
        {
          mode: "token",
          token: missingGatewayTokenSecretRef,
        },
        defaultEnvSecretProviderConfig,
      ),
      expectedError: "MISSING_GW_TOKEN",
      name: "errors when gateway.auth.token SecretRef is unresolved in token mode",
      options: { env: {} },
    },
  ] as const)("$name", async ({ config, options, expectedError }) => {
    await expectResolvedSetupFailureCase({ config, expectedError, options });
  });

  async function resolveInferredModeWithPasswordEnv(token: SecretInput) {
    return await resolvePairingSetupFromConfig(
      {
        gateway: {
          auth: { token },
          bind: "custom",
          customBindHost: "127.0.0.1",
        },
        ...defaultEnvSecretProviderConfig,
      },
      {
        env: {
          OPENCLAW_GATEWAY_PASSWORD: "password-from-env", // Pragma: allowlist secret
        },
      },
    );
  }

  async function expectInferredPasswordEnvSetupCase(token: SecretInput) {
    const resolved = await resolveInferredModeWithPasswordEnv(token);
    expectResolvedSetupOk(resolved, { authLabel: "password" });
  }

  it.each([
    {
      name: "uses password env in inferred mode without resolving token SecretRef",
      token: {
        id: "MISSING_GW_TOKEN",
        provider: "default",
        source: "env",
      } satisfies SecretInput,
    },
    {
      name: "does not treat env-template token as plaintext in inferred mode",
      token: "${MISSING_GW_TOKEN}",
    },
  ] as const)("$name", async ({ token }) => {
    await expectInferredPasswordEnvSetupCase(token);
  });

  it.each([
    {
      auth: {
        password: gatewayPasswordSecretRef,
        token: { id: "GW_TOKEN", provider: "default", source: "env" },
      } as const,
      env: {
        GW_PASSWORD: "resolved-password",
        GW_TOKEN: "resolved-token", // Pragma: allowlist secret
      },
      name: "requires explicit auth mode when token and password are both configured",
    },
    {
      auth: {
        password: gatewayPasswordSecretRef,
        token: missingGatewayTokenSecretRef,
      } as const,
      env: {
        GW_PASSWORD: "resolved-password", // Pragma: allowlist secret
      },
      name: "errors when token and password SecretRefs are both configured with inferred mode",
    },
  ] as const)("$name", async ({ auth, env }) => {
    await expectResolveCustomGatewayRejects({
      auth,
      config: defaultEnvSecretProviderConfig,
      env,
      expectedError: /gateway\.auth\.mode is unset/i,
    });
  });

  it.each([
    {
      config: {
        gateway: {
          auth: { mode: "token", token: "tok_123" },
          bind: "custom",
          customBindHost: "127.0.0.1",
          port: 19001,
        },
      } satisfies ResolveSetupConfig,
      expected: {
        authLabel: "token",
        url: "ws://127.0.0.1:19001",
        urlSource: "gateway.bind=custom",
      },
      name: "resolves custom bind + token auth",
    },
    {
      config: {
        gateway: {
          auth: { mode: "token", token: "old" },
          bind: "custom",
          customBindHost: "127.0.0.1",
        },
      } satisfies ResolveSetupConfig,
      expected: {
        authLabel: "token",
        url: "ws://127.0.0.1:18789",
        urlSource: "gateway.bind=custom",
      },
      name: "honors env token override",
      options: {
        env: {
          OPENCLAW_GATEWAY_TOKEN: "new-token",
        },
      } satisfies ResolveSetupOptions,
    },
    {
      config: {
        gateway: {
          auth: { mode: "token", token: "tok_123" },
          bind: "custom",
          customBindHost: "10.0.2.2",
        },
      } satisfies ResolveSetupConfig,
      expected: {
        authLabel: "token",
        url: "ws://10.0.2.2:18789",
        urlSource: "gateway.bind=custom",
      },
      name: "allows android emulator cleartext setup urls",
    },
    {
      config: {
        gateway: {
          auth: { mode: "token", token: "tok_123" },
          bind: "custom",
          customBindHost: "192.168.1.20",
        },
      } satisfies ResolveSetupConfig,
      expected: {
        authLabel: "token",
        url: "ws://192.168.1.20:18789",
        urlSource: "gateway.bind=custom",
      },
      name: "allows lan ip cleartext setup urls",
    },
    {
      config: {
        gateway: {
          auth: { mode: "token", token: "tok_123" },
          bind: "custom",
          customBindHost: "gateway.local",
        },
      } satisfies ResolveSetupConfig,
      expected: {
        authLabel: "token",
        url: "ws://gateway.local:18789",
        urlSource: "gateway.bind=custom",
      },
      name: "allows mdns hostname cleartext setup urls",
    },
  ] as const)("$name", async ({ config, options, expected }) => {
    await expectResolvedSetupSuccessCase({
      config,
      expected,
      options,
    });
  });

  it.each([
    {
      config: {
        gateway: {
          auth: { mode: "token", token: "tok_123" },
          bind: "custom",
          customBindHost: "gateway.example",
        },
      } satisfies ResolveSetupConfig,
      expectedError: "Tailscale and public mobile pairing require a secure gateway URL",
      name: "rejects custom bind public ws setup urls for mobile pairing",
    },
    {
      config: {
        gateway: {
          auth: { mode: "token", token: "tok_123" },
          bind: "tailnet",
        },
      } satisfies ResolveSetupConfig,
      expectedError: "prefer gateway.tailscale.mode=serve",
      name: "rejects tailnet bind remote ws setup urls for mobile pairing",
      options: {
        networkInterfaces: () => createIpv4NetworkInterfaces("100.64.0.9"),
      } satisfies ResolveSetupOptions,
    },
  ] as const)("$name", async ({ config, options, expectedError }) => {
    await expectResolvedSetupFailureCase({
      config,
      expectedError,
      options,
    });
  });

  it("allows lan bind cleartext setup urls for mobile pairing", async () => {
    await expectResolvedSetupSuccessCase({
      config: {
        gateway: {
          auth: { mode: "password", password: "secret" },
          bind: "lan",
        },
      } satisfies ResolveSetupConfig,
      expected: {
        authLabel: "password",
        url: "ws://192.168.1.20:18789",
        urlSource: "gateway.bind=lan",
      },
      options: {
        networkInterfaces: () => createIpv4NetworkInterfaces("192.168.1.20"),
      } satisfies ResolveSetupOptions,
    });
  });

  it.each([
    {
      config: {
        gateway: {
          auth: { mode: "token", token: "tok" },
          bind: "loopback",
        },
      } satisfies ResolveSetupConfig,
      expectedError: "only bound to loopback",
      name: "errors when gateway is loopback only",
    },
    {
      config: {
        gateway: {
          auth: { mode: "token", token: "tok" },
          bind: "lan",
        },
      } satisfies ResolveSetupConfig,
      expectedError: "gateway.bind=lan set, but no private LAN IP was found.",
      name: "returns a bind-specific error when interface discovery throws",
      options: {
        networkInterfaces: () => {
          throw new Error("uv_interface_addresses failed");
        },
      } satisfies ResolveSetupOptions,
    },
  ] as const)("$name", async ({ config, options, expectedError }) => {
    await expectResolvedSetupFailureCase({
      config,
      expectedError,
      options,
    });
  });

  it.each([
    {
      config: {
        gateway: {
          auth: { mode: "password", password: "secret" },
          tailscale: { mode: "serve" },
        },
      } satisfies ResolveSetupConfig,
      createOptions: () => {
        const runCommandWithTimeout = createTailnetDnsRunner();
        return {
          expectedRunCommandCalls: 1,
          options: {
            runCommandWithTimeout,
          } satisfies ResolveSetupOptions,
          runCommandWithTimeout,
        };
      },
      expected: {
        authLabel: "password",
        url: "wss://mb-server.tailnet.ts.net",
        urlSource: "gateway.tailscale.mode=serve",
      },
      name: "uses tailscale serve DNS when available",
    },
    {
      config: {
        gateway: {
          auth: { mode: "token", token: "tok_123" },
          remote: { url: "wss://remote.example.com:444" },
          tailscale: { mode: "serve" },
        },
      } satisfies ResolveSetupConfig,
      createOptions: () => {
        const runCommandWithTimeout = createTailnetDnsRunner();
        return {
          expectedRunCommandCalls: 0,
          options: {
            preferRemoteUrl: true,
            runCommandWithTimeout,
          } satisfies ResolveSetupOptions,
          runCommandWithTimeout,
        };
      },
      expected: {
        authLabel: "token",
        url: "wss://remote.example.com:444",
        urlSource: "gateway.remote.url",
      },
      name: "prefers gateway.remote.url over tailscale when requested",
    },
  ] as const)("$name", async ({ config, createOptions, expected }) => {
    const { options, runCommandWithTimeout, expectedRunCommandCalls } = createOptions();
    await expectResolvedSetupSuccessCase({
      config,
      expected,
      expectedRunCommandCalls,
      options,
      runCommandWithTimeout,
    });
  });
});
