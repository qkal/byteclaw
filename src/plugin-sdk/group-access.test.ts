import { describe, expect, it } from "vitest";
import {
  evaluateGroupRouteAccessForPolicy,
  evaluateMatchedGroupAccessForPolicy,
  evaluateSenderGroupAccess,
  evaluateSenderGroupAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "./group-access.js";

describe("resolveSenderScopedGroupPolicy", () => {
  const cases: {
    name: string;
    input: Parameters<typeof resolveSenderScopedGroupPolicy>[0];
    expected: ReturnType<typeof resolveSenderScopedGroupPolicy>;
  }[] = [
    {
      expected: "disabled",
      input: {
        groupAllowFrom: ["a"],
        groupPolicy: "disabled",
      },
      name: "preserves disabled policy",
    },
    {
      expected: "allowlist",
      input: {
        groupAllowFrom: ["a"],
        groupPolicy: "allowlist",
      },
      name: "keeps allowlist policy when sender allowlist is present",
    },
    {
      expected: "open",
      input: {
        groupAllowFrom: [],
        groupPolicy: "allowlist",
      },
      name: "maps allowlist to open when sender allowlist is empty",
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(resolveSenderScopedGroupPolicy(input)).toBe(expected);
  });
});

describe("evaluateSenderGroupAccessForPolicy", () => {
  const cases: {
    name: string;
    input: Parameters<typeof evaluateSenderGroupAccessForPolicy>[0];
    expected: Partial<ReturnType<typeof evaluateSenderGroupAccessForPolicy>>;
  }[] = [
    {
      expected: { allowed: false, groupPolicy: "disabled", reason: "disabled" },
      input: {
        groupAllowFrom: ["123"],
        groupPolicy: "disabled",
        isSenderAllowed: () => true,
        senderId: "123",
      },
      name: "blocks disabled policy",
    },
    {
      expected: {
        allowed: false,
        groupPolicy: "allowlist",
        reason: "empty_allowlist",
      },
      input: {
        groupAllowFrom: [],
        groupPolicy: "allowlist",
        isSenderAllowed: () => true,
        senderId: "123",
      },
      name: "blocks allowlist with empty list",
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(evaluateSenderGroupAccessForPolicy(input)).toMatchObject(expected);
  });
});

describe("evaluateGroupRouteAccessForPolicy", () => {
  const cases: {
    name: string;
    input: Parameters<typeof evaluateGroupRouteAccessForPolicy>[0];
    expected: ReturnType<typeof evaluateGroupRouteAccessForPolicy>;
  }[] = [
    {
      expected: {
        allowed: false,
        groupPolicy: "disabled",
        reason: "disabled",
      },
      input: {
        groupPolicy: "disabled",
        routeAllowlistConfigured: true,
        routeEnabled: true,
        routeMatched: true,
      },
      name: "blocks disabled policy",
    },
    {
      expected: {
        allowed: false,
        groupPolicy: "allowlist",
        reason: "empty_allowlist",
      },
      input: {
        groupPolicy: "allowlist",
        routeAllowlistConfigured: false,
        routeMatched: false,
      },
      name: "blocks allowlist without configured routes",
    },
    {
      expected: {
        allowed: false,
        groupPolicy: "allowlist",
        reason: "route_not_allowlisted",
      },
      input: {
        groupPolicy: "allowlist",
        routeAllowlistConfigured: true,
        routeMatched: false,
      },
      name: "blocks unmatched allowlist route",
    },
    {
      expected: {
        allowed: false,
        groupPolicy: "open",
        reason: "route_disabled",
      },
      input: {
        groupPolicy: "open",
        routeAllowlistConfigured: true,
        routeEnabled: false,
        routeMatched: true,
      },
      name: "blocks disabled matched route even when group policy is open",
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(evaluateGroupRouteAccessForPolicy(input)).toEqual(expected);
  });
});

describe("evaluateMatchedGroupAccessForPolicy", () => {
  const cases: {
    name: string;
    input: Parameters<typeof evaluateMatchedGroupAccessForPolicy>[0];
    expected: ReturnType<typeof evaluateMatchedGroupAccessForPolicy>;
  }[] = [
    {
      expected: {
        allowed: false,
        groupPolicy: "disabled",
        reason: "disabled",
      },
      input: {
        allowlistConfigured: true,
        allowlistMatched: true,
        groupPolicy: "disabled",
      },
      name: "blocks disabled policy",
    },
    {
      expected: {
        allowed: false,
        groupPolicy: "allowlist",
        reason: "empty_allowlist",
      },
      input: {
        allowlistConfigured: false,
        allowlistMatched: false,
        groupPolicy: "allowlist",
      },
      name: "blocks allowlist without configured entries",
    },
    {
      expected: {
        allowed: false,
        groupPolicy: "allowlist",
        reason: "missing_match_input",
      },
      input: {
        allowlistConfigured: true,
        allowlistMatched: false,
        groupPolicy: "allowlist",
        hasMatchInput: false,
        requireMatchInput: true,
      },
      name: "blocks allowlist when required match input is missing",
    },
    {
      expected: {
        allowed: false,
        groupPolicy: "allowlist",
        reason: "not_allowlisted",
      },
      input: {
        allowlistConfigured: true,
        allowlistMatched: false,
        groupPolicy: "allowlist",
      },
      name: "blocks unmatched allowlist sender",
    },
    {
      expected: {
        allowed: true,
        groupPolicy: "open",
        reason: "allowed",
      },
      input: {
        allowlistConfigured: false,
        allowlistMatched: false,
        groupPolicy: "open",
      },
      name: "allows open policy",
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(evaluateMatchedGroupAccessForPolicy(input)).toEqual(expected);
  });
});

describe("evaluateSenderGroupAccess", () => {
  const cases: {
    name: string;
    input: Parameters<typeof evaluateSenderGroupAccess>[0];
    expected: Partial<ReturnType<typeof evaluateSenderGroupAccess>>;
    matcher: "equal" | "match";
  }[] = [
    {
      expected: {
        allowed: true,
        groupPolicy: "allowlist",
        providerMissingFallbackApplied: true,
        reason: "allowed",
      },
      input: {
        configuredGroupPolicy: undefined,
        defaultGroupPolicy: "open",
        groupAllowFrom: ["123"],
        isSenderAllowed: () => true,
        providerConfigPresent: false,
        senderId: "123",
      },
      matcher: "equal",
      name: "defaults missing provider config to allowlist",
    },
    {
      expected: { allowed: false, groupPolicy: "disabled", reason: "disabled" },
      input: {
        configuredGroupPolicy: "disabled",
        defaultGroupPolicy: "open",
        groupAllowFrom: ["123"],
        isSenderAllowed: () => true,
        providerConfigPresent: true,
        senderId: "123",
      },
      matcher: "match",
      name: "blocks disabled policy",
    },
    {
      expected: {
        allowed: false,
        groupPolicy: "allowlist",
        reason: "empty_allowlist",
      },
      input: {
        configuredGroupPolicy: "allowlist",
        defaultGroupPolicy: "open",
        groupAllowFrom: [],
        isSenderAllowed: () => true,
        providerConfigPresent: true,
        senderId: "123",
      },
      matcher: "match",
      name: "blocks allowlist with empty list",
    },
    {
      expected: {
        allowed: false,
        groupPolicy: "allowlist",
        reason: "sender_not_allowlisted",
      },
      input: {
        configuredGroupPolicy: "allowlist",
        defaultGroupPolicy: "open",
        groupAllowFrom: ["123"],
        isSenderAllowed: () => false,
        providerConfigPresent: true,
        senderId: "999",
      },
      matcher: "match",
      name: "blocks sender not allowlisted",
    },
  ];

  it.each(cases)("$name", ({ input, expected, matcher }) => {
    const decision = evaluateSenderGroupAccess(input);
    if (matcher === "equal") {
      expect(decision).toEqual(expected);
      return;
    }
    expect(decision).toMatchObject(expected);
  });
});
