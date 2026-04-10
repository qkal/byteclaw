import { beforeEach, describe, expect, it } from "vitest";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resetMissingProviderGroupPolicyFallbackWarningsForTesting,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "./runtime-group-policy.js";

beforeEach(() => {
  resetMissingProviderGroupPolicyFallbackWarningsForTesting();
});

describe("resolveRuntimeGroupPolicy", () => {
  it.each([
    {
      expectedFallbackApplied: true,
      expectedPolicy: "allowlist",
      params: { providerConfigPresent: false },
      title: "fails closed when provider config is missing and no defaults are set",
    },
    {
      expectedFallbackApplied: false,
      expectedPolicy: "open",
      params: { configuredFallbackPolicy: "open" as const, providerConfigPresent: true },
      title: "keeps configured fallback when provider config is present",
    },
    {
      expectedFallbackApplied: true,
      expectedPolicy: "allowlist",
      params: {
        configuredFallbackPolicy: "open" as const,
        defaultGroupPolicy: "disabled" as const,
        missingProviderFallbackPolicy: "allowlist" as const,
        providerConfigPresent: false,
      },
      title: "ignores global defaults when provider config is missing",
    },
  ])("$title", ({ params, expectedPolicy, expectedFallbackApplied }) => {
    const resolved = resolveRuntimeGroupPolicy(params);
    expect(resolved.groupPolicy).toBe(expectedPolicy);
    expect(resolved.providerMissingFallbackApplied).toBe(expectedFallbackApplied);
  });
});

describe("resolveOpenProviderRuntimeGroupPolicy", () => {
  it("uses open fallback when provider config exists", () => {
    const resolved = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });
});

describe("resolveAllowlistProviderRuntimeGroupPolicy", () => {
  it("uses allowlist fallback when provider config exists", () => {
    const resolved = resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });
});

describe("resolveDefaultGroupPolicy", () => {
  it("returns channels.defaults.groupPolicy when present", () => {
    const resolved = resolveDefaultGroupPolicy({
      channels: { defaults: { groupPolicy: "disabled" } },
    });
    expect(resolved).toBe("disabled");
  });
});

describe("warnMissingProviderGroupPolicyFallbackOnce", () => {
  it("logs only once per provider/account key", () => {
    const lines: string[] = [];
    const first = warnMissingProviderGroupPolicyFallbackOnce({
      accountId: "account-a",
      blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
      log: (message) => lines.push(message),
      providerKey: "runtime-policy-test",
      providerMissingFallbackApplied: true,
    });
    const second = warnMissingProviderGroupPolicyFallbackOnce({
      accountId: "account-a",
      blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
      log: (message) => lines.push(message),
      providerKey: "runtime-policy-test",
      providerMissingFallbackApplied: true,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("channels.runtime-policy-test is missing");
    expect(lines[0]).toContain("room messages blocked");
  });
});
