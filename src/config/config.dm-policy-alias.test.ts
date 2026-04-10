import { describe, expect, it } from "vitest";
import { DiscordConfigSchema, SlackConfigSchema } from "./zod-schema.providers-core.js";

describe("DM policy aliases (Slack/Discord)", () => {
  it('rejects discord dmPolicy="open" without allowFrom "*"', () => {
    const res = DiscordConfigSchema.safeParse({
      allowFrom: ["123"],
      dmPolicy: "open",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("allowFrom");
    }
  });

  it('rejects discord dmPolicy="open" with empty allowFrom', () => {
    const res = DiscordConfigSchema.safeParse({
      allowFrom: [],
      dmPolicy: "open",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("allowFrom");
    }
  });

  it('rejects discord legacy dm.policy="open" with empty dm.allowFrom', () => {
    const res = DiscordConfigSchema.safeParse({
      dm: { allowFrom: [], policy: "open" },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("dm.allowFrom");
    }
  });

  it('accepts discord legacy dm.policy="open" with top-level allowFrom alias', () => {
    const res = DiscordConfigSchema.safeParse({
      allowFrom: ["*"],
      dm: { allowFrom: ["123"], policy: "open" },
    });
    expect(res.success).toBe(true);
  });

  it('rejects slack dmPolicy="open" without allowFrom "*"', () => {
    const res = SlackConfigSchema.safeParse({
      allowFrom: ["U123"],
      dmPolicy: "open",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("allowFrom");
    }
  });

  it('accepts slack legacy dm.policy="open" with top-level allowFrom alias', () => {
    const res = SlackConfigSchema.safeParse({
      allowFrom: ["*"],
      dm: { allowFrom: ["U123"], policy: "open" },
    });
    expect(res.success).toBe(true);
  });
});
