import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";
import {
  DiscordConfigSchema,
  MSTeamsConfigSchema,
  SlackConfigSchema,
} from "./zod-schema.providers-core.js";

function expectSchemaConfigValue(params: {
  schema: { safeParse: (value: unknown) => { success: true; data: unknown } | { success: false } };
  config: unknown;
  readValue: (config: unknown) => unknown;
  expectedValue: unknown;
}) {
  const res = params.schema.safeParse(params.config);
  expect(res.success).toBe(true);
  if (!res.success) {
    throw new Error("expected schema config to be valid");
  }
  expect(params.readValue(res.data)).toBe(params.expectedValue);
}

function expectProviderValidationIssuePath(params: {
  provider: string;
  config: unknown;
  expectedPath: string;
}) {
  const res = validateConfigObject({
    channels: {
      [params.provider]: params.config,
    },
  });
  expect(res.ok, params.provider).toBe(false);
  if (!res.ok) {
    expect(res.issues[0]?.path, params.provider).toBe(params.expectedPath);
  }
}

function expectProviderConfigValue(params: {
  provider: string;
  config: unknown;
  readValue: (config: unknown) => unknown;
  expectedValue: unknown;
}) {
  const res = validateConfigObject({
    channels: {
      [params.provider]: params.config,
    },
  });
  expect(res.ok, params.provider).toBe(true);
  if (!res.ok) {
    throw new Error(`expected ${params.provider} config to be valid`);
  }
  expect(params.readValue(res.config)).toBe(params.expectedValue);
}

