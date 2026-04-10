import { describe, expect, it } from "vitest";
import { resolveZaloAccount } from "./accounts.js";

describe("resolveZaloAccount", () => {
  it("resolves account config when account key casing differs from normalized id", () => {
    const resolved = resolveZaloAccount({
      accountId: "work",
      cfg: {
        channels: {
          zalo: {
            accounts: {
              Work: {
                name: "Work",
                webhookUrl: "https://work.example.com",
              },
            },
            webhookUrl: "https://top.example.com",
          },
        },
      },
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.config.webhookUrl).toBe("https://work.example.com");
  });

  it("falls back to top-level config for named accounts without overrides", () => {
    const resolved = resolveZaloAccount({
      accountId: "work",
      cfg: {
        channels: {
          zalo: {
            accounts: {
              work: {},
            },
            enabled: true,
            webhookUrl: "https://top.example.com",
          },
        },
      },
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.enabled).toBe(true);
    expect(resolved.config.webhookUrl).toBe("https://top.example.com");
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveZaloAccount({
      cfg: {
        channels: {
          zalo: {
            accounts: {
              work: {
                botToken: "work-token",
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
    expect(resolved.token).toBe("work-token");
  });
});
