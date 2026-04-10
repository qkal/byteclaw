import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";

function makeConfig(): OpenClawConfig {
  return {
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  } as OpenClawConfig;
}

describe("resolveSetupSecretInputString", () => {
  it("resolves env-template SecretInput strings", async () => {
    const resolved = await resolveSetupSecretInputString({
      config: makeConfig(),
      env: {
        OPENCLAW_GATEWAY_PASSWORD: "gateway-secret", // Pragma: allowlist secret
      },
      path: "gateway.auth.password",
      value: "${OPENCLAW_GATEWAY_PASSWORD}",
    });

    expect(resolved).toBe("gateway-secret");
  });

  it("returns plaintext strings when value is not a SecretRef", async () => {
    const resolved = await resolveSetupSecretInputString({
      config: makeConfig(),
      path: "gateway.auth.password",
      value: "plain-text",
    });

    expect(resolved).toBe("plain-text");
  });

  it("throws with path context when env-template SecretRef cannot resolve", async () => {
    await expect(
      resolveSetupSecretInputString({
        config: makeConfig(),
        env: {},
        path: "gateway.auth.password",
        value: "${OPENCLAW_GATEWAY_PASSWORD}",
      }),
    ).rejects.toThrow(
      'gateway.auth.password: failed to resolve SecretRef "env:default:OPENCLAW_GATEWAY_PASSWORD"',
    );
  });
});
