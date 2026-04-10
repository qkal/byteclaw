import { describe, expect, it } from "vitest";
import { resolveChannelConfigWrites } from "../config-writes.js";

const demoOriginChannelId = "demo-origin";
const demoTargetChannelId = "demo-target";

function makeDemoConfigWritesCfg(accountIdKey: string) {
  return {
    channels: {
      [demoOriginChannelId]: {
        accounts: {
          [accountIdKey]: { configWrites: false },
        },
        configWrites: true,
      },
      [demoTargetChannelId]: {
        accounts: {
          [accountIdKey]: { configWrites: false },
        },
        configWrites: true,
      },
    },
  };
}

describe("resolveChannelConfigWrites", () => {
  function expectResolvedChannelConfigWrites(params: {
    cfg: Record<string, unknown>;
    channelId: string;
    accountId?: string;
    expected: boolean;
  }) {
    expect(
      resolveChannelConfigWrites({
        cfg: params.cfg,
        channelId: params.channelId,
        ...(params.accountId ? { accountId: params.accountId } : {}),
      }),
    ).toBe(params.expected);
  }

  it.each([
    {
      cfg: {},
      channelId: demoOriginChannelId,
      expected: true,
      name: "defaults to allow when unset",
    },
    {
      cfg: { channels: { [demoOriginChannelId]: { configWrites: false } } },
      channelId: demoOriginChannelId,
      expected: false,
      name: "blocks when channel config disables writes",
    },
    {
      accountId: "work",
      cfg: makeDemoConfigWritesCfg("work"),
      channelId: demoOriginChannelId,
      expected: false,
      name: "account override wins over channel default",
    },
    {
      accountId: "work",
      cfg: makeDemoConfigWritesCfg("Work"),
      channelId: demoOriginChannelId,
      expected: false,
      name: "matches account ids case-insensitively",
    },
  ] as const)("$name", (testCase) => {
    expectResolvedChannelConfigWrites(testCase);
  });
});
