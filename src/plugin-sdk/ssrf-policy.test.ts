import { describe, expect, it, vi } from "vitest";
import type { LookupFn } from "../infra/net/ssrf.js";
import {
  assertHttpUrlTargetsPrivateNetwork,
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  hasLegacyFlatAllowPrivateNetworkAlias,
  isHttpsUrlAllowedByHostnameSuffixAllowlist,
  isPrivateNetworkOptInEnabled,
  migrateLegacyFlatAllowPrivateNetworkAlias,
  normalizeHostnameSuffixAllowlist,
  ssrfPolicyFromAllowPrivateNetwork,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
  ssrfPolicyFromPrivateNetworkOptIn,
} from "./ssrf-policy.js";

function createLookupFn(addresses: { address: string; family: number }[]): LookupFn {
  return vi.fn(async (_hostname: string, options?: unknown) => {
    if (typeof options === "number" || !options || !(options as { all?: boolean }).all) {
      return addresses[0];
    }
    return addresses;
  }) as unknown as LookupFn;
}

describe("ssrfPolicyFromDangerouslyAllowPrivateNetwork", () => {
  it.each([
    {
      expected: undefined,
      input: undefined,
      name: "returns undefined for missing input",
    },
    {
      expected: undefined,
      input: false,
      name: "returns undefined when private-network access is disabled",
    },
    {
      expected: { allowPrivateNetwork: true },
      input: true,
      name: "returns an explicit allow-private-network policy when enabled",
    },
  ])("$name", ({ input, expected }) => {
    expect(ssrfPolicyFromDangerouslyAllowPrivateNetwork(input)).toEqual(expected);
  });
});

describe("ssrfPolicyFromAllowPrivateNetwork", () => {
  it.each([
    {
      expected: undefined,
      input: undefined,
      name: "returns undefined for missing input",
    },
    {
      expected: undefined,
      input: false,
      name: "returns undefined when private-network access is disabled",
    },
    {
      expected: { allowPrivateNetwork: true },
      input: true,
      name: "returns an explicit allow-private-network policy when enabled",
    },
  ])("$name", ({ input, expected }) => {
    expect(ssrfPolicyFromAllowPrivateNetwork(input)).toEqual(expected);
  });
});

describe("isPrivateNetworkOptInEnabled", () => {
  it.each([
    {
      expected: false,
      input: undefined,
      name: "returns false for missing input",
    },
    {
      expected: false,
      input: false,
      name: "returns false for explicit false",
    },
    {
      expected: true,
      input: true,
      name: "returns true for explicit boolean true",
    },
    {
      expected: true,
      input: { allowPrivateNetwork: true },
      name: "returns true for flat allowPrivateNetwork config",
    },
    {
      expected: true,
      input: { dangerouslyAllowPrivateNetwork: true },
      name: "returns true for flat dangerous opt-in config",
    },
    {
      expected: true,
      input: { network: { dangerouslyAllowPrivateNetwork: true } },
      name: "returns true for nested network dangerous opt-in config",
    },
    {
      expected: false,
      input: { network: { dangerouslyAllowPrivateNetwork: false } },
      name: "returns false for nested false values",
    },
  ])("$name", ({ input, expected }) => {
    expect(isPrivateNetworkOptInEnabled(input)).toBe(expected);
  });
});

describe("ssrfPolicyFromPrivateNetworkOptIn", () => {
  it.each([
    {
      expected: undefined,
      input: undefined,
      name: "returns undefined for unset input",
    },
    {
      expected: undefined,
      input: { allowPrivateNetwork: false },
      name: "returns undefined for explicit false input",
    },
    {
      expected: { allowPrivateNetwork: true },
      input: { network: { dangerouslyAllowPrivateNetwork: true } },
      name: "returns the compat policy for nested dangerous input",
    },
  ])("$name", ({ input, expected }) => {
    expect(ssrfPolicyFromPrivateNetworkOptIn(input)).toEqual(expected);
  });
});

