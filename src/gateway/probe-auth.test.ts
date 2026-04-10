import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveGatewayProbeAuthSafe,
  resolveGatewayProbeAuthSafeWithSecretInputs,
  resolveGatewayProbeAuthWithSecretInputs,
  resolveGatewayProbeTarget,
} from "./probe-auth.js";

function expectUnresolvedProbeTokenWarning(cfg: OpenClawConfig) {
  const result = resolveGatewayProbeAuthSafe({
    cfg,
    env: {} as NodeJS.ProcessEnv,
    mode: "local",
  });

  expect(result.auth).toEqual({});
  expect(result.warning).toContain("gateway.auth.token");
  expect(result.warning).toContain("unresolved");
}

describe("resolveGatewayProbeAuthSafe", () => {
  it("returns probe auth credentials when available", () => {
    const result = resolveGatewayProbeAuthSafe({
      cfg: {
        gateway: {
          auth: {
            token: "token-value",
          },
        },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      mode: "local",
    });

    expect(result).toEqual({
      auth: {
        password: undefined,
        token: "token-value",
      },
    });
  });

  it("returns warning and empty auth when token SecretRef is unresolved", () => {
    expectUnresolvedProbeTokenWarning({
      gateway: {
        auth: {
          mode: "token",
          token: { id: "MISSING_GATEWAY_TOKEN", provider: "default", source: "env" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as OpenClawConfig);
  });

  it("does not fall through to remote token when local token SecretRef is unresolved", () => {
    expectUnresolvedProbeTokenWarning({
      gateway: {
        auth: {
          mode: "token",
          token: { id: "MISSING_GATEWAY_TOKEN", provider: "default", source: "env" },
        },
        mode: "local",
        remote: {
          token: "remote-token",
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as OpenClawConfig);
  });

  it("ignores unresolved local token SecretRef in remote mode when remote-only auth is requested", () => {
    const result = resolveGatewayProbeAuthSafe({
      cfg: {
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
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      mode: "remote",
    });

    expect(result).toEqual({
      auth: {
        password: undefined,
        token: undefined,
      },
    });
  });
});

describe("resolveGatewayProbeTarget", () => {
  it("falls back to local probe mode when remote mode is configured without remote url", () => {
    expect(
      resolveGatewayProbeTarget({
        gateway: {
          mode: "remote",
        },
      } as OpenClawConfig),
    ).toEqual({
      gatewayMode: "remote",
      mode: "local",
      remoteUrlMissing: true,
    });
  });

  it("keeps remote probe mode when remote url is configured", () => {
    expect(
      resolveGatewayProbeTarget({
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example",
          },
        },
      } as OpenClawConfig),
    ).toEqual({
      gatewayMode: "remote",
      mode: "remote",
      remoteUrlMissing: false,
    });
  });
});

describe("resolveGatewayProbeAuthSafeWithSecretInputs", () => {
  it("resolves env SecretRef token via async secret-inputs path", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: { id: "OPENCLAW_GATEWAY_TOKEN", provider: "default", source: "env" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "test-token-from-env",
      } as NodeJS.ProcessEnv,
      mode: "local",
    });

    expect(result.warning).toBeUndefined();
    expect(result.auth).toEqual({
      password: undefined,
      token: "test-token-from-env",
    });
  });

  it("returns warning and empty auth when SecretRef cannot be resolved via async path", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: { id: "MISSING_TOKEN_XYZ", provider: "default", source: "env" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      mode: "local",
    });

    expect(result.auth).toEqual({});
    expect(result.warning).toContain("gateway.auth.token");
    expect(result.warning).toContain("unresolved");
  });
});

describe("resolveGatewayProbeAuthWithSecretInputs", () => {
  it("resolves local probe SecretRef values before shared credential selection", async () => {
    const auth = await resolveGatewayProbeAuthWithSecretInputs({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: { id: "DAEMON_GATEWAY_TOKEN", provider: "default", source: "env" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      env: {
        DAEMON_GATEWAY_TOKEN: "resolved-daemon-token",
      } as NodeJS.ProcessEnv,
      mode: "local",
    });

    expect(auth).toEqual({
      password: undefined,
      token: "resolved-daemon-token",
    });
  });
});
