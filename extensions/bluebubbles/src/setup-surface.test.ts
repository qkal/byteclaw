import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  type WizardPrompter,
  createSetupWizardAdapter,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "../../../test/helpers/plugins/setup-wizard.js";
import { resolveBlueBubblesAccount } from "./accounts.js";
import { BlueBubblesConfigSchema } from "./config-schema.js";
import {
  resolveBlueBubblesGroupRequireMention,
  resolveBlueBubblesGroupToolPolicy,
} from "./group-policy.js";
import { blueBubblesSetupAdapter, blueBubblesSetupWizard } from "./setup-surface.js";
import {
  inferBlueBubblesTargetChatType,
  isAllowedBlueBubblesSender,
  looksLikeBlueBubblesExplicitTargetId,
  looksLikeBlueBubblesTargetId,
  normalizeBlueBubblesMessagingTarget,
  parseBlueBubblesAllowTarget,
  parseBlueBubblesTarget,
} from "./targets.js";
import { DEFAULT_WEBHOOK_PATH } from "./webhook-shared.js";

async function createBlueBubblesConfigureAdapter() {
  const plugin = {
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    config: {
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      listAccountIds: () => [DEFAULT_ACCOUNT_ID],
      resolveAccount: adaptScopedAccountAccessor(resolveBlueBubblesAccount),
      resolveAllowFrom: ({ cfg, accountId }: { cfg: unknown; accountId: string }) =>
        resolveBlueBubblesAccount({
          accountId,
          cfg: cfg as Parameters<typeof resolveBlueBubblesAccount>[0]["cfg"],
        }).config.allowFrom ?? [],
    },
    id: "bluebubbles",
    meta: {
      blurb: "iMessage via BlueBubbles",
      docsPath: "/channels/bluebubbles",
      id: "bluebubbles",
      label: "BlueBubbles",
      selectionLabel: "BlueBubbles",
    },
    setup: blueBubblesSetupAdapter,
  } as Parameters<typeof createSetupWizardAdapter>[0]["plugin"];
  return createSetupWizardAdapter({
    plugin,
    wizard: blueBubblesSetupWizard,
  });
}

async function runBlueBubblesConfigure(params: { cfg: unknown; prompter: WizardPrompter }) {
  const adapter = await createBlueBubblesConfigureAdapter();
  type ConfigureContext = Parameters<NonNullable<typeof adapter.configure>>[0];
  return await runSetupWizardConfigure({
    cfg: params.cfg as ConfigureContext["cfg"],
    configure: adapter.configure,
    prompter: params.prompter,
    runtime: { ...console, exit: vi.fn() } as ConfigureContext["runtime"],
  });
}

