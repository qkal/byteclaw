import { describe, expect, it } from "vitest";
import {
  getAccountConfig,
  listAccountIds,
  resolveDefaultTwitchAccountId,
  resolveTwitchAccountContext,
} from "./config.js";

describe("getAccountConfig", () => {
  const mockMultiAccountConfig = {
    channels: {
      twitch: {
        accounts: {
          default: {
            accessToken: "oauth:test123",
            username: "testbot",
          },
          secondary: {
            accessToken: "oauth:secondary",
            username: "secondbot",
          },
        },
      },
    },
  };

  const mockSimplifiedConfig = {
    channels: {
      twitch: {
        accessToken: "oauth:test123",
        username: "testbot",
      },
    },
  };

  it("returns account config for valid account ID (multi-account)", () => {
    const result = getAccountConfig(mockMultiAccountConfig, "default");

    expect(result).not.toBeNull();
    expect(result?.username).toBe("testbot");
  });

  it("returns account config for default account (simplified config)", () => {
    const result = getAccountConfig(mockSimplifiedConfig, "default");

    expect(result).not.toBeNull();
    expect(result?.username).toBe("testbot");
  });

  it("returns non-default account from multi-account config", () => {
    const result = getAccountConfig(mockMultiAccountConfig, "secondary");

    expect(result).not.toBeNull();
    expect(result?.username).toBe("secondbot");
  });

  it("returns null for non-existent account ID", () => {
    const result = getAccountConfig(mockMultiAccountConfig, "nonexistent");

    expect(result).toBeNull();
  });

  it("returns null when core config is null", () => {
    const result = getAccountConfig(null, "default");

    expect(result).toBeNull();
  });

  it("returns null when core config is undefined", () => {
    const result = getAccountConfig(undefined, "default");

    expect(result).toBeNull();
  });

  it("returns null when channels are not defined", () => {
    const result = getAccountConfig({}, "default");

    expect(result).toBeNull();
  });

  it("returns null when twitch is not defined", () => {
    const result = getAccountConfig({ channels: {} }, "default");

    expect(result).toBeNull();
  });

  it("returns null when accounts are not defined", () => {
    const result = getAccountConfig({ channels: { twitch: {} } }, "default");

    expect(result).toBeNull();
  });
});

describe("listAccountIds", () => {
  it("includes the implicit default account from simplified config", () => {
    expect(
      listAccountIds({
        channels: {
          twitch: {
            accessToken: "oauth:test123",
            username: "testbot",
          },
        },
      } as Parameters<typeof listAccountIds>[0]),
    ).toEqual(["default"]);
  });

  it("combines explicit accounts with the implicit default account once", () => {
    expect(
      listAccountIds({
        channels: {
          twitch: {
            accounts: {
              default: { username: "testbot" },
              secondary: { username: "secondbot" },
            },
            username: "testbot",
          },
        },
      } as Parameters<typeof listAccountIds>[0]),
    ).toEqual(["default", "secondary"]);
  });
});

describe("resolveDefaultTwitchAccountId", () => {
  it("prefers channels.twitch.defaultAccount when configured", () => {
    expect(
      resolveDefaultTwitchAccountId({
        channels: {
          twitch: {
            accounts: {
              default: { username: "default" },
              secondary: { username: "secondary" },
            },
            defaultAccount: "secondary",
          },
        },
      } as Parameters<typeof resolveDefaultTwitchAccountId>[0]),
    ).toBe("secondary");
  });
});

describe("resolveTwitchAccountContext", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const context = resolveTwitchAccountContext({
      channels: {
        twitch: {
          accounts: {
            default: {
              accessToken: "oauth:default-token",
              username: "default-bot",
            },
            secondary: {
              accessToken: "oauth:second-token",
              username: "second-bot",
            },
          },
          defaultAccount: "secondary",
        },
      },
    } as Parameters<typeof resolveTwitchAccountContext>[0]);

    expect(context.accountId).toBe("secondary");
    expect(context.account?.username).toBe("second-bot");
  });
});
