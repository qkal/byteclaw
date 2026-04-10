import { describe, expect, it } from "vitest";
import {
  collectUnsupportedSecretRefConfigCandidates,
  getUnsupportedSecretRefSurfacePatterns,
} from "./unsupported-surface-policy.js";

describe("unsupported SecretRef surface policy metadata", () => {
  it("exposes the canonical unsupported surface patterns", () => {
    expect(getUnsupportedSecretRefSurfacePatterns()).toEqual([
      "commands.ownerDisplaySecret",
      "hooks.token",
      "hooks.gmail.pushToken",
      "hooks.mappings[].sessionKey",
      "auth-profiles.oauth.*",
      "channels.discord.threadBindings.webhookToken",
      "channels.discord.accounts.*.threadBindings.webhookToken",
      "channels.whatsapp.creds.json",
      "channels.whatsapp.accounts.*.creds.json",
    ]);
  });

  it("discovers concrete config candidates for unsupported mutable surfaces", () => {
    const candidates = collectUnsupportedSecretRefConfigCandidates({
      channels: {
        discord: {
          accounts: {
            ops: {
              threadBindings: {
                webhookToken: {
                  id: "DISCORD_WEBHOOK_OPS",
                  provider: "default",
                  source: "env",
                },
              },
            },
          },
          threadBindings: {
            webhookToken: { id: "DISCORD_WEBHOOK", provider: "default", source: "env" },
          },
        },
        whatsapp: {
          accounts: {
            ops: {
              creds: {
                json: { id: "WHATSAPP_JSON_OPS", provider: "default", source: "env" },
              },
            },
          },
          creds: { json: { id: "WHATSAPP_JSON", provider: "default", source: "env" } },
        },
      },
      commands: { ownerDisplaySecret: { id: "OWNER", provider: "default", source: "env" } },
      hooks: {
        gmail: { pushToken: { id: "GMAIL_PUSH", provider: "default", source: "env" } },
        mappings: [{ sessionKey: { id: "S0", provider: "default", source: "env" } }],
        token: { id: "HOOK_TOKEN", provider: "default", source: "env" },
      },
    });

    expect(candidates.map((candidate) => candidate.path).toSorted()).toEqual(
      [
        "commands.ownerDisplaySecret",
        "hooks.token",
        "hooks.gmail.pushToken",
        "hooks.mappings.0.sessionKey",
        "channels.discord.threadBindings.webhookToken",
        "channels.discord.accounts.ops.threadBindings.webhookToken",
        "channels.whatsapp.creds.json",
        "channels.whatsapp.accounts.ops.creds.json",
      ].toSorted(),
    );
  });
});