describe("bluebubbles setup surface", () => {
  it("preserves existing password SecretRef and keeps default webhook path", async () => {
    const passwordRef = { id: "BLUEBUBBLES_PASSWORD", provider: "default", source: "env" };
    const confirm = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const text = vi.fn();

    const result = await runBlueBubblesConfigure({
      cfg: {
        channels: {
          bluebubbles: {
            enabled: true,
            password: passwordRef,
            serverUrl: "http://127.0.0.1:1234",
          },
        },
      },
      prompter: createTestWizardPrompter({ confirm, text }),
    });

    expect(result.cfg.channels?.bluebubbles?.password).toEqual(passwordRef);
    expect(result.cfg.channels?.bluebubbles?.webhookPath).toBe(DEFAULT_WEBHOOK_PATH);
    expect(text).not.toHaveBeenCalled();
  });

  it("applies a custom webhook path when requested", async () => {
    const confirm = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const text = vi.fn().mockResolvedValueOnce("/custom-bluebubbles");

    const result = await runBlueBubblesConfigure({
      cfg: {
        channels: {
          bluebubbles: {
            enabled: true,
            password: "secret",
            serverUrl: "http://127.0.0.1:1234",
          },
        },
      },
      prompter: createTestWizardPrompter({ confirm, text }),
    });

    expect(result.cfg.channels?.bluebubbles?.webhookPath).toBe("/custom-bluebubbles");
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Webhook path",
        placeholder: DEFAULT_WEBHOOK_PATH,
      }),
    );
  });

  it("validates server URLs before accepting input", async () => {
    const confirm = vi.fn().mockResolvedValueOnce(false);
    const text = vi.fn().mockResolvedValueOnce("127.0.0.1:1234").mockResolvedValueOnce("secret");

    await runBlueBubblesConfigure({
      cfg: { channels: { bluebubbles: {} } },
      prompter: createTestWizardPrompter({ confirm, text }),
    });

    const serverUrlPrompt = text.mock.calls[0]?.[0] as {
      validate?: (value: string) => string | undefined;
    };
    expect(serverUrlPrompt.validate?.("bad url")).toBe("Invalid URL format");
    expect(serverUrlPrompt.validate?.("127.0.0.1:1234")).toBeUndefined();
  });

  it("disables the channel through the setup wizard", async () => {
    const next = blueBubblesSetupWizard.disable?.({
      channels: {
        bluebubbles: {
          enabled: true,
          serverUrl: "http://127.0.0.1:1234",
        },
      },
    });

    expect(next?.channels?.bluebubbles?.enabled).toBe(false);
  });

  it("reads the named-account DM policy instead of the channel root", async () => {
    expect(
      blueBubblesSetupWizard.dmPolicy?.getCurrent(
        {
          channels: {
            bluebubbles: {
              accounts: {
                work: {
                  dmPolicy: "allowlist",
                  password: "secret",
                  serverUrl: "http://localhost:1234",
                },
              },
              dmPolicy: "disabled",
            },
          },
        },
        "work",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", async () => {
    expect(blueBubblesSetupWizard.dmPolicy?.resolveConfigKeys?.({}, "work")).toEqual({
      allowFromKey: "channels.bluebubbles.accounts.work.allowFrom",
      policyKey: "channels.bluebubbles.accounts.work.dmPolicy",
    });
  });

  it("uses configured defaultAccount for omitted DM policy account context", async () => {
    const cfg = {
      channels: {
        bluebubbles: {
          accounts: {
            work: {
              dmPolicy: "allowlist",
              password: "secret",
              serverUrl: "http://localhost:1234",
            },
          },
          allowFrom: ["user@example.com"],
          defaultAccount: "work",
          dmPolicy: "disabled",
        },
      },
    } as OpenClawConfig;

    expect(blueBubblesSetupWizard.dmPolicy?.getCurrent(cfg)).toBe("allowlist");
    expect(blueBubblesSetupWizard.dmPolicy?.resolveConfigKeys?.(cfg)).toEqual({
      allowFromKey: "channels.bluebubbles.accounts.work.allowFrom",
      policyKey: "channels.bluebubbles.accounts.work.dmPolicy",
    });

    const next = blueBubblesSetupWizard.dmPolicy?.setPolicy(cfg, "open");
    const workAccount = next?.channels?.bluebubbles?.accounts?.work as
      | {
          dmPolicy?: string;
        }
      | undefined;
    expect(next?.channels?.bluebubbles?.dmPolicy).toBe("disabled");
    expect(workAccount?.dmPolicy).toBe("open");
  });

  it("uses configured defaultAccount when accountId is omitted in account resolution", async () => {
    const resolved = resolveBlueBubblesAccount({
      cfg: {
        channels: {
          bluebubbles: {
            accounts: {
              work: {
                name: "Work",
                password: "secret",
                serverUrl: "http://localhost:1234",
              },
            },
            defaultAccount: "work",
            password: "top-secret",
            serverUrl: "http://localhost:3000",
          },
        },
      } as OpenClawConfig,
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.baseUrl).toBe("http://localhost:1234");
    expect(resolved.configured).toBe(true);
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const configured = await blueBubblesSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          bluebubbles: {
            accounts: {
              alerts: {
                password: "alerts-secret",
                serverUrl: "http://localhost:4000",
              },
              work: {
                password: "",
                serverUrl: "",
              },
            },
            defaultAccount: "work",
            password: "top-secret",
            serverUrl: "http://localhost:3000",
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(false);
  });

  it('writes open policy state to the named account and preserves inherited allowFrom with "*"', async () => {
    const next = blueBubblesSetupWizard.dmPolicy?.setPolicy(
      {
        channels: {
          bluebubbles: {
            accounts: {
              work: {
                password: "secret",
                serverUrl: "http://localhost:1234",
              },
            },
            allowFrom: ["user@example.com"],
          },
        },
      },
      "open",
      "work",
    );

    const workAccount = next?.channels?.bluebubbles?.accounts?.work as
      | {
          dmPolicy?: string;
          allowFrom?: string[];
        }
      | undefined;
    expect(next?.channels?.bluebubbles?.dmPolicy).toBeUndefined();
    expect(workAccount?.dmPolicy).toBe("open");
    expect(workAccount?.allowFrom).toEqual(["user@example.com", "*"]);
  });
});

describe("resolveBlueBubblesAccount", () => {
  it("treats SecretRef passwords as configured when serverUrl exists", () => {
    const resolved = resolveBlueBubblesAccount({
      cfg: {
        channels: {
          bluebubbles: {
            enabled: true,
            password: {
              id: "BLUEBUBBLES_PASSWORD",
              provider: "default",
              source: "env",
            },
            serverUrl: "http://localhost:1234",
          },
        },
      },
    });

    expect(resolved.configured).toBe(true);
    expect(resolved.baseUrl).toBe("http://localhost:1234");
  });

  it("strips stale legacy private-network aliases after canonical normalization", () => {
    const resolved = resolveBlueBubblesAccount({
      accountId: "work",
      cfg: {
        channels: {
          bluebubbles: {
            accounts: {
              work: {
                serverUrl: "http://localhost:1234",
                password: "secret", // Pragma: allowlist secret
                network: {
                  dangerouslyAllowPrivateNetwork: false,
                },
              },
            },
            network: {
              allowPrivateNetwork: true,
            },
          },
        },
      },
    });

    expect(resolved.config.network).toEqual({
      dangerouslyAllowPrivateNetwork: false,
    });
    expect("allowPrivateNetwork" in resolved.config).toBe(false);
    expect(isPrivateNetworkOptInEnabled(resolved.config)).toBe(false);
  });
});

describe("BlueBubblesConfigSchema", () => {
  it("accepts account config when serverUrl and password are both set", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      password: "secret",
      serverUrl: "http://localhost:1234", // Pragma: allowlist secret
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts SecretRef password when serverUrl is set", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      password: {
        id: "BLUEBUBBLES_PASSWORD",
        provider: "default",
        source: "env",
      },
      serverUrl: "http://localhost:1234",
    });
    expect(parsed.success).toBe(true);
  });

  it("requires password when top-level serverUrl is configured", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      serverUrl: "http://localhost:1234",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }
    expect(parsed.error.issues[0]?.path).toEqual(["password"]);
    expect(parsed.error.issues[0]?.message).toBe(
      "password is required when serverUrl is configured",
    );
  });

  it("requires password when account serverUrl is configured", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      accounts: {
        work: {
          serverUrl: "http://localhost:1234",
        },
      },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }
    expect(parsed.error.issues[0]?.path).toEqual(["accounts", "work", "password"]);
    expect(parsed.error.issues[0]?.message).toBe(
      "password is required when serverUrl is configured",
    );
  });

  it("allows password omission when serverUrl is not configured", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      accounts: {
        work: {
          name: "Work iMessage",
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("defaults enrichGroupParticipantsFromContacts to true", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      password: "secret",
      serverUrl: "http://localhost:1234", // Pragma: allowlist secret
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.enrichGroupParticipantsFromContacts).toBe(true);
  });

  it("defaults account enrichGroupParticipantsFromContacts to true", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      accounts: {
        work: {
          password: "secret",
          serverUrl: "http://localhost:1234", // Pragma: allowlist secret
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    const accountConfig = (
      parsed.data as { accounts?: { work?: { enrichGroupParticipantsFromContacts?: boolean } } }
    ).accounts?.work;
    expect(accountConfig?.enrichGroupParticipantsFromContacts).toBe(true);
  });
});

