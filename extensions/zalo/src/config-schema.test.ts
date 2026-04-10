import { describe, expect, it } from "vitest";
import { ZaloConfigSchema } from "./config-schema.js";

describe("ZaloConfigSchema SecretInput", () => {
  it("accepts SecretRef botToken and webhookSecret at top-level", () => {
    const result = ZaloConfigSchema.safeParse({
      botToken: { id: "ZALO_BOT_TOKEN", provider: "default", source: "env" },
      webhookSecret: { id: "ZALO_WEBHOOK_SECRET", provider: "default", source: "env" },
      webhookUrl: "https://example.com/zalo",
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef botToken and webhookSecret on account", () => {
    const result = ZaloConfigSchema.safeParse({
      accounts: {
        work: {
          botToken: { id: "ZALO_WORK_BOT_TOKEN", provider: "default", source: "env" },
          webhookSecret: {
            id: "ZALO_WORK_WEBHOOK_SECRET",
            provider: "default",
            source: "env",
          },
          webhookUrl: "https://example.com/zalo/work",
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
