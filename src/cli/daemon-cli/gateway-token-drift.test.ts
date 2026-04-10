import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveGatewayTokenForDriftCheck } from "./gateway-token-drift.js";

describe("resolveGatewayTokenForDriftCheck", () => {
  it("prefers persisted config token over shell env", async () => {
    const token = await resolveGatewayTokenForDriftCheck({
      cfg: {
        gateway: {
          auth: {
            token: "config-token",
          },
          mode: "local",
        },
      } as OpenClawConfig,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      } as NodeJS.ProcessEnv,
    });

    expect(token).toBe("config-token");
  });

  it("resolves env-backed local gateway token refs from the provided env", async () => {
    const token = await resolveGatewayTokenForDriftCheck({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: { id: "SERVICE_GATEWAY_TOKEN", provider: "default", source: "env" },
          },
          mode: "local",
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      env: {
        SERVICE_GATEWAY_TOKEN: "service-token",
      } as NodeJS.ProcessEnv,
    });

    expect(token).toBe("service-token");
  });

  it("throws when an active local token ref is unresolved", async () => {
    await expect(
      resolveGatewayTokenForDriftCheck({
        cfg: {
          gateway: {
            auth: {
              mode: "token",
              token: { id: "MISSING_LOCAL_TOKEN", provider: "default", source: "env" },
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
        } as OpenClawConfig,
        env: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/gateway\.auth\.token/i);
  });

  it("returns undefined when token auth is disabled by mode", async () => {
    const token = await resolveGatewayTokenForDriftCheck({
      cfg: {
        gateway: {
          auth: {
            mode: "password",
            token: { id: "MISSING_LOCAL_TOKEN", provider: "default", source: "env" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(token).toBeUndefined();
  });

  it("returns undefined when password fallback is active with mode unset and no token candidate", async () => {
    const token = await resolveGatewayTokenForDriftCheck({
      cfg: {
        gateway: {
          auth: {
            password: "config-password",
          },
        },
      } as OpenClawConfig,
      env: {
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
      } as NodeJS.ProcessEnv,
    });

    expect(token).toBeUndefined();
  });

  it("does not skip token resolution when mode is unset and token can win", async () => {
    await expect(
      resolveGatewayTokenForDriftCheck({
        cfg: {
          gateway: {
            auth: {
              token: { id: "MISSING_LOCAL_TOKEN", provider: "default", source: "env" },
            },
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        } as OpenClawConfig,
        env: {
          OPENCLAW_GATEWAY_PASSWORD: "env-password",
        } as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/gateway\.auth\.token/i);
  });
});
