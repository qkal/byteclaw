import { describe, expect, it, vi } from "vitest";
import {
  nextcloudTalkConfigAdapter,
  nextcloudTalkPairingTextAdapter,
  nextcloudTalkSecurityAdapter,
} from "./channel.adapters.js";
import { NextcloudTalkConfigSchema } from "./config-schema.js";
import type { CoreConfig } from "./types.js";

vi.mock("../../../test/helpers/config/bundled-channel-config-runtime.js", () => ({
  getBundledChannelConfigSchemaMap: () => new Map(),
  getBundledChannelRuntimeMap: () => new Map(),
}));

vi.mock("../../../src/channels/plugins/bundled.js", () => ({
  bundledChannelPlugins: [],
  bundledChannelSetupPlugins: [],
}));

describe("nextcloud talk channel core", () => {
  it("accepts SecretRef botSecret and apiPassword at top-level", () => {
    const result = NextcloudTalkConfigSchema.safeParse({
      apiPassword: { id: "NEXTCLOUD_TALK_API_PASSWORD", provider: "default", source: "env" },
      apiUser: "bot",
      baseUrl: "https://cloud.example.com",
      botSecret: { id: "NEXTCLOUD_TALK_BOT_SECRET", provider: "default", source: "env" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef botSecret and apiPassword on account", () => {
    const result = NextcloudTalkConfigSchema.safeParse({
      accounts: {
        main: {
          apiPassword: {
            id: "NEXTCLOUD_TALK_MAIN_API_PASSWORD",
            provider: "default",
            source: "env",
          },
          apiUser: "bot",
          baseUrl: "https://cloud.example.com",
          botSecret: {
            id: "NEXTCLOUD_TALK_MAIN_BOT_SECRET",
            provider: "default",
            source: "env",
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("normalizes trimmed DM allowlist prefixes to lowercase ids", () => {
    const { resolveDmPolicy } = nextcloudTalkSecurityAdapter;
    if (!resolveDmPolicy) {
      throw new Error("resolveDmPolicy unavailable");
    }

    const cfg = {
      channels: {
        "nextcloud-talk": {
          allowFrom: ["  nc:User-Id  "],
          baseUrl: "https://cloud.example.com",
          botSecret: "secret",
          dmPolicy: "allowlist",
        },
      },
    } as CoreConfig;

    const result = resolveDmPolicy({
      account: nextcloudTalkConfigAdapter.resolveAccount(cfg, "default"),
      cfg,
    });
    if (!result) {
      throw new Error("nextcloud-talk resolveDmPolicy returned null");
    }

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  nc:User-Id  "]);
    expect(result.normalizeEntry?.("  nc:User-Id  ")).toBe("user-id");
    expect(nextcloudTalkPairingTextAdapter.normalizeAllowEntry("  nextcloud-talk:User-Id  ")).toBe(
      "user-id",
    );
  });
});