describe("bluebubbles group policy", () => {
  it("uses generic channel group policy helpers", () => {
    const cfg = {
      channels: {
        bluebubbles: {
          groups: {
            "*": {
              requireMention: true,
              tools: { allow: ["message.send"] },
            },
            "chat:primary": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
          },
        },
      },
    } as any;

    expect(resolveBlueBubblesGroupRequireMention({ cfg, groupId: "chat:primary" })).toBe(false);
    expect(resolveBlueBubblesGroupRequireMention({ cfg, groupId: "chat:other" })).toBe(true);
    expect(resolveBlueBubblesGroupToolPolicy({ cfg, groupId: "chat:primary" })).toEqual({
      deny: ["exec"],
    });
    expect(resolveBlueBubblesGroupToolPolicy({ cfg, groupId: "chat:other" })).toEqual({
      allow: ["message.send"],
    });
  });
});

describe("normalizeBlueBubblesMessagingTarget", () => {
  it("normalizes chat_guid targets", () => {
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:ABC-123")).toBe("chat_guid:ABC-123");
  });

  it("normalizes group numeric targets to chat_id", () => {
    expect(normalizeBlueBubblesMessagingTarget("group:123")).toBe("chat_id:123");
  });

  it("strips provider prefix and normalizes handles", () => {
    expect(normalizeBlueBubblesMessagingTarget("bluebubbles:imessage:User@Example.com")).toBe(
      "imessage:user@example.com",
    );
  });

  it("extracts handle from DM chat_guid for cross-context matching", () => {
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:iMessage;-;+19257864429")).toBe(
      "+19257864429",
    );
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:SMS;-;+15551234567")).toBe(
      "+15551234567",
    );
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:iMessage;-;user@example.com")).toBe(
      "user@example.com",
    );
  });

  it("preserves group chat_guid format", () => {
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:iMessage;+;chat123456789")).toBe(
      "chat_guid:iMessage;+;chat123456789",
    );
  });

  it("normalizes raw chat_guid values", () => {
    expect(normalizeBlueBubblesMessagingTarget("iMessage;+;chat660250192681427962")).toBe(
      "chat_guid:iMessage;+;chat660250192681427962",
    );
    expect(normalizeBlueBubblesMessagingTarget("iMessage;-;+19257864429")).toBe("+19257864429");
  });

  it("normalizes chat<digits> pattern to chat_identifier format", () => {
    expect(normalizeBlueBubblesMessagingTarget("chat660250192681427962")).toBe(
      "chat_identifier:chat660250192681427962",
    );
    expect(normalizeBlueBubblesMessagingTarget("chat123")).toBe("chat_identifier:chat123");
    expect(normalizeBlueBubblesMessagingTarget("Chat456789")).toBe("chat_identifier:Chat456789");
  });

  it("normalizes UUID/hex chat identifiers", () => {
    expect(normalizeBlueBubblesMessagingTarget("8b9c1a10536d4d86a336ea03ab7151cc")).toBe(
      "chat_identifier:8b9c1a10536d4d86a336ea03ab7151cc",
    );
    expect(normalizeBlueBubblesMessagingTarget("1C2D3E4F-1234-5678-9ABC-DEF012345678")).toBe(
      "chat_identifier:1C2D3E4F-1234-5678-9ABC-DEF012345678",
    );
  });
});