describe("legacy config detection", () => {
  it.each([
    {
      expectedMessage: '"routing"',
      expectedPath: "",
      input: { routing: { allowFrom: ["+15555550123"] } },
      name: "routing.allowFrom",
    },
    {
      expectedMessage: '"routing"',
      expectedPath: "",
      input: { routing: { groupChat: { requireMention: false } } },
      name: "routing.groupChat.requireMention",
    },
  ] as const)(
    "rejects legacy routing key: $name",
    ({ input, expectedPath, expectedMessage, name }) => {
      const res = validateConfigObject(input);
      expect(res.ok, name).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]?.path, name).toBe(expectedPath);
        expect(res.issues[0]?.message, name).toContain(expectedMessage);
      }
    },
  );

  it("accepts per-agent tools.elevated overrides", async () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "work",
            tools: {
              elevated: {
                allowFrom: { whatsapp: ["+15555550123"] },
                enabled: false,
              },
            },
            workspace: "~/openclaw-work",
          },
        ],
      },
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["+15555550123"] },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config?.agents?.list?.[0]?.tools?.elevated).toEqual({
        allowFrom: { whatsapp: ["+15555550123"] },
        enabled: false,
      });
    }
  });
  it("rejects telegram.requireMention", async () => {
    const res = validateConfigObject({
      telegram: { requireMention: true },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("");
      expect(res.issues[0]?.message).toContain('"telegram"');
    }
  });
  it("rejects gateway.token", async () => {
    const res = validateConfigObject({
      gateway: { token: "legacy-token" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway");
    }
  });
  it.each(["0.0.0.0", "::", "127.0.0.1", "localhost", "::1"] as const)(
    "flags gateway.bind host alias as legacy: %s",
    (bind) => {
      const validated = validateConfigObject({ gateway: { bind } });
      expect(validated.ok, bind).toBe(false);
      if (!validated.ok) {
        expect(
          validated.issues.some((issue) => issue.path === "gateway.bind"),
          bind,
        ).toBe(true);
      }
    },
  );
  it.each([
    {
      allowFrom: ["123456789"],
      expectedIssuePath: "channels.telegram.allowFrom",
      name: "telegram",
    },
    {
      allowFrom: ["+15555550123"],
      expectedIssuePath: "channels.whatsapp.allowFrom",
      name: "whatsapp",
    },
    {
      allowFrom: ["+15555550123"],
      expectedIssuePath: "channels.signal.allowFrom",
      name: "signal",
    },
    {
      allowFrom: ["+15555550123"],
      expectedIssuePath: "channels.imessage.allowFrom",
      name: "imessage",
    },
  ] as const)(
    'enforces dmPolicy="open" allowFrom wildcard for $name',
    ({ name, allowFrom, expectedIssuePath }) => {
      expectProviderValidationIssuePath({
        config: { allowFrom, dmPolicy: "open" },
        expectedPath: expectedIssuePath,
        provider: name,
      });
    },
    180_000,
  );

  it.each(["telegram", "whatsapp", "signal"] as const)(
    'accepts dmPolicy="open" with wildcard for %s',
    (provider) => {
      expectProviderConfigValue({
        config: { allowFrom: ["*"], dmPolicy: "open" },
        expectedValue: "open",
        provider,
        readValue: (config) =>
          (
            config as {
              channels?: Record<string, { dmPolicy?: string } | undefined>;
            }
          ).channels?.[provider]?.dmPolicy,
      });
    },
  );

  it.each(["telegram", "whatsapp", "signal"] as const)(
    "defaults dm/group policy for configured provider %s",
    (provider) => {
      expectProviderConfigValue({
        config: {},
        expectedValue: "pairing",
        provider,
        readValue: (config) =>
          (
            config as {
              channels?: Record<string, { dmPolicy?: string } | undefined>;
            }
          ).channels?.[provider]?.dmPolicy,
      });
      expectProviderConfigValue({
        config: {},
        expectedValue: "allowlist",
        provider,
        readValue: (config) =>
          (
            config as {
              channels?: Record<string, { groupPolicy?: string } | undefined>;
            }
          ).channels?.[provider]?.groupPolicy,
      });
    },
  );

  it("accepts historyLimit overrides per provider and account", async () => {
    expectProviderConfigValue({
      config: { accounts: { work: { historyLimit: 4 } }, historyLimit: 9 },
      expectedValue: 9,
      provider: "whatsapp",
      readValue: (config) =>
        (config as { channels?: { whatsapp?: { historyLimit?: number } } }).channels?.whatsapp
          ?.historyLimit,
    });
    expectProviderConfigValue({
      config: { accounts: { work: { historyLimit: 4 } }, historyLimit: 9 },
      expectedValue: 4,
      provider: "whatsapp",
      readValue: (config) =>
        (
          config as {
            channels?: { whatsapp?: { accounts?: { work?: { historyLimit?: number } } } };
          }
        ).channels?.whatsapp?.accounts?.work?.historyLimit,
    });
    expectProviderConfigValue({
      config: { accounts: { ops: { historyLimit: 3 } }, historyLimit: 8 },
      expectedValue: 8,
      provider: "telegram",
      readValue: (config) =>
        (config as { channels?: { telegram?: { historyLimit?: number } } }).channels?.telegram
          ?.historyLimit,
    });
    expectProviderConfigValue({
      config: { accounts: { ops: { historyLimit: 3 } }, historyLimit: 8 },
      expectedValue: 3,
      provider: "telegram",
      readValue: (config) =>
        (
          config as {
            channels?: { telegram?: { accounts?: { ops?: { historyLimit?: number } } } };
          }
        ).channels?.telegram?.accounts?.ops?.historyLimit,
    });
    expectSchemaConfigValue({
      config: { accounts: { ops: { historyLimit: 2 } }, historyLimit: 7 },
      expectedValue: 7,
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      schema: SlackConfigSchema,
    });
    expectSchemaConfigValue({
      config: { accounts: { ops: { historyLimit: 2 } }, historyLimit: 7 },
      expectedValue: 2,
      readValue: (config) =>
        (config as { accounts?: { ops?: { historyLimit?: number } } }).accounts?.ops?.historyLimit,
      schema: SlackConfigSchema,
    });
    expectProviderConfigValue({
      config: { historyLimit: 6 },
      expectedValue: 6,
      provider: "signal",
      readValue: (config) =>
        (config as { channels?: { signal?: { historyLimit?: number } } }).channels?.signal
          ?.historyLimit,
    });
    expectProviderConfigValue({
      config: { historyLimit: 5 },
      expectedValue: 5,
      provider: "imessage",
      readValue: (config) =>
        (config as { channels?: { imessage?: { historyLimit?: number } } }).channels?.imessage
          ?.historyLimit,
    });
    expectSchemaConfigValue({
      config: { historyLimit: 4 },
      expectedValue: 4,
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      schema: MSTeamsConfigSchema,
    });
    expectSchemaConfigValue({
      config: { historyLimit: 3 },
      expectedValue: 3,
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      schema: DiscordConfigSchema,
    });
  });
});
