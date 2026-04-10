import { describe, expect, it } from "vitest";
import { resolveGatewayProbeAuth as resolveStatusGatewayProbeAuth } from "../commands/status.gateway-probe.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayAuth } from "./auth.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";
import { resolveGatewayProbeAuth } from "./probe-auth.js";

interface ExpectedCredentialSet {
  call: { token?: string; password?: string };
  probe: { token?: string; password?: string };
  status: { token?: string; password?: string };
  auth: { token?: string; password?: string };
}

interface TestCase {
  name: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  expected: ExpectedCredentialSet;
}

const gatewayEnv = {
  OPENCLAW_GATEWAY_TOKEN: "env-token", // Pragma: allowlist secret
  OPENCLAW_GATEWAY_PASSWORD: "env-password", // Pragma: allowlist secret
} as NodeJS.ProcessEnv;

function makeRemoteGatewayConfig(remote: { token?: string; password?: string }): OpenClawConfig {
  return {
    gateway: {
      auth: {
        password: "local-password",
        token: "local-token", // Pragma: allowlist secret
      },
      mode: "remote",
      remote,
    },
  } as OpenClawConfig;
}

function withGatewayAuthEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const keys = [
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "OPENCLAW_SERVICE_KIND",
  ] as const;
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    const nextValue = env[key];
    if (typeof nextValue === "string") {
      process.env[key] = nextValue;
    } else {
      delete process.env[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
}

describe("gateway credential precedence coverage", () => {
  const cases: TestCase[] = [
    {
      cfg: {
        gateway: {
          auth: {
            password: "config-password",
            token: "config-token", // pragma: allowlist secret
          },
          mode: "local",
        },
      } as OpenClawConfig,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token", // Pragma: allowlist secret
        OPENCLAW_GATEWAY_PASSWORD: "env-password", // Pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      expected: {
        call: { password: "env-password", token: "env-token" }, // Pragma: allowlist secret
        probe: { password: "env-password", token: "env-token" }, // Pragma: allowlist secret
        status: { password: "config-password", token: "config-token" }, // Pragma: allowlist secret
        auth: { password: "config-password", token: "config-token" }, // Pragma: allowlist secret
      },
      name: "local mode: env overrides config for call/probe/status, auth remains config-first",
    },
    {
      cfg: makeRemoteGatewayConfig({
        password: "remote-password",
        token: "remote-token", // Pragma: allowlist secret
      }),
      env: gatewayEnv,
      expected: {
        call: { password: "env-password", token: "remote-token" }, // Pragma: allowlist secret
        probe: { password: "env-password", token: "remote-token" }, // Pragma: allowlist secret
        status: { password: "local-password", token: "local-token" }, // Pragma: allowlist secret
        auth: { password: "local-password", token: "local-token" }, // Pragma: allowlist secret
      },
      name: "remote mode with remote token configured",
    },
    {
      cfg: makeRemoteGatewayConfig({
        password: "remote-password", // Pragma: allowlist secret
      }),
      env: gatewayEnv,
      expected: {
        call: { password: "env-password", token: "env-token" }, // Pragma: allowlist secret
        probe: { password: "env-password", token: undefined }, // Pragma: allowlist secret
        status: { password: "local-password", token: "local-token" }, // Pragma: allowlist secret
        auth: { password: "local-password", token: "local-token" }, // Pragma: allowlist secret
      },
      name: "remote mode without remote token keeps remote probe/status strict",
    },
    {
      cfg: {
        gateway: {
          auth: {
            password: "config-password",
            token: "config-token", // pragma: allowlist secret
          },
          mode: "local",
        },
      } as OpenClawConfig,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password", // Pragma: allowlist secret
        OPENCLAW_SERVICE_KIND: "gateway",
      } as NodeJS.ProcessEnv,
      expected: {
        call: { password: "env-password", token: "config-token" }, // Pragma: allowlist secret
        probe: { password: "env-password", token: "config-token" }, // Pragma: allowlist secret
        status: { password: "config-password", token: "config-token" }, // Pragma: allowlist secret
        auth: { password: "config-password", token: "config-token" }, // Pragma: allowlist secret
      },
      name: "local mode in gateway service runtime uses config-first token precedence",
    },
  ];

  it.each(cases)("$name", async ({ cfg, env, expected }) => {
    const mode = cfg.gateway?.mode === "remote" ? "remote" : "local";
    const call = resolveGatewayCredentialsFromConfig({
      cfg,
      env,
    });
    const probe = resolveGatewayProbeAuth({
      cfg,
      env,
      mode,
    });
    const status = await withGatewayAuthEnv(env, () => resolveStatusGatewayProbeAuth(cfg));
    const auth = resolveGatewayAuth({
      authConfig: cfg.gateway?.auth,
      env,
    });

    expect(call).toEqual(expected.call);
    expect(probe).toEqual(expected.probe);
    expect(status).toEqual(expected.status);
    expect({ password: auth.password, token: auth.token }).toEqual(expected.auth);
  });
});
