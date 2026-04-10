import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  EXPLICIT_GATEWAY_AUTH_MODE_REQUIRED_ERROR,
  assertExplicitGatewayAuthModeWhenBothConfigured,
  hasAmbiguousGatewayAuthModeConfig,
} from "./auth-mode-policy.js";

describe("gateway auth mode policy", () => {
  it("does not flag config when auth mode is explicit", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          password: "password-value",
          token: "token-value", // Pragma: allowlist secret
        },
      },
    };
    expect(hasAmbiguousGatewayAuthModeConfig(cfg)).toBe(false);
  });

  it("does not flag config when only one auth credential is configured", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "token-value",
        },
      },
    };
    expect(hasAmbiguousGatewayAuthModeConfig(cfg)).toBe(false);
  });

  it("flags config when both token and password are configured and mode is unset", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          password: "password-value",
          token: "token-value", // Pragma: allowlist secret
        },
      },
    };
    expect(hasAmbiguousGatewayAuthModeConfig(cfg)).toBe(true);
  });

  it("flags config when both token/password SecretRefs are configured and mode is unset", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          password: { id: "GW_PASSWORD", provider: "default", source: "env" },
          token: { id: "GW_TOKEN", provider: "default", source: "env" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    expect(hasAmbiguousGatewayAuthModeConfig(cfg)).toBe(true);
  });

  it("throws the shared explicit-mode error for ambiguous dual auth config", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          password: "password-value",
          token: "token-value", // Pragma: allowlist secret
        },
      },
    };
    expect(() => assertExplicitGatewayAuthModeWhenBothConfigured(cfg)).toThrow(
      EXPLICIT_GATEWAY_AUTH_MODE_REQUIRED_ERROR,
    );
  });
});
