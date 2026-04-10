import { describe, expect, test } from "vitest";
import {
  evaluateMissingDeviceIdentity,
  isTrustedProxyControlUiOperatorAuth,
  resolveControlUiAuthPolicy,
  shouldClearUnboundScopesForMissingDeviceIdentity,
  shouldSkipControlUiPairing,
} from "./connect-policy.js";

describe("ws connect policy", () => {
  test("resolves control-ui auth policy", () => {
    const bypass = resolveControlUiAuthPolicy({
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: {
        id: "dev-1",
        nonce: "nonce-1",
        publicKey: "pk",
        signature: "sig",
        signedAt: Date.now(),
      },
      isControlUi: true,
    });
    expect(bypass.allowBypass).toBe(true);
    expect(bypass.device).toBeNull();

    const regular = resolveControlUiAuthPolicy({
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: {
        id: "dev-2",
        nonce: "nonce-2",
        publicKey: "pk",
        signature: "sig",
        signedAt: Date.now(),
      },
      isControlUi: false,
    });
    expect(regular.allowBypass).toBe(false);
    expect(regular.device?.id).toBe("dev-2");
  });

  test("evaluates missing-device decisions", () => {
    const policy = resolveControlUiAuthPolicy({
      controlUiConfig: undefined,
      deviceRaw: null,
      isControlUi: false,
    });

    expect(
      evaluateMissingDeviceIdentity({
        authOk: true,
        controlUiAuthPolicy: policy,
        hasDeviceIdentity: true,
        hasSharedAuth: true,
        isControlUi: false,
        isLocalClient: false,
        role: "node",
        sharedAuthOk: true,
        trustedProxyAuthOk: false,
      }).kind,
    ).toBe("allow");

    const controlUiStrict = resolveControlUiAuthPolicy({
      controlUiConfig: { allowInsecureAuth: true, dangerouslyDisableDeviceAuth: false },
      deviceRaw: null,
      isControlUi: true,
    });
    // Remote Control UI with allowInsecureAuth -> still rejected.
    expect(
      evaluateMissingDeviceIdentity({
        authOk: true,
        controlUiAuthPolicy: controlUiStrict,
        hasDeviceIdentity: false,
        hasSharedAuth: true,
        isControlUi: true,
        isLocalClient: false,
        role: "operator",
        sharedAuthOk: true,
        trustedProxyAuthOk: false,
      }).kind,
    ).toBe("reject-control-ui-insecure-auth");

    // Local Control UI with allowInsecureAuth -> allowed.
    expect(
      evaluateMissingDeviceIdentity({
        authOk: true,
        controlUiAuthPolicy: controlUiStrict,
        hasDeviceIdentity: false,
        hasSharedAuth: true,
        isControlUi: true,
        isLocalClient: true,
        role: "operator",
        sharedAuthOk: true,
        trustedProxyAuthOk: false,
      }).kind,
    ).toBe("allow");

    // Control UI without allowInsecureAuth, even on localhost -> rejected.
    const controlUiNoInsecure = resolveControlUiAuthPolicy({
      controlUiConfig: { dangerouslyDisableDeviceAuth: false },
      deviceRaw: null,
      isControlUi: true,
    });
    expect(
      evaluateMissingDeviceIdentity({
        authOk: true,
        controlUiAuthPolicy: controlUiNoInsecure,
        hasDeviceIdentity: false,
        hasSharedAuth: true,
        isControlUi: true,
        isLocalClient: true,
        role: "operator",
        sharedAuthOk: true,
        trustedProxyAuthOk: false,
      }).kind,
    ).toBe("reject-control-ui-insecure-auth");

    expect(
      evaluateMissingDeviceIdentity({
        authOk: true,
        controlUiAuthPolicy: policy,
        hasDeviceIdentity: false,
        hasSharedAuth: true,
        isControlUi: false,
        isLocalClient: false,
        role: "operator",
        sharedAuthOk: true,
        trustedProxyAuthOk: false,
      }).kind,
    ).toBe("allow");

    expect(
      evaluateMissingDeviceIdentity({
        authOk: false,
        controlUiAuthPolicy: policy,
        hasDeviceIdentity: false,
        hasSharedAuth: true,
        isControlUi: false,
        isLocalClient: false,
        role: "operator",
        sharedAuthOk: false,
        trustedProxyAuthOk: false,
      }).kind,
    ).toBe("reject-unauthorized");

    expect(
      evaluateMissingDeviceIdentity({
        authOk: true,
        controlUiAuthPolicy: policy,
        hasDeviceIdentity: false,
        hasSharedAuth: true,
        isControlUi: false,
        isLocalClient: false,
        role: "node",
        sharedAuthOk: true,
        trustedProxyAuthOk: false,
      }).kind,
    ).toBe("reject-device-required");

    // Trusted-proxy authenticated Control UI should bypass device-identity gating.
    expect(
      evaluateMissingDeviceIdentity({
        authOk: true,
        controlUiAuthPolicy: controlUiNoInsecure,
        hasDeviceIdentity: false,
        hasSharedAuth: false,
        isControlUi: true,
        isLocalClient: false,
        role: "operator",
        sharedAuthOk: false,
        trustedProxyAuthOk: true,
      }).kind,
    ).toBe("allow");

    const bypass = resolveControlUiAuthPolicy({
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: null,
      isControlUi: true,
    });
    expect(
      evaluateMissingDeviceIdentity({
        authOk: false,
        controlUiAuthPolicy: bypass,
        hasDeviceIdentity: false,
        hasSharedAuth: false,
        isControlUi: true,
        isLocalClient: false,
        role: "operator",
        sharedAuthOk: false,
        trustedProxyAuthOk: false,
      }).kind,
    ).toBe("allow");

    // Regression: dangerouslyDisableDeviceAuth bypass must NOT extend to node-role
    // Sessions — the break-glass flag is scoped to operator Control UI only.
    // A device-less node-role connection must still be rejected even when the flag
    // Is set, to prevent the flag from being abused to admit unauthorized node
    // Registrations.
    expect(
      evaluateMissingDeviceIdentity({
        authOk: false,
        controlUiAuthPolicy: bypass,
        hasDeviceIdentity: false,
        hasSharedAuth: false,
        isControlUi: true,
        isLocalClient: false,
        role: "node",
        sharedAuthOk: false,
        trustedProxyAuthOk: false,
      }).kind,
    ).toBe("reject-device-required");
  });

  test("dangerouslyDisableDeviceAuth skips pairing for operator control-ui only", () => {
    const bypass = resolveControlUiAuthPolicy({
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: null,
      isControlUi: true,
    });
    const strict = resolveControlUiAuthPolicy({
      controlUiConfig: undefined,
      deviceRaw: null,
      isControlUi: true,
    });
    expect(shouldSkipControlUiPairing(bypass, "operator", false)).toBe(true);
    expect(shouldSkipControlUiPairing(bypass, "node", false)).toBe(false);
    expect(shouldSkipControlUiPairing(strict, "operator", false)).toBe(false);
    expect(shouldSkipControlUiPairing(strict, "operator", true)).toBe(true);
  });

  test("auth.mode=none skips pairing for operator control-ui only", () => {
    const controlUi = resolveControlUiAuthPolicy({
      controlUiConfig: undefined,
      deviceRaw: null,
      isControlUi: true,
    });
    const nonControlUi = resolveControlUiAuthPolicy({
      controlUiConfig: undefined,
      deviceRaw: null,
      isControlUi: false,
    });
    // Control UI + operator + auth.mode=none: skip pairing (the fix for #42931)
    expect(shouldSkipControlUiPairing(controlUi, "operator", false, "none")).toBe(true);
    // Control UI + node role + auth.mode=none: still require pairing
    expect(shouldSkipControlUiPairing(controlUi, "node", false, "none")).toBe(false);
    // Non-Control-UI + operator + auth.mode=none: still require pairing
    // (prevents #43478 regression where ALL clients bypassed pairing)
    expect(shouldSkipControlUiPairing(nonControlUi, "operator", false, "none")).toBe(false);
    // Control UI + operator + auth.mode=shared-key: no change
    expect(shouldSkipControlUiPairing(controlUi, "operator", false, "shared-key")).toBe(false);
    // Control UI + operator + no authMode: no change
    expect(shouldSkipControlUiPairing(controlUi, "operator", false)).toBe(false);
  });

  test("trusted-proxy control-ui bypass only applies to operator + trusted-proxy auth", () => {
    const cases: {
      role: "operator" | "node";
      authMode: string;
      authOk: boolean;
      authMethod: string | undefined;
      expected: boolean;
    }[] = [
      {
        authMethod: "trusted-proxy",
        authMode: "trusted-proxy",
        authOk: true,
        expected: true,
        role: "operator",
      },
      {
        authMethod: "trusted-proxy",
        authMode: "trusted-proxy",
        authOk: true,
        expected: false,
        role: "node",
      },
      {
        authMethod: "token",
        authMode: "token",
        authOk: true,
        expected: false,
        role: "operator",
      },
      {
        authMethod: "trusted-proxy",
        authMode: "trusted-proxy",
        authOk: false,
        expected: false,
        role: "operator",
      },
    ];

    for (const tc of cases) {
      expect(
        isTrustedProxyControlUiOperatorAuth({
          authMethod: tc.authMethod,
          authMode: tc.authMode,
          authOk: tc.authOk,
          isControlUi: true,
          role: tc.role,
        }),
      ).toBe(tc.expected);
    }
  });

  test("clears unbound scopes for device-less shared auth outside explicit preservation cases", () => {
    const nonControlUi = resolveControlUiAuthPolicy({
      controlUiConfig: undefined,
      deviceRaw: null,
      isControlUi: false,
    });
    const controlUi = resolveControlUiAuthPolicy({
      controlUiConfig: { allowInsecureAuth: true },
      deviceRaw: null,
      isControlUi: true,
    });

    expect(
      shouldClearUnboundScopesForMissingDeviceIdentity({
        authMethod: "token",
        controlUiAuthPolicy: nonControlUi,
        decision: { kind: "allow" },
        preserveInsecureLocalControlUiScopes: false,
      }),
    ).toBe(true);

    expect(
      shouldClearUnboundScopesForMissingDeviceIdentity({
        authMethod: "password",
        controlUiAuthPolicy: nonControlUi,
        decision: { kind: "allow" },
        preserveInsecureLocalControlUiScopes: false,
      }),
    ).toBe(true);

    expect(
      shouldClearUnboundScopesForMissingDeviceIdentity({
        authMethod: "trusted-proxy",
        controlUiAuthPolicy: nonControlUi,
        decision: { kind: "allow" },
        preserveInsecureLocalControlUiScopes: false,
      }),
    ).toBe(true);

    expect(
      shouldClearUnboundScopesForMissingDeviceIdentity({
        authMethod: undefined,
        controlUiAuthPolicy: nonControlUi,
        decision: { kind: "allow" },
        preserveInsecureLocalControlUiScopes: false,
        trustedProxyAuthOk: true,
      }),
    ).toBe(true);

    expect(
      shouldClearUnboundScopesForMissingDeviceIdentity({
        authMethod: "token",
        controlUiAuthPolicy: controlUi,
        decision: { kind: "allow" },
        preserveInsecureLocalControlUiScopes: true,
      }),
    ).toBe(false);

    expect(
      shouldClearUnboundScopesForMissingDeviceIdentity({
        authMethod: undefined,
        controlUiAuthPolicy: nonControlUi,
        decision: { kind: "reject-device-required" },
        preserveInsecureLocalControlUiScopes: false,
      }),
    ).toBe(true);
  });
});