describe("legacy private-network alias helpers", () => {
  it("detects the flat allowPrivateNetwork alias", () => {
    expect(hasLegacyFlatAllowPrivateNetworkAlias({ allowPrivateNetwork: true })).toBe(true);
    expect(hasLegacyFlatAllowPrivateNetworkAlias({ network: {} })).toBe(false);
  });

  it("migrates the flat alias into network.dangerouslyAllowPrivateNetwork", () => {
    const changes: string[] = [];
    const migrated = migrateLegacyFlatAllowPrivateNetworkAlias({
      changes,
      entry: { allowPrivateNetwork: true },
      pathPrefix: "channels.matrix",
    });

    expect(migrated.entry).toEqual({
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
    expect(changes).toEqual([
      "Moved channels.matrix.allowPrivateNetwork → channels.matrix.network.dangerouslyAllowPrivateNetwork (true).",
    ]);
  });

  it("prefers the canonical network key when both old and new keys are present", () => {
    const changes: string[] = [];
    const migrated = migrateLegacyFlatAllowPrivateNetworkAlias({
      changes,
      entry: {
        allowPrivateNetwork: true,
        network: {
          dangerouslyAllowPrivateNetwork: false,
        },
      },
      pathPrefix: "channels.matrix.accounts.default",
    });

    expect(migrated.entry).toEqual({
      network: {
        dangerouslyAllowPrivateNetwork: false,
      },
    });
    expect(changes[0]).toContain("(false)");
  });

  it("keeps an explicit canonical true when the legacy key is false", () => {
    const changes: string[] = [];
    const migrated = migrateLegacyFlatAllowPrivateNetworkAlias({
      changes,
      entry: {
        allowPrivateNetwork: false,
        network: {
          dangerouslyAllowPrivateNetwork: true,
        },
      },
      pathPrefix: "channels.matrix.accounts.default",
    });

    expect(migrated.entry).toEqual({
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
    expect(changes[0]).toContain("(true)");
  });
});

describe("assertHttpUrlTargetsPrivateNetwork", () => {
  it.each([
    {
      name: "allows https targets without private-network checks",
      outcome: "resolve",
      policy: {
        dangerouslyAllowPrivateNetwork: false,
      },
      url: "https://matrix.example.org",
    },
    {
      name: "allows internal DNS names only when they resolve exclusively to private IPs",
      outcome: "resolve",
      policy: {
        dangerouslyAllowPrivateNetwork: true,
        lookupFn: createLookupFn([{ address: "10.0.0.5", family: 4 }]),
      },
      url: "http://matrix-synapse:8008",
    },
    {
      expectedError:
        "Matrix homeserver must use https:// unless it targets a private or loopback host",
      name: "rejects cleartext public hosts even when private-network access is enabled",
      outcome: "reject",
      policy: {
        dangerouslyAllowPrivateNetwork: true,
        errorMessage:
          "Matrix homeserver must use https:// unless it targets a private or loopback host",
        lookupFn: createLookupFn([{ address: "93.184.216.34", family: 4 }]),
      },
      url: "http://matrix.example.org:8008",
    },
  ])("$name", async ({ url, policy, outcome, expectedError }) => {
    const result = assertHttpUrlTargetsPrivateNetwork(url, policy);
    if (outcome === "reject") {
      await expect(result).rejects.toThrow(expectedError);
      return;
    }
    await expect(result).resolves.toBeUndefined();
  });

  it("prefers the canonical flag when both canonical and legacy flags are present", async () => {
    await expect(
      assertHttpUrlTargetsPrivateNetwork("http://matrix-synapse:8008", {
        allowPrivateNetwork: true,
        dangerouslyAllowPrivateNetwork: false,
        lookupFn: createLookupFn([{ address: "10.0.0.5", family: 4 }]),
      }),
    ).rejects.toThrow("HTTP URL must target a trusted private/internal host");
  });
});

describe("normalizeHostnameSuffixAllowlist", () => {
  it.each([
    {
      defaults: ["GRAPH.MICROSOFT.COM"],
      expected: ["graph.microsoft.com"],
      input: undefined,
      name: "uses defaults when input is missing",
    },
    {
      defaults: undefined,
      expected: ["*"],
      input: ["*.TrafficManager.NET", ".trafficmanager.net.", " * ", "x"],
      name: "normalizes wildcard prefixes and deduplicates",
    },
  ])("$name", ({ input, defaults, expected }) => {
    expect(normalizeHostnameSuffixAllowlist(input, defaults)).toEqual(expected);
  });
});

describe("isHttpsUrlAllowedByHostnameSuffixAllowlist", () => {
  it.each([
    {
      allowlist: ["example.com"],
      expected: false,
      name: "requires https",
      url: "http://a.example.com/x",
    },
    {
      allowlist: ["example.com"],
      expected: true,
      name: "supports exact match",
      url: "https://example.com/x",
    },
    {
      allowlist: ["example.com"],
      expected: true,
      name: "supports suffix match",
      url: "https://a.example.com/x",
    },
    {
      allowlist: ["example.com"],
      expected: false,
      name: "rejects non-matching hosts",
      url: "https://evil.com/x",
    },
    {
      allowlist: ["*"],
      expected: true,
      name: "supports wildcard allowlist",
      url: "https://evil.com/x",
    },
  ])("$name", ({ url, allowlist, expected }) => {
    expect(isHttpsUrlAllowedByHostnameSuffixAllowlist(url, allowlist)).toBe(expected);
  });
});

describe("buildHostnameAllowlistPolicyFromSuffixAllowlist", () => {
  it.each([
    {
      expected: undefined,
      input: undefined,
      name: "returns undefined when allowHosts is empty",
    },
    {
      expected: undefined,
      input: [],
      name: "returns undefined for an explicit empty list",
    },
    {
      expected: undefined,
      input: ["*"],
      name: "returns undefined when wildcard host is present",
    },
    {
      expected: undefined,
      input: ["example.com", "*"],
      name: "returns undefined when wildcard is mixed with concrete hosts",
    },
    {
      expected: {
        hostnameAllowlist: ["sharepoint.com", "*.sharepoint.com"],
      },
      input: ["sharepoint.com"],
      name: "expands a suffix entry to exact + wildcard hostname allowlist patterns",
    },
    {
      expected: {
        hostnameAllowlist: [
          "trafficmanager.net",
          "*.trafficmanager.net",
          "blob.core.windows.net",
          "*.blob.core.windows.net",
        ],
      },
      input: ["*.TrafficManager.NET", ".trafficmanager.net.", " blob.core.windows.net "],
      name: "normalizes wildcard prefixes, leading/trailing dots, and deduplicates patterns",
    },
  ])("$name", ({ input, expected }) => {
    expect(buildHostnameAllowlistPolicyFromSuffixAllowlist(input)).toEqual(expected);
  });
});
