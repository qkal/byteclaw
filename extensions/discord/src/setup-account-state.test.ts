import { describe, expect, it } from "vitest";
import {
  inspectDiscordSetupAccount,
  listDiscordSetupAccountIds,
  resolveDefaultDiscordSetupAccountId,
  resolveDiscordSetupAccountConfig,
} from "./setup-account-state.js";

describe("discord setup account state", () => {
  it("lists normalized setup account ids plus the implicit default account", () => {
    expect(
      listDiscordSetupAccountIds({
        channels: {
          discord: {
            accounts: {
              Work: { token: "work-token" },
              alerts: { token: "alerts-token" },
            },
          },
        },
      }),
    ).toEqual(["alerts", "default", "work"]);
  });

  it("resolves setup account config when account key casing differs from normalized id", () => {
    const resolved = resolveDiscordSetupAccountConfig({
      accountId: "work",
      cfg: {
        channels: {
          discord: {
            accounts: {
              Work: { allowFrom: ["acct"], name: "Work" },
            },
            allowFrom: ["top"],
          },
        },
      },
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.config.name).toBe("Work");
    expect(resolved.config.allowFrom).toEqual(["acct"]);
  });

  it("uses configured defaultAccount for omitted setup account resolution", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            alerts: { allowFrom: ["alerts-only"] },
            work: { allowFrom: ["work-only"], name: "Work" },
          },
          allowFrom: ["top"],
          defaultAccount: "work",
        },
      },
    };

    expect(resolveDefaultDiscordSetupAccountId(cfg)).toBe("work");

    const resolved = resolveDiscordSetupAccountConfig({
      cfg,
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.config.name).toBe("Work");
    expect(resolved.config.allowFrom).toEqual(["work-only"]);
  });

  it("treats explicit blank account tokens as missing without falling back", () => {
    const inspected = inspectDiscordSetupAccount({
      accountId: "work",
      cfg: {
        channels: {
          discord: {
            accounts: {
              work: { token: "" },
            },
            token: "top-level-token",
          },
        },
      },
    });

    expect(inspected.accountId).toBe("work");
    expect(inspected.token).toBe("");
    expect(inspected.tokenSource).toBe("none");
    expect(inspected.tokenStatus).toBe("missing");
    expect(inspected.configured).toBe(false);
  });
});
