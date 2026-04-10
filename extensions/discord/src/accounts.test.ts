import { describe, expect, it } from "vitest";
import {
  createDiscordActionGate,
  resolveDiscordAccount,
  resolveDiscordMaxLinesPerMessage,
} from "./accounts.js";

describe("resolveDiscordAccount allowFrom precedence", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            accounts: {
              work: { name: "Work", token: "token-work" },
            },
            defaultAccount: "work",
          },
        },
      },
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.token).toBe("token-work");
  });

  it("prefers accounts.default.allowFrom over top-level for default account", () => {
    const resolved = resolveDiscordAccount({
      accountId: "default",
      cfg: {
        channels: {
          discord: {
            accounts: {
              default: { allowFrom: ["default"], token: "token-default" },
            },
            allowFrom: ["top"],
          },
        },
      },
    });

    expect(resolved.config.allowFrom).toEqual(["default"]);
  });

  it("falls back to top-level allowFrom for named account without override", () => {
    const resolved = resolveDiscordAccount({
      accountId: "work",
      cfg: {
        channels: {
          discord: {
            accounts: {
              work: { token: "token-work" },
            },
            allowFrom: ["top"],
          },
        },
      },
    });

    expect(resolved.config.allowFrom).toEqual(["top"]);
  });

  it("does not inherit default account allowFrom for named account when top-level is absent", () => {
    const resolved = resolveDiscordAccount({
      accountId: "work",
      cfg: {
        channels: {
          discord: {
            accounts: {
              default: { allowFrom: ["default"], token: "token-default" },
              work: { token: "token-work" },
            },
          },
        },
      },
    });

    expect(resolved.config.allowFrom).toBeUndefined();
  });
});

describe("createDiscordActionGate", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const gate = createDiscordActionGate({
      cfg: {
        channels: {
          discord: {
            accounts: {
              work: {
                actions: { reactions: true },
                token: "token-work",
              },
            },
            actions: { reactions: false },
            defaultAccount: "work",
          },
        },
      },
    });

    expect(gate("reactions")).toBe(true);
  });
});

describe("resolveDiscordMaxLinesPerMessage", () => {
  it("falls back to merged root discord maxLinesPerMessage when runtime config omits it", () => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      accountId: "default",
      cfg: {
        channels: {
          discord: {
            accounts: {
              default: { token: "token-default" },
            },
            maxLinesPerMessage: 120,
          },
        },
      },
      discordConfig: {},
    });

    expect(resolved).toBe(120);
  });

  it("prefers explicit runtime discord maxLinesPerMessage over merged config", () => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      accountId: "default",
      cfg: {
        channels: {
          discord: {
            accounts: {
              default: { maxLinesPerMessage: 80, token: "token-default" },
            },
            maxLinesPerMessage: 120,
          },
        },
      },
      discordConfig: { maxLinesPerMessage: 55 },
    });

    expect(resolved).toBe(55);
  });

  it("uses per-account discord maxLinesPerMessage over the root value when runtime config omits it", () => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      accountId: "work",
      cfg: {
        channels: {
          discord: {
            accounts: {
              work: { maxLinesPerMessage: 80, token: "token-work" },
            },
            maxLinesPerMessage: 120,
          },
        },
      },
      discordConfig: {},
    });

    expect(resolved).toBe(80);
  });
});