describe("looksLikeBlueBubblesTargetId", () => {
  it("accepts chat targets", () => {
    expect(looksLikeBlueBubblesTargetId("chat_guid:ABC-123")).toBe(true);
  });

  it("accepts email handles", () => {
    expect(looksLikeBlueBubblesTargetId("user@example.com")).toBe(true);
  });

  it("accepts phone numbers with punctuation", () => {
    expect(looksLikeBlueBubblesTargetId("+1 (555) 123-4567")).toBe(true);
  });

  it("accepts raw chat_guid values", () => {
    expect(looksLikeBlueBubblesTargetId("iMessage;+;chat660250192681427962")).toBe(true);
  });

  it("accepts chat<digits> pattern as chat_id", () => {
    expect(looksLikeBlueBubblesTargetId("chat660250192681427962")).toBe(true);
    expect(looksLikeBlueBubblesTargetId("chat123")).toBe(true);
    expect(looksLikeBlueBubblesTargetId("Chat456789")).toBe(true);
  });

  it("accepts UUID/hex chat identifiers", () => {
    expect(looksLikeBlueBubblesTargetId("8b9c1a10536d4d86a336ea03ab7151cc")).toBe(true);
    expect(looksLikeBlueBubblesTargetId("1C2D3E4F-1234-5678-9ABC-DEF012345678")).toBe(true);
  });

  it("rejects display names", () => {
    expect(looksLikeBlueBubblesTargetId("Jane Doe")).toBe(false);
  });
});

describe("looksLikeBlueBubblesExplicitTargetId", () => {
  it("treats explicit chat targets as immediate ids", () => {
    expect(looksLikeBlueBubblesExplicitTargetId("chat_guid:ABC-123")).toBe(true);
    expect(looksLikeBlueBubblesExplicitTargetId("imessage:+15551234567")).toBe(true);
  });

  it("prefers directory fallback for bare handles and phone numbers", () => {
    expect(looksLikeBlueBubblesExplicitTargetId("+1 (555) 123-4567")).toBe(false);
    expect(looksLikeBlueBubblesExplicitTargetId("user@example.com")).toBe(false);
  });
});

