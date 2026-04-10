import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSendPolicy } from "./send-policy.js";

describe("resolveSendPolicy", () => {
  const cfgWithRules = (
    rules: NonNullable<NonNullable<OpenClawConfig["session"]>["sendPolicy"]>["rules"],
  ) =>
    ({
      session: {
        sendPolicy: {
          default: "allow",
          rules,
        },
      },
    }) as OpenClawConfig;

  it("defaults to allow", () => {
    const cfg = {} as OpenClawConfig;
    expect(resolveSendPolicy({ cfg })).toBe("allow");
  });

  it("entry override wins", () => {
    const cfg = {
      session: { sendPolicy: { default: "allow" } },
    } as OpenClawConfig;
    const entry: SessionEntry = {
      sendPolicy: "deny",
      sessionId: "s",
      updatedAt: 0,
    };
    expect(resolveSendPolicy({ cfg, entry })).toBe("deny");
  });

  it.each([
    {
      cfg: cfgWithRules([
        { action: "deny", match: { channel: "demo-channel", chatType: "group" } },
      ]),
      entry: {
        channel: "demo-channel",
        chatType: "group",
        sessionId: "s",
        updatedAt: 0,
      } as SessionEntry,
      expected: "deny",
      name: "rule match by channel + chatType",
      sessionKey: "demo-channel:group:dev",
    },
    {
      cfg: cfgWithRules([{ action: "deny", match: { keyPrefix: "cron:" } }]),
      expected: "deny",
      name: "rule match by keyPrefix",
      sessionKey: "cron:job-1",
    },
    {
      cfg: cfgWithRules([{ action: "deny", match: { rawKeyPrefix: "agent:main:demo-channel:" } }]),
      expected: "deny",
      name: "rule match by rawKeyPrefix",
      sessionKey: "agent:main:demo-channel:group:dev",
    },
    {
      cfg: cfgWithRules([{ action: "deny", match: { rawKeyPrefix: "agent:main:demo-channel:" } }]),
      expected: "allow",
      name: "rawKeyPrefix does not match other channels",
      sessionKey: "agent:main:other-channel:group:dev",
    },
  ])("$name", ({ cfg, entry, sessionKey, expected }) => {
    expect(resolveSendPolicy({ cfg, entry, sessionKey })).toBe(expected);
  });
});
