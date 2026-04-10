import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import {
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
  resolveMattermostReplyToMode,
} from "./accounts.js";

describe("resolveDefaultMattermostAccountId", () => {
  it("prefers channels.mattermost.defaultAccount when it matches a configured account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          accounts: {
            alerts: { baseUrl: "https://alerts.example.com", botToken: "tok-alerts" },
            default: { baseUrl: "https://chat.example.com", botToken: "tok-default" },
          },
          defaultAccount: "alerts",
        },
      },
    };

    expect(resolveDefaultMattermostAccountId(cfg)).toBe("alerts");
  });

  it("normalizes channels.mattermost.defaultAccount before lookup", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          accounts: {
            "ops-team": { baseUrl: "https://chat.example.com", botToken: "tok-ops" },
          },
          defaultAccount: "Ops Team",
        },
      },
    };

    expect(resolveDefaultMattermostAccountId(cfg)).toBe("ops-team");
  });

  it("falls back when channels.mattermost.defaultAccount is missing", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          accounts: {
            alerts: { baseUrl: "https://alerts.example.com", botToken: "tok-alerts" },
            default: { baseUrl: "https://chat.example.com", botToken: "tok-default" },
          },
          defaultAccount: "missing",
        },
      },
    };

    expect(resolveDefaultMattermostAccountId(cfg)).toBe("default");
  });
});

describe("resolveMattermostReplyToMode", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          accounts: {
            alerts: {
              baseUrl: "https://alerts.example.com",
              botToken: "tok-alerts",
              replyToMode: "all",
            },
          },
          defaultAccount: "alerts",
        },
      },
    };

    const account = resolveMattermostAccount({ cfg });
    expect(account.accountId).toBe("alerts");
    expect(resolveMattermostReplyToMode(account, "channel")).toBe("all");
  });

  it("uses the configured mode for channel and group messages", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          replyToMode: "all",
        },
      },
    };

    const account = resolveMattermostAccount({ accountId: "default", cfg });
    expect(resolveMattermostReplyToMode(account, "channel")).toBe("all");
    expect(resolveMattermostReplyToMode(account, "group")).toBe("all");
  });

  it("keeps direct messages off even when replyToMode is enabled", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          replyToMode: "all",
        },
      },
    };

    const account = resolveMattermostAccount({ accountId: "default", cfg });
    expect(resolveMattermostReplyToMode(account, "direct")).toBe("off");
  });

  it("defaults to off when replyToMode is unset", () => {
    const account = resolveMattermostAccount({ accountId: "default", cfg: {} });
    expect(resolveMattermostReplyToMode(account, "channel")).toBe("off");
  });

  it("preserves shared commands config when an account overrides one commands field", () => {
    const account = resolveMattermostAccount({
      accountId: "work",
      cfg: {
        channels: {
          mattermost: {
            accounts: {
              work: {
                commands: {
                  callbackPath: "/hooks/work",
                },
              },
            },
            commands: {
              native: true,
            },
          },
        },
      },
    });

    expect(account.config.commands).toEqual({
      callbackPath: "/hooks/work",
      native: true,
    });
  });
});
