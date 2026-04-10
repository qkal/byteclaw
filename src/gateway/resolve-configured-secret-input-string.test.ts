import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  resolveConfiguredSecretInputWithFallback,
  resolveRequiredConfiguredSecretRefInputString,
} from "./resolve-configured-secret-input-string.js";

function createConfig(value: unknown): OpenClawConfig {
  return {
    gateway: {
      auth: {
        token: value,
      },
    },
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  } as OpenClawConfig;
}

describe("resolveConfiguredSecretInputWithFallback", () => {
  it("returns plaintext config value when present", async () => {
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: createConfig("config-token"),
      env: {} as NodeJS.ProcessEnv,
      path: "gateway.auth.token",
      readFallback: () => "env-token",
      value: "config-token",
    });

    expect(resolved).toEqual({
      secretRefConfigured: false,
      source: "config",
      value: "config-token",
    });
  });

  it("returns fallback value when config is empty and no SecretRef is configured", async () => {
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: createConfig(""),
      env: {} as NodeJS.ProcessEnv,
      path: "gateway.auth.token",
      readFallback: () => "env-token",
      value: "",
    });

    expect(resolved).toEqual({
      secretRefConfigured: false,
      source: "fallback",
      value: "env-token",
    });
  });

  it("returns resolved SecretRef value", async () => {
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: createConfig("${CUSTOM_GATEWAY_TOKEN}"),
      env: { CUSTOM_GATEWAY_TOKEN: "resolved-token" } as NodeJS.ProcessEnv,
      path: "gateway.auth.token",
      readFallback: () => undefined,
      value: "${CUSTOM_GATEWAY_TOKEN}",
    });

    expect(resolved).toEqual({
      secretRefConfigured: true,
      source: "secretRef",
      value: "resolved-token",
    });
  });

  it("falls back when SecretRef cannot be resolved", async () => {
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: createConfig("${MISSING_GATEWAY_TOKEN}"),
      env: {} as NodeJS.ProcessEnv,
      path: "gateway.auth.token",
      readFallback: () => "env-fallback-token",
      value: "${MISSING_GATEWAY_TOKEN}",
    });

    expect(resolved).toEqual({
      secretRefConfigured: true,
      source: "fallback",
      value: "env-fallback-token",
    });
  });

  it("returns unresolved reason when SecretRef cannot be resolved and no fallback exists", async () => {
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: createConfig("${MISSING_GATEWAY_TOKEN}"),
      env: {} as NodeJS.ProcessEnv,
      path: "gateway.auth.token",
      value: "${MISSING_GATEWAY_TOKEN}",
    });

    expect(resolved.value).toBeUndefined();
    expect(resolved.source).toBeUndefined();
    expect(resolved.secretRefConfigured).toBe(true);
    expect(resolved.unresolvedRefReason).toContain("gateway.auth.token SecretRef is unresolved");
    expect(resolved.unresolvedRefReason).toContain("MISSING_GATEWAY_TOKEN");
  });
});

describe("resolveRequiredConfiguredSecretRefInputString", () => {
  it("returns undefined when no SecretRef is configured", async () => {
    const value = await resolveRequiredConfiguredSecretRefInputString({
      config: createConfig("plain-token"),
      env: {} as NodeJS.ProcessEnv,
      path: "gateway.auth.token",
      value: "plain-token",
    });

    expect(value).toBeUndefined();
  });

  it("returns resolved SecretRef value", async () => {
    const value = await resolveRequiredConfiguredSecretRefInputString({
      config: createConfig("${CUSTOM_GATEWAY_TOKEN}"),
      env: { CUSTOM_GATEWAY_TOKEN: "resolved-token" } as NodeJS.ProcessEnv,
      path: "gateway.auth.token",
      value: "${CUSTOM_GATEWAY_TOKEN}",
    });

    expect(value).toBe("resolved-token");
  });

  it("throws when SecretRef cannot be resolved", async () => {
    await expect(
      resolveRequiredConfiguredSecretRefInputString({
        config: createConfig("${MISSING_GATEWAY_TOKEN}"),
        env: {} as NodeJS.ProcessEnv,
        path: "gateway.auth.token",
        value: "${MISSING_GATEWAY_TOKEN}",
      }),
    ).rejects.toThrow(/MISSING_GATEWAY_TOKEN/i);
  });
});
