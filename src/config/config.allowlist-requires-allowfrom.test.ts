import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

function expectChannelAllowlistIssue(
  result: ReturnType<typeof validateConfigObject>,
  path: string | readonly string[],
) {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    const pathParts = Array.isArray(path) ? path : [path];
    expect(
      result.issues.some((issue) => pathParts.every((part) => issue.path.includes(part))),
    ).toBe(true);
  }
}

describe('dmPolicy="allowlist" requires non-empty effective allowFrom', () => {
  it.each([
    {
      config: { telegram: { botToken: "fake", dmPolicy: "allowlist" } },
      issuePath: "channels.telegram.allowFrom",
      name: "telegram",
    },
    {
      config: { signal: { dmPolicy: "allowlist" } },
      issuePath: "channels.signal.allowFrom",
      name: "signal",
    },
    {
      config: { discord: { dmPolicy: "allowlist" } },
      issuePath: ["channels.discord", "allowFrom"],
      name: "discord",
    },
    {
      config: { whatsapp: { dmPolicy: "allowlist" } },
      issuePath: "channels.whatsapp.allowFrom",
      name: "whatsapp",
    },
  ] as const)('rejects $name dmPolicy="allowlist" without allowFrom', ({ config, issuePath }) => {
    expectChannelAllowlistIssue(validateConfigObject({ channels: config }), issuePath);
  });

  it('accepts dmPolicy="pairing" without allowFrom', () => {
    const res = validateConfigObject({
      channels: { telegram: { botToken: "fake", dmPolicy: "pairing" } },
    });
    expect(res.ok).toBe(true);
  });
});

describe('account dmPolicy="allowlist" uses inherited allowFrom', () => {
  it.each([
    {
      config: {
        telegram: {
          accounts: { bot1: { botToken: "fake", dmPolicy: "allowlist" } },
          allowFrom: ["12345"],
        },
      },
      name: "telegram",
    },
    {
      config: {
        signal: { accounts: { work: { dmPolicy: "allowlist" } }, allowFrom: ["+15550001111"] },
      },
      name: "signal",
    },
    {
      config: {
        discord: { accounts: { work: { dmPolicy: "allowlist" } }, allowFrom: ["123456789"] },
      },
      name: "discord",
    },
    {
      config: {
        slack: {
          accounts: {
            work: { appToken: "xapp-work", botToken: "xoxb-work", dmPolicy: "allowlist" },
          },
          allowFrom: ["U123"],
          appToken: "xapp-top",
          botToken: "xoxb-top",
        },
      },
      name: "slack",
    },
    {
      config: {
        whatsapp: { accounts: { work: { dmPolicy: "allowlist" } }, allowFrom: ["+15550001111"] },
      },
      name: "whatsapp",
    },
    {
      config: {
        imessage: { accounts: { work: { dmPolicy: "allowlist" } }, allowFrom: ["alice"] },
      },
      name: "imessage",
    },
    {
      config: {
        irc: { accounts: { work: { dmPolicy: "allowlist" } }, allowFrom: ["nick"] },
      },
      name: "irc",
    },
    {
      config: {
        bluebubbles: { accounts: { work: { dmPolicy: "allowlist" } }, allowFrom: ["sender"] },
      },
      name: "bluebubbles",
    },
  ] as const)("accepts $name account allowlist when parent allowFrom exists", ({ config }) => {
    expect(validateConfigObject({ channels: config }).ok).toBe(true);
  });

  it("rejects telegram account allowlist when neither account nor parent has allowFrom", () => {
    expectChannelAllowlistIssue(
      validateConfigObject({
        channels: {
          telegram: { accounts: { bot1: { botToken: "fake", dmPolicy: "allowlist" } } },
        },
      }),
      "channels.telegram.accounts.bot1.allowFrom",
    );
  });
});
