import { describe, expect, it } from "vitest";
import { resolveSlackAccount } from "./accounts.js";

describe("resolveSlackAccount allowFrom precedence", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            accounts: {
              work: {
                appToken: "xapp-work",
                botToken: "xoxb-work",
                name: "Work",
              },
            },
            defaultAccount: "work",
          },
        },
      },
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.botToken).toBe("xoxb-work");
    expect(resolved.appToken).toBe("xapp-work");
  });

  it("prefers accounts.default.allowFrom over top-level for default account", () => {
    const resolved = resolveSlackAccount({
      accountId: "default",
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: {
                allowFrom: ["default"],
                appToken: "xapp-default",
                botToken: "xoxb-default",
              },
            },
            allowFrom: ["top"],
          },
        },
      },
    });

    expect(resolved.config.allowFrom).toEqual(["default"]);
  });

  it("falls back to top-level allowFrom for named account without override", () => {
    const resolved = resolveSlackAccount({
      accountId: "work",
      cfg: {
        channels: {
          slack: {
            accounts: {
              work: { appToken: "xapp-work", botToken: "xoxb-work" },
            },
            allowFrom: ["top"],
          },
        },
      },
    });

    expect(resolved.config.allowFrom).toEqual(["top"]);
  });

  it("does not inherit default account allowFrom for named account when top-level is absent", () => {
    const resolved = resolveSlackAccount({
      accountId: "work",
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: {
                allowFrom: ["default"],
                appToken: "xapp-default",
                botToken: "xoxb-default",
              },
              work: { appToken: "xapp-work", botToken: "xoxb-work" },
            },
          },
        },
      },
    });

    expect(resolved.config.allowFrom).toBeUndefined();
  });

  it("falls back to top-level dm.allowFrom when allowFrom alias is unset", () => {
    const resolved = resolveSlackAccount({
      accountId: "work",
      cfg: {
        channels: {
          slack: {
            accounts: {
              work: { appToken: "xapp-work", botToken: "xoxb-work" },
            },
            dm: { allowFrom: ["U123"] },
          },
        },
      },
    });

    expect(resolved.config.allowFrom).toBeUndefined();
    expect(resolved.config.dm?.allowFrom).toEqual(["U123"]);
  });
});
