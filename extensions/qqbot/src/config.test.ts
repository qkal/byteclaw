import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../../src/plugins/schema-validator.js";
import { qqbotSetupAdapterShared } from "./channel-config-shared.js";
import { qqbotSetupPlugin } from "./channel.setup.js";
import { QQBotConfigSchema } from "./config-schema.js";
import { DEFAULT_ACCOUNT_ID, resolveDefaultQQBotAccountId, resolveQQBotAccount } from "./config.js";

describe("qqbot config", () => {
  it("accepts top-level speech overrides in the manifest schema", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema: Record<string, unknown> };

    const result = validateJsonSchemaValue({
      cacheKey: "qqbot.manifest.speech-overrides",
      schema: manifest.configSchema,
      value: {
        stt: {
          apiKey: "stt-key",
          baseUrl: "https://example.com/v1",
          model: "whisper-1",
          provider: "openai",
        },
        tts: {
          apiKey: "tts-key",
          authStyle: "api-key",
          baseUrl: "https://example.com/v1",
          model: "gpt-4o-mini-tts",
          provider: "openai",
          queryParams: {
            format: "wav",
          },
          speed: 1.1,
          voice: "alloy",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts defaultAccount in the manifest schema", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema: Record<string, unknown> };

    const result = validateJsonSchemaValue({
      cacheKey: "qqbot.manifest.default-account",
      schema: manifest.configSchema,
      value: {
        accounts: {
          bot2: {
            appId: "654321",
          },
        },
        defaultAccount: "bot2",
      },
    });

    expect(result.ok).toBe(true);
  });

  it("honors configured defaultAccount when resolving the default QQ Bot account id", () => {
    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            bot2: {
              appId: "654321",
            },
          },
          defaultAccount: "bot2",
        },
      },
    } as OpenClawConfig;

    expect(resolveDefaultQQBotAccountId(cfg)).toBe("bot2");
  });

  it("accepts SecretRef-backed credentials in the runtime schema", () => {
    const parsed = QQBotConfigSchema.safeParse({
      accounts: {
        bot2: {
          allowFrom: ["user-1"],
          appId: "654321",
          clientSecret: {
            id: "QQBOT_CLIENT_SECRET_BOT2",
            provider: "default",
            source: "env",
          },
        },
      },
      allowFrom: ["*"],
      appId: "123456",
      audioFormatPolicy: {
        sttDirectFormats: [".wav"],
        transcodeEnabled: false,
        uploadDirectFormats: [".mp3"],
      },
      clientSecret: {
        id: "QQBOT_CLIENT_SECRET",
        provider: "default",
        source: "env",
      },
      defaultAccount: "bot2",
      upgradeMode: "doc",
      upgradeUrl: "https://docs.openclaw.ai/channels/qqbot",
      urlDirectUpload: false,
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts account-level speech overrides as forward-compatible config", () => {
    const parsed = QQBotConfigSchema.safeParse({
      accounts: {
        bot2: {
          appId: "654321",
          tts: {
            provider: "openai",
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("preserves top-level media and upgrade config on the default account", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          audioFormatPolicy: {
            sttDirectFormats: [".wav"],
            transcodeEnabled: false,
            uploadDirectFormats: [".mp3"],
          },
          clientSecret: "secret-value",
          upgradeMode: "hot-reload",
          upgradeUrl: "https://docs.openclaw.ai/channels/qqbot",
          urlDirectUpload: false,
        },
      },
    } as OpenClawConfig;

    const resolved = resolveQQBotAccount(cfg, DEFAULT_ACCOUNT_ID);

    expect(resolved.clientSecret).toBe("secret-value");
    expect(resolved.config.audioFormatPolicy).toEqual({
      sttDirectFormats: [".wav"],
      transcodeEnabled: false,
      uploadDirectFormats: [".mp3"],
    });
    expect(resolved.config.urlDirectUpload).toBe(false);
    expect(resolved.config.upgradeUrl).toBe("https://docs.openclaw.ai/channels/qqbot");
    expect(resolved.config.upgradeMode).toBe("hot-reload");
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            bot2: {
              appId: "654321",
              clientSecret: "secret-value",
              name: "Bot Two",
            },
          },
          defaultAccount: "bot2",
        },
      },
    } as OpenClawConfig;

    const resolved = resolveQQBotAccount(cfg);

    expect(resolved.accountId).toBe("bot2");
    expect(resolved.appId).toBe("654321");
    expect(resolved.clientSecret).toBe("secret-value");
    expect(resolved.name).toBe("Bot Two");
  });

  it("rejects unresolved SecretRefs on runtime resolution", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          clientSecret: {
            id: "QQBOT_CLIENT_SECRET",
            provider: "default",
            source: "env",
          },
        },
      },
    } as OpenClawConfig;

    expect(() => resolveQQBotAccount(cfg, DEFAULT_ACCOUNT_ID)).toThrow(
      'channels.qqbot.clientSecret: unresolved SecretRef "env:default:QQBOT_CLIENT_SECRET"',
    );
  });

  it("allows unresolved SecretRefs for setup/status flows", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          clientSecret: {
            id: "QQBOT_CLIENT_SECRET",
            provider: "default",
            source: "env",
          },
        },
      },
    } as OpenClawConfig;

    const resolved = resolveQQBotAccount(cfg, DEFAULT_ACCOUNT_ID, {
      allowUnresolvedSecretRef: true,
    });

    expect(resolved.clientSecret).toBe("");
    expect(resolved.secretSource).toBe("config");
    expect(qqbotSetupPlugin.config.isConfigured?.(resolved, cfg)).toBe(true);
    expect(qqbotSetupPlugin.config.describeAccount?.(resolved, cfg)?.configured).toBe(true);
  });

  it.each([
    {
      accountId: DEFAULT_ACCOUNT_ID,
      expectedPath: ["channels", "qqbot"],
      inputAccountId: DEFAULT_ACCOUNT_ID,
    },
    {
      accountId: "bot2",
      expectedPath: ["channels", "qqbot", "accounts", "bot2"],
      inputAccountId: "bot2",
    },
  ])("splits --token on the first colon for $accountId", ({ inputAccountId, expectedPath }) => {
    const {setup} = qqbotSetupPlugin;
    expect(setup).toBeDefined();

    const next = setup!.applyAccountConfig?.({
      accountId: inputAccountId,
      cfg: {} as OpenClawConfig,
      input: {
        token: "102905186:Oi2Mg1Mh2Ni3:Pl7TpBXuHe1OmAYwKi7W",
      },
    }) as Record<string, unknown>;

    const accountConfig = expectedPath.reduce<unknown>((value, key) => {
      if (!value || typeof value !== "object") {
        return undefined;
      }
      return (value as Record<string, unknown>)[key];
    }, next) as Record<string, unknown> | undefined;

    expect(accountConfig).toMatchObject({
      appId: "102905186",
      clientSecret: "Oi2Mg1Mh2Ni3:Pl7TpBXuHe1OmAYwKi7W",
      enabled: true,
    });
  });

  it("rejects malformed --token consistently across setup paths", () => {
    const runtimeSetup = qqbotSetupAdapterShared;
    const lightweightSetup = qqbotSetupPlugin.setup;
    expect(runtimeSetup).toBeDefined();
    expect(lightweightSetup).toBeDefined();

    const input = { name: "Bad", token: "broken" };

    expect(
      runtimeSetup.validateInput?.({
        accountId: DEFAULT_ACCOUNT_ID,
        cfg: {} as OpenClawConfig,
        input,
      } as never),
    ).toBe("QQBot --token must be in appId:clientSecret format");
    expect(
      lightweightSetup!.validateInput?.({
        accountId: DEFAULT_ACCOUNT_ID,
        cfg: {} as OpenClawConfig,
        input,
      } as never),
    ).toBe("QQBot --token must be in appId:clientSecret format");
    expect(
      runtimeSetup.applyAccountConfig?.({
        accountId: DEFAULT_ACCOUNT_ID,
        cfg: {} as OpenClawConfig,
        input,
      } as never),
    ).toEqual({});
    expect(
      lightweightSetup!.applyAccountConfig?.({
        accountId: DEFAULT_ACCOUNT_ID,
        cfg: {} as OpenClawConfig,
        input,
      } as never),
    ).toEqual({});
  });

  it("preserves the --use-env add flow across setup paths", () => {
    const runtimeSetup = qqbotSetupAdapterShared;
    const lightweightSetup = qqbotSetupPlugin.setup;
    expect(runtimeSetup).toBeDefined();
    expect(lightweightSetup).toBeDefined();

    const input = { name: "Env Bot", useEnv: true };

    expect(
      runtimeSetup.applyAccountConfig?.({
        accountId: DEFAULT_ACCOUNT_ID,
        cfg: {} as OpenClawConfig,
        input,
      } as never),
    ).toMatchObject({
      channels: {
        qqbot: {
          allowFrom: ["*"],
          enabled: true,
          name: "Env Bot",
        },
      },
    });
    expect(
      lightweightSetup!.applyAccountConfig?.({
        accountId: DEFAULT_ACCOUNT_ID,
        cfg: {} as OpenClawConfig,
        input,
      } as never),
    ).toMatchObject({
      channels: {
        qqbot: {
          allowFrom: ["*"],
          enabled: true,
          name: "Env Bot",
        },
      },
    });
  });

  it("uses configured defaultAccount when runtime setup accountId is omitted", () => {
    const runtimeSetup = qqbotSetupAdapterShared;
    expect(runtimeSetup).toBeDefined();

    expect(
      runtimeSetup.resolveAccountId?.({
        accountId: undefined,
        cfg: {
          channels: {
            qqbot: {
              accounts: {
                bot2: { appId: "123456" },
              },
              defaultAccount: "bot2",
            },
          },
        } as OpenClawConfig,
      } as never),
    ).toBe("bot2");
  });

  it("rejects --use-env for named accounts across setup paths", () => {
    const runtimeSetup = qqbotSetupAdapterShared;
    const lightweightSetup = qqbotSetupPlugin.setup;
    expect(runtimeSetup).toBeDefined();
    expect(lightweightSetup).toBeDefined();

    const input = { name: "Env Bot", useEnv: true };

    expect(
      runtimeSetup.validateInput?.({
        accountId: "bot2",
        cfg: {} as OpenClawConfig,
        input,
      } as never),
    ).toBe("QQBot --use-env only supports the default account");
    expect(
      lightweightSetup!.validateInput?.({
        accountId: "bot2",
        cfg: {} as OpenClawConfig,
        input,
      } as never),
    ).toBe("QQBot --use-env only supports the default account");
    expect(
      runtimeSetup.applyAccountConfig?.({
        accountId: "bot2",
        cfg: {} as OpenClawConfig,
        input,
      } as never),
    ).toEqual({});
    expect(
      lightweightSetup!.applyAccountConfig?.({
        accountId: "bot2",
        cfg: {} as OpenClawConfig,
        input,
      } as never),
    ).toEqual({});
  });
});