describe("inferBlueBubblesTargetChatType", () => {
  it("infers direct chat for handles and dm chat_guids", () => {
    expect(inferBlueBubblesTargetChatType("+15551234567")).toBe("direct");
    expect(inferBlueBubblesTargetChatType("chat_guid:iMessage;-;+15551234567")).toBe("direct");
  });

  it("infers group chat for explicit group targets", () => {
    expect(inferBlueBubblesTargetChatType("chat_id:123")).toBe("group");
    expect(inferBlueBubblesTargetChatType("chat_guid:iMessage;+;chat123")).toBe("group");
  });
});

describe("parseBlueBubblesTarget", () => {
  it("parses chat<digits> pattern as chat_identifier", () => {
    expect(parseBlueBubblesTarget("chat660250192681427962")).toEqual({
      chatIdentifier: "chat660250192681427962",
      kind: "chat_identifier",
    });
    expect(parseBlueBubblesTarget("chat123")).toEqual({
      chatIdentifier: "chat123",
      kind: "chat_identifier",
    });
    expect(parseBlueBubblesTarget("Chat456789")).toEqual({
      chatIdentifier: "Chat456789",
      kind: "chat_identifier",
    });
  });

  it("parses UUID/hex chat identifiers as chat_identifier", () => {
    expect(parseBlueBubblesTarget("8b9c1a10536d4d86a336ea03ab7151cc")).toEqual({
      chatIdentifier: "8b9c1a10536d4d86a336ea03ab7151cc",
      kind: "chat_identifier",
    });
    expect(parseBlueBubblesTarget("1C2D3E4F-1234-5678-9ABC-DEF012345678")).toEqual({
      chatIdentifier: "1C2D3E4F-1234-5678-9ABC-DEF012345678",
      kind: "chat_identifier",
    });
  });

  it("parses explicit chat_id: prefix", () => {
    expect(parseBlueBubblesTarget("chat_id:123")).toEqual({ chatId: 123, kind: "chat_id" });
  });

  it("parses phone numbers as handles", () => {
    expect(parseBlueBubblesTarget("+19257864429")).toEqual({
      kind: "handle",
      service: "auto",
      to: "+19257864429",
    });
  });

  it("parses raw chat_guid format", () => {
    expect(parseBlueBubblesTarget("iMessage;+;chat660250192681427962")).toEqual({
      chatGuid: "iMessage;+;chat660250192681427962",
      kind: "chat_guid",
    });
  });
});

describe("parseBlueBubblesAllowTarget", () => {
  it("parses chat<digits> pattern as chat_identifier", () => {
    expect(parseBlueBubblesAllowTarget("chat660250192681427962")).toEqual({
      chatIdentifier: "chat660250192681427962",
      kind: "chat_identifier",
    });
    expect(parseBlueBubblesAllowTarget("chat123")).toEqual({
      chatIdentifier: "chat123",
      kind: "chat_identifier",
    });
  });

  it("parses UUID/hex chat identifiers as chat_identifier", () => {
    expect(parseBlueBubblesAllowTarget("8b9c1a10536d4d86a336ea03ab7151cc")).toEqual({
      chatIdentifier: "8b9c1a10536d4d86a336ea03ab7151cc",
      kind: "chat_identifier",
    });
    expect(parseBlueBubblesAllowTarget("1C2D3E4F-1234-5678-9ABC-DEF012345678")).toEqual({
      chatIdentifier: "1C2D3E4F-1234-5678-9ABC-DEF012345678",
      kind: "chat_identifier",
    });
  });

  it("parses explicit chat_id: prefix", () => {
    expect(parseBlueBubblesAllowTarget("chat_id:456")).toEqual({ chatId: 456, kind: "chat_id" });
  });

  it("parses phone numbers as handles", () => {
    expect(parseBlueBubblesAllowTarget("+19257864429")).toEqual({
      handle: "+19257864429",
      kind: "handle",
    });
  });
});

describe("isAllowedBlueBubblesSender", () => {
  it("denies when allowFrom is empty", () => {
    const allowed = isAllowedBlueBubblesSender({
      allowFrom: [],
      sender: "+15551234567",
    });
    expect(allowed).toBe(false);
  });

  it("allows wildcard entries", () => {
    const allowed = isAllowedBlueBubblesSender({
      allowFrom: ["*"],
      sender: "+15551234567",
    });
    expect(allowed).toBe(true);
  });
});
