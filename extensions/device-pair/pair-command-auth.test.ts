import { describe, expect, it } from "vitest";
import { resolvePairingCommandAuthState } from "./pair-command-auth.js";

describe("device-pair pairing command auth", () => {
  it("treats non-gateway channels as external approvals", () => {
    expect(
      resolvePairingCommandAuthState({
        channel: "telegram",
        gatewayClientScopes: undefined,
      }),
    ).toEqual({
      approvalCallerScopes: undefined,
      isInternalGatewayCaller: false,
      isMissingInternalPairingPrivilege: false,
    });
  });

  it("fails closed for webchat when scopes are absent", () => {
    expect(
      resolvePairingCommandAuthState({
        channel: "webchat",
        gatewayClientScopes: undefined,
      }),
    ).toEqual({
      approvalCallerScopes: [],
      isInternalGatewayCaller: true,
      isMissingInternalPairingPrivilege: true,
    });
  });

  it("accepts pairing and admin scopes for internal callers", () => {
    expect(
      resolvePairingCommandAuthState({
        channel: "webchat",
        gatewayClientScopes: ["operator.write", "operator.pairing"],
      }),
    ).toEqual({
      approvalCallerScopes: ["operator.write", "operator.pairing"],
      isInternalGatewayCaller: true,
      isMissingInternalPairingPrivilege: false,
    });
    expect(
      resolvePairingCommandAuthState({
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      }),
    ).toEqual({
      approvalCallerScopes: ["operator.admin"],
      isInternalGatewayCaller: true,
      isMissingInternalPairingPrivilege: false,
    });
  });
});
