import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  isTruthyEnvValue: (value: string | undefined) =>
    typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim()),
  isWSL2Sync: vi.fn(() => false),
}));

let isWSL2Sync: typeof import("openclaw/plugin-sdk/runtime-env").isWSL2Sync;
let resetTelegramNetworkConfigStateForTests: typeof import("./network-config.js").resetTelegramNetworkConfigStateForTests;
let resolveTelegramAutoSelectFamilyDecision: typeof import("./network-config.js").resolveTelegramAutoSelectFamilyDecision;
let resolveTelegramDnsResultOrderDecision: typeof import("./network-config.js").resolveTelegramDnsResultOrderDecision;

async function loadModule() {
  ({ isWSL2Sync } = await import("openclaw/plugin-sdk/runtime-env"));
  ({
    resetTelegramNetworkConfigStateForTests,
    resolveTelegramAutoSelectFamilyDecision,
    resolveTelegramDnsResultOrderDecision,
  } = await import("./network-config.js"));
}

describe("resolveTelegramAutoSelectFamilyDecision", () => {
  beforeAll(async () => {
    await loadModule();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (!resetTelegramNetworkConfigStateForTests) {
      await loadModule();
    }
    resetTelegramNetworkConfigStateForTests();
  });

  it.each([
    {
      env: {
        OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY: "1",
        OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY: "1",
      },
      expected: {
        source: "env:OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY",
        value: true,
      },
      name: "prefers env enable over env disable",
    },
    {
      env: { OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY: "1" },
      expected: {
        source: "env:OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY",
        value: false,
      },
      name: "uses env disable when set",
    },
    {
      env: { OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY: "1" },
      expected: {
        source: "env:OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY",
        value: true,
      },
      name: "prefers env enable over config",
      network: { autoSelectFamily: false },
    },
    {
      env: { OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY: "1" },
      expected: {
        source: "env:OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY",
        value: false,
      },
      name: "prefers env disable over config",
      network: { autoSelectFamily: true },
    },
    {
      env: {},
      expected: { source: "config", value: true },
      name: "uses config override when provided",
      network: { autoSelectFamily: true },
    },
  ])("$name", ({ env, network, expected }) => {
    if (!resolveTelegramAutoSelectFamilyDecision) {
      throw new Error("network-config module not loaded");
    }
    const decision = resolveTelegramAutoSelectFamilyDecision({
      env,
      network,
      nodeMajor: 22,
    });
    expect(decision).toEqual(expected);
  });

  it("defaults to enable on Node 22", () => {
    const decision = resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 22 });
    expect(decision).toEqual({ source: "default-node22", value: true });
  });

  it("returns null when no decision applies", () => {
    const decision = resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 20 });
    expect(decision).toEqual({ value: null });
  });

  describe("WSL2 detection", () => {
    it.each([
      {
        env: {},
        expected: { source: "default-wsl2", value: false },
        name: "disables autoSelectFamily on WSL2",
      },
      {
        env: {},
        expected: { source: "config", value: true },
        name: "respects config override on WSL2",
        network: { autoSelectFamily: true },
      },
      {
        env: { OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY: "1" },
        expected: {
          source: "env:OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY",
          value: true,
        },
        name: "respects env override on WSL2",
      },
      {
        env: {},
        expected: { source: "default-node22", value: true },
        name: "uses Node 22 default when not on WSL2",
        wsl2: false,
      },
    ])("$name", ({ env, network, expected, wsl2 = true }) => {
      if (!isWSL2Sync) {
        throw new Error("runtime-env mock not loaded");
      }
      vi.mocked(isWSL2Sync).mockReturnValue(wsl2);
      const decision = resolveTelegramAutoSelectFamilyDecision({
        env,
        network,
        nodeMajor: 22,
      });
      expect(decision).toEqual(expected);
    });

    it("memoizes WSL2 detection across repeated defaults", () => {
      vi.mocked(isWSL2Sync).mockReturnValue(true);
      vi.mocked(isWSL2Sync).mockClear();
      vi.mocked(isWSL2Sync).mockReturnValue(false);
      resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 22 });
      resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 22 });
      expect(isWSL2Sync).toHaveBeenCalledTimes(1);
    });
  });
});

describe("resolveTelegramDnsResultOrderDecision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      env: { OPENCLAW_TELEGRAM_DNS_RESULT_ORDER: "verbatim" },
      expected: {
        source: "env:OPENCLAW_TELEGRAM_DNS_RESULT_ORDER",
        value: "verbatim",
      },
      name: "uses env override when provided",
      nodeMajor: 22,
    },
    {
      env: { OPENCLAW_TELEGRAM_DNS_RESULT_ORDER: "  IPV4FIRST  " },
      expected: {
        source: "env:OPENCLAW_TELEGRAM_DNS_RESULT_ORDER",
        value: "ipv4first",
      },
      name: "normalizes trimmed env values",
      nodeMajor: 20,
    },
    {
      expected: { source: "config", value: "ipv4first" },
      name: "uses config override when provided",
      network: { dnsResultOrder: "ipv4first" },
      nodeMajor: 20,
    },
    {
      expected: { source: "config", value: "verbatim" },
      name: "normalizes trimmed config values",
      network: { dnsResultOrder: "  Verbatim  " } as TelegramNetworkConfig & {
        dnsResultOrder: string;
      },
      nodeMajor: 20,
    },
    {
      env: { OPENCLAW_TELEGRAM_DNS_RESULT_ORDER: "bogus" },
      expected: { source: "config", value: "ipv4first" },
      name: "ignores invalid env values and falls back to config",
      network: { dnsResultOrder: "ipv4first" },
      nodeMajor: 20,
    },
    {
      env: { OPENCLAW_TELEGRAM_DNS_RESULT_ORDER: "bogus" },
      expected: { source: "default-node22", value: "ipv4first" },
      name: "ignores invalid env and config values before applying Node 22 default",
      network: { dnsResultOrder: "invalid" } as TelegramNetworkConfig & { dnsResultOrder: string },
      nodeMajor: 22,
    },
  ] satisfies {
    name: string;
    env?: NodeJS.ProcessEnv;
    network?: TelegramNetworkConfig | (TelegramNetworkConfig & { dnsResultOrder: string });
    nodeMajor: number;
    expected: ReturnType<typeof resolveTelegramDnsResultOrderDecision>;
  }[])("$name", ({ env, network, nodeMajor, expected }) => {
    const decision = resolveTelegramDnsResultOrderDecision({
      env,
      network,
      nodeMajor,
    });
    expect(decision).toEqual(expected);
  });

  it("defaults to ipv4first on Node 22", () => {
    const decision = resolveTelegramDnsResultOrderDecision({ nodeMajor: 22 });
    expect(decision).toEqual({ source: "default-node22", value: "ipv4first" });
  });

  it("returns null when no dns decision applies", () => {
    const decision = resolveTelegramDnsResultOrderDecision({ nodeMajor: 20 });
    expect(decision).toEqual({ value: null });
  });
});
