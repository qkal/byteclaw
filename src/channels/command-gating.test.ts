import { describe, expect, it } from "vitest";
import {
  resolveCommandAuthorizedFromAuthorizers,
  resolveControlCommandGate,
  resolveDualTextControlCommandGate,
} from "./command-gating.js";

describe("resolveCommandAuthorizedFromAuthorizers", () => {
  it("denies when useAccessGroups is enabled and no authorizer is configured", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        authorizers: [{ allowed: true, configured: false }],
        useAccessGroups: true,
      }),
    ).toBe(false);
  });

  it("allows when useAccessGroups is enabled and any configured authorizer allows", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        authorizers: [
          { allowed: false, configured: true },
          { allowed: true, configured: true },
        ],
        useAccessGroups: true,
      }),
    ).toBe(true);
  });

  it("allows when useAccessGroups is disabled (default)", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        authorizers: [{ allowed: false, configured: true }],
        useAccessGroups: false,
      }),
    ).toBe(true);
  });

  it("honors modeWhenAccessGroupsOff=deny", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        authorizers: [{ allowed: true, configured: false }],
        modeWhenAccessGroupsOff: "deny",
        useAccessGroups: false,
      }),
    ).toBe(false);
  });

  it("honors modeWhenAccessGroupsOff=configured (allow when none configured)", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        authorizers: [{ allowed: false, configured: false }],
        modeWhenAccessGroupsOff: "configured",
        useAccessGroups: false,
      }),
    ).toBe(true);
  });

  it("honors modeWhenAccessGroupsOff=configured (enforce when configured)", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        authorizers: [{ allowed: false, configured: true }],
        modeWhenAccessGroupsOff: "configured",
        useAccessGroups: false,
      }),
    ).toBe(false);
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        authorizers: [{ allowed: true, configured: true }],
        modeWhenAccessGroupsOff: "configured",
        useAccessGroups: false,
      }),
    ).toBe(true);
  });
});

describe("resolveControlCommandGate", () => {
  it("blocks control commands when unauthorized", () => {
    const result = resolveControlCommandGate({
      allowTextCommands: true,
      authorizers: [{ allowed: false, configured: true }],
      hasControlCommand: true,
      useAccessGroups: true,
    });
    expect(result.commandAuthorized).toBe(false);
    expect(result.shouldBlock).toBe(true);
  });

  it("does not block when control commands are disabled", () => {
    const result = resolveControlCommandGate({
      allowTextCommands: false,
      authorizers: [{ allowed: false, configured: true }],
      hasControlCommand: true,
      useAccessGroups: true,
    });
    expect(result.shouldBlock).toBe(false);
  });

  it("supports the dual-authorizer text gate helper", () => {
    const result = resolveDualTextControlCommandGate({
      hasControlCommand: true,
      primaryAllowed: false,
      primaryConfigured: true,
      secondaryAllowed: true,
      secondaryConfigured: true,
      useAccessGroups: true,
    });
    expect(result.commandAuthorized).toBe(true);
    expect(result.shouldBlock).toBe(false);
  });
});
