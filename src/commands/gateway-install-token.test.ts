import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const replaceConfigFileMock = vi.hoisted(() => vi.fn());
const resolveSecretInputRefMock = vi.hoisted(() =>
  vi.fn((): { ref: unknown } => ({ ref: undefined })),
);
const hasConfiguredSecretInputMock = vi.hoisted(() =>
  vi.fn((value: unknown) => {
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    return value != null;
  }),
);
const resolveGatewayAuthMock = vi.hoisted(() =>
  vi.fn(() => ({
    allowTailscale: false,
    mode: "token",
    password: undefined,
    token: undefined,
  })),
);
const shouldRequireGatewayTokenForInstallMock = vi.hoisted(() => vi.fn(() => true));
const resolveSecretRefValuesMock = vi.hoisted(() => vi.fn());
const secretRefKeyMock = vi.hoisted(() => vi.fn(() => "env:default:OPENCLAW_GATEWAY_TOKEN"));
const randomTokenMock = vi.hoisted(() => vi.fn(() => "generated-token"));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  replaceConfigFile: replaceConfigFileMock,
}));

vi.mock("../config/types.secrets.js", () => ({
  hasConfiguredSecretInput: hasConfiguredSecretInputMock,
  resolveSecretInputRef: resolveSecretInputRefMock,
}));

vi.mock("../gateway/auth.js", () => ({
  resolveGatewayAuth: resolveGatewayAuthMock,
}));

vi.mock("../gateway/auth-install-policy.js", () => ({
  shouldRequireGatewayTokenForInstall: shouldRequireGatewayTokenForInstallMock,
}));

vi.mock("../secrets/ref-contract.js", () => ({
  secretRefKey: secretRefKeyMock,
}));

vi.mock("../secrets/resolve.js", () => ({
  resolveSecretRefValues: resolveSecretRefValuesMock,
}));

vi.mock("./onboard-helpers.js", () => ({
  randomToken: randomTokenMock,
}));

