import { describe, expect, it } from "vitest";
import { DiscordConfigSchema } from "./zod-schema.providers-core.js";

describe("config discord presence", () => {
  it.each([
    { config: { discord: { status: "idle" } }, name: "status-only presence" },
    {
      config: { discord: { activity: "Focus time" } },
      name: "custom activity when type is omitted",
    },
    {
      config: { discord: { activity: "Chilling", activityType: 4 } },
      name: "custom activity type",
    },
    {
      config: {
        discord: {
          autoPresence: {
            enabled: true,
            exhaustedText: "token exhausted",
            intervalMs: 30_000,
            minUpdateIntervalMs: 15_000,
          },
        },
      },
      name: "auto presence config",
    },
  ] as const)("accepts $name", ({ config }) => {
    expect(DiscordConfigSchema.safeParse(config.discord).success).toBe(true);
  });

  it.each([
    {
      config: { discord: { activity: "Live", activityType: 1 } },
      name: "streaming activity without url",
    },
    {
      config: { discord: { activity: "Live", activityUrl: "https://twitch.tv/openclaw" } },
      name: "activityUrl without streaming type",
    },
    {
      config: {
        discord: {
          autoPresence: {
            enabled: true,
            intervalMs: 5000,
            minUpdateIntervalMs: 6000,
          },
        },
      },
      name: "auto presence min update interval above check interval",
    },
  ] as const)("rejects $name", ({ config }) => {
    expect(DiscordConfigSchema.safeParse(config.discord).success).toBe(false);
  });
});
