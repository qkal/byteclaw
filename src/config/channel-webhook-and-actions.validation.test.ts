import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("channel webhook and actions validation", () => {
  describe("Telegram poll actions", () => {
    it("accepts channels.telegram.actions.poll", () => {
      const res = validateConfigObject({
        channels: {
          telegram: {
            actions: {
              poll: false,
            },
          },
        },
      });

      expect(res.ok).toBe(true);
    });

    it("accepts channels.telegram.accounts.<id>.actions.poll", () => {
      const res = validateConfigObject({
        channels: {
          telegram: {
            accounts: {
              ops: {
                actions: {
                  poll: false,
                },
              },
            },
          },
        },
      });

      expect(res.ok).toBe(true);
    });
  });

  describe("Telegram webhookPort", () => {
    it("accepts a positive webhookPort", () => {
      const res = validateConfigObject({
        channels: {
          telegram: {
            webhookPort: 8787,
            webhookSecret: "secret",
            webhookUrl: "https://example.com/telegram-webhook",
          },
        },
      });
      expect(res.ok).toBe(true);
    });

    it("accepts webhookPort set to 0 for ephemeral port binding", () => {
      const res = validateConfigObject({
        channels: {
          telegram: {
            webhookPort: 0,
            webhookSecret: "secret",
            webhookUrl: "https://example.com/telegram-webhook",
          },
        },
      });
      expect(res.ok).toBe(true);
    });

    it("rejects negative webhookPort", () => {
      const res = validateConfigObject({
        channels: {
          telegram: {
            webhookPort: -1,
            webhookSecret: "secret",
            webhookUrl: "https://example.com/telegram-webhook",
          },
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.some((issue) => issue.path === "channels.telegram.webhookPort")).toBe(
          true,
        );
      }
    });
  });

  describe("Telegram webhook secret", () => {
    it.each([
      {
        config: {
          telegram: {
            webhookSecret: "secret",
            webhookUrl: "https://example.com/telegram-webhook",
          },
        },
        name: "webhookUrl when webhookSecret is configured",
      },
      {
        config: {
          telegram: {
            webhookSecret: {
              id: "TELEGRAM_WEBHOOK_SECRET",
              provider: "default",
              source: "env",
            },
            webhookUrl: "https://example.com/telegram-webhook",
          },
        },
        name: "webhookUrl when webhookSecret is configured as SecretRef",
      },
      {
        config: {
          telegram: {
            accounts: {
              ops: {
                webhookUrl: "https://example.com/telegram-webhook",
              },
            },
            webhookSecret: "secret",
          },
        },
        name: "account webhookUrl when base webhookSecret is configured",
      },
      {
        config: {
          telegram: {
            accounts: {
              ops: {
                webhookSecret: {
                  id: "TELEGRAM_OPS_WEBHOOK_SECRET",
                  provider: "default",
                  source: "env",
                },
                webhookUrl: "https://example.com/telegram-webhook",
              },
            },
          },
        },
        name: "account webhookUrl when account webhookSecret is configured as SecretRef",
      },
    ] as const)("accepts $name", ({ config }) => {
      expect(validateConfigObject({ channels: config }).ok).toBe(true);
    });

    it("rejects webhookUrl without webhookSecret", () => {
      const res = validateConfigObject({
        channels: {
          telegram: {
            webhookUrl: "https://example.com/telegram-webhook",
          },
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]?.path).toBe("channels.telegram.webhookSecret");
      }
    });

    it("rejects account webhookUrl without webhookSecret", () => {
      const res = validateConfigObject({
        channels: {
          telegram: {
            accounts: {
              ops: {
                webhookUrl: "https://example.com/telegram-webhook",
              },
            },
          },
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]?.path).toBe("channels.telegram.accounts.ops.webhookSecret");
      }
    });
  });
});
