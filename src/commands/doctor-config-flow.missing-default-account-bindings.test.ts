import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectMissingDefaultAccountBindingWarnings } from "./doctor/shared/default-account-warnings.js";

describe("collectMissingDefaultAccountBindingWarnings", () => {
  it("warns when named accounts exist without default and no valid binding exists", () => {
    const cfg: OpenClawConfig = {
      bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
      channels: {
        telegram: {
          accounts: {
            alerts: { botToken: "a" },
            work: { botToken: "w" },
          },
        },
      },
    };

    const warnings = collectMissingDefaultAccountBindingWarnings(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("channels.telegram");
    expect(warnings[0]).toContain("alerts, work");
  });

  it("does not warn when an explicit account binding exists", () => {
    const cfg: OpenClawConfig = {
      bindings: [{ agentId: "ops", match: { accountId: "alerts", channel: "telegram" } }],
      channels: {
        telegram: {
          accounts: {
            alerts: { botToken: "a" },
          },
        },
      },
    };

    expect(collectMissingDefaultAccountBindingWarnings(cfg)).toEqual([]);
  });

  it("warns when bindings cover only a subset of configured accounts", () => {
    const cfg: OpenClawConfig = {
      bindings: [{ agentId: "ops", match: { accountId: "alerts", channel: "telegram" } }],
      channels: {
        telegram: {
          accounts: {
            alerts: { botToken: "a" },
            work: { botToken: "w" },
          },
        },
      },
    };

    const warnings = collectMissingDefaultAccountBindingWarnings(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("subset");
    expect(warnings[0]).toContain("Uncovered accounts: work");
  });

  it("does not warn when wildcard account binding exists", () => {
    const cfg: OpenClawConfig = {
      bindings: [{ agentId: "ops", match: { accountId: "*", channel: "telegram" } }],
      channels: {
        telegram: {
          accounts: {
            alerts: { botToken: "a" },
          },
        },
      },
    };

    expect(collectMissingDefaultAccountBindingWarnings(cfg)).toEqual([]);
  });

  it("does not warn when default account is present", () => {
    const cfg: OpenClawConfig = {
      bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
      channels: {
        telegram: {
          accounts: {
            alerts: { botToken: "a" },
            default: { botToken: "d" },
          },
        },
      },
    };

    expect(collectMissingDefaultAccountBindingWarnings(cfg)).toEqual([]);
  });
});