describe("resolveGatewayInstallToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readConfigFileSnapshotMock.mockResolvedValue({ config: {}, exists: false, valid: true });
    resolveSecretInputRefMock.mockReturnValue({ ref: undefined });
    hasConfiguredSecretInputMock.mockImplementation((value: unknown) => {
      if (typeof value === "string") {
        return value.trim().length > 0;
      }
      return value != null;
    });
    resolveSecretRefValuesMock.mockResolvedValue(new Map());
    shouldRequireGatewayTokenForInstallMock.mockReturnValue(true);
    resolveGatewayAuthMock.mockReturnValue({
      allowTailscale: false,
      mode: "token",
      password: undefined,
      token: undefined,
    });
    randomTokenMock.mockReturnValue("generated-token");
  });

  it("uses plaintext gateway.auth.token when configured", async () => {
    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { token: "config-token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      token: "config-token",
      tokenRefConfigured: false,
      unavailableReason: undefined,
      warnings: [],
    });
  });

  it("validates SecretRef token but does not persist resolved plaintext", async () => {
    const tokenRef = { id: "OPENCLAW_GATEWAY_TOKEN", provider: "default", source: "env" };
    resolveSecretInputRefMock.mockReturnValue({ ref: tokenRef });
    resolveSecretRefValuesMock.mockResolvedValue(
      new Map([["env:default:OPENCLAW_GATEWAY_TOKEN", "resolved-token"]]),
    );

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token", token: tokenRef } },
      } as OpenClawConfig,
      env: { OPENCLAW_GATEWAY_TOKEN: "resolved-token" } as NodeJS.ProcessEnv,
    });

    expect(result.token).toBeUndefined();
    expect(result.tokenRefConfigured).toBe(true);
    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings.some((message) => message.includes("SecretRef-managed"))).toBeTruthy();
  });

  it("returns unavailable reason when token SecretRef is unresolved in token mode", async () => {
    resolveSecretInputRefMock.mockReturnValue({
      ref: { id: "MISSING_GATEWAY_TOKEN", provider: "default", source: "env" },
    });
    resolveSecretRefValuesMock.mockRejectedValue(new Error("missing env var"));

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token", token: "${MISSING_GATEWAY_TOKEN}" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.token).toBeUndefined();
    expect(result.unavailableReason).toContain("gateway.auth.token SecretRef is configured");
  });

  it("returns unavailable reason when token and password are both configured and mode is unset", async () => {
    const result = await resolveGatewayInstallToken({
      autoGenerateWhenMissing: true,
      config: {
        gateway: {
          auth: {
            password: "password-value",
            token: "token-value", // Pragma: allowlist secret
          },
        },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      persistGeneratedToken: true,
    });

    expect(result.token).toBeUndefined();
    expect(result.unavailableReason).toContain("gateway.auth.mode is unset");
    expect(result.unavailableReason).toContain("openclaw config set gateway.auth.mode token");
    expect(result.unavailableReason).toContain("openclaw config set gateway.auth.mode password");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(resolveSecretRefValuesMock).not.toHaveBeenCalled();
  });

  it("auto-generates token when no source exists and auto-generation is enabled", async () => {
    const result = await resolveGatewayInstallToken({
      autoGenerateWhenMissing: true,
      config: {
        gateway: { auth: { mode: "token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.token).toBe("generated-token");
    expect(result.unavailableReason).toBeUndefined();
    expect(
      result.warnings.some((message) => message.includes("without saving to config")),
    ).toBeTruthy();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("persists auto-generated token when requested", async () => {
    const result = await resolveGatewayInstallToken({
      autoGenerateWhenMissing: true,
      config: {
        gateway: { auth: { mode: "token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      persistGeneratedToken: true,
    });

    expect(result.warnings.some((message) => message.includes("saving to config"))).toBeTruthy();
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      baseHash: undefined,
      nextConfig: expect.objectContaining({
        gateway: {
          auth: {
            mode: "token",
            token: "generated-token",
          },
        },
      }),
    });
  });

  it("drops generated plaintext when config changes to SecretRef before persist", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      config: {
        gateway: {
          auth: {
            token: "${OPENCLAW_GATEWAY_TOKEN}",
          },
        },
      },
      exists: true,
      issues: [],
      valid: true,
    });
    resolveSecretInputRefMock.mockReturnValueOnce({ ref: undefined }).mockReturnValueOnce({
      ref: { id: "OPENCLAW_GATEWAY_TOKEN", provider: "default", source: "env" },
    });

    const result = await resolveGatewayInstallToken({
      autoGenerateWhenMissing: true,
      config: {
        gateway: { auth: { mode: "token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      persistGeneratedToken: true,
    });

    expect(result.token).toBeUndefined();
    expect(
      result.warnings.some((message) => message.includes("skipping plaintext token persistence")),
    ).toBeTruthy();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("does not auto-generate when inferred mode has password SecretRef configured", async () => {
    shouldRequireGatewayTokenForInstallMock.mockReturnValue(false);

    const result = await resolveGatewayInstallToken({
      autoGenerateWhenMissing: true,
      config: {
        gateway: {
          auth: {
            password: { id: "GATEWAY_PASSWORD", provider: "default", source: "env" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      persistGeneratedToken: true,
    });

    expect(result.token).toBeUndefined();
    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings.some((message) => message.includes("Auto-generated"))).toBe(false);
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("passes the install env through to gateway auth resolution", async () => {
    const env = {
      OPENCLAW_GATEWAY_PASSWORD: "dotenv-password", // Pragma: allowlist secret
    } as NodeJS.ProcessEnv;
    shouldRequireGatewayTokenForInstallMock.mockReturnValue(false);
    resolveGatewayAuthMock.mockReturnValue({
      allowTailscale: false,
      mode: "password",
      password: undefined,
      token: undefined,
    });

    const result = await resolveGatewayInstallToken({
      autoGenerateWhenMissing: true,
      config: {
        gateway: { auth: {} },
      } as OpenClawConfig,
      env,
      persistGeneratedToken: true,
    });

    expect(resolveGatewayAuthMock).toHaveBeenCalledWith({
      authConfig: {},
      env,
      tailscaleMode: "off",
    });
    expect(result.token).toBeUndefined();
    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings.some((message) => message.includes("Auto-generated"))).toBe(false);
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("skips token SecretRef resolution when token auth is not required", async () => {
    const tokenRef = { id: "OPENCLAW_GATEWAY_TOKEN", provider: "default", source: "env" };
    resolveSecretInputRefMock.mockReturnValue({ ref: tokenRef });
    shouldRequireGatewayTokenForInstallMock.mockReturnValue(false);

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: {
          auth: {
            mode: "password",
            token: tokenRef,
          },
        },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(resolveSecretRefValuesMock).not.toHaveBeenCalled();
    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(result.token).toBeUndefined();
    expect(result.tokenRefConfigured).toBe(true);
  });
});
