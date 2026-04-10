import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveSetupWizardAllowFromEntries,
  resolveSetupWizardGroupAllowlist,
} from "../../../test/helpers/plugins/setup-wizard.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  namedAccountPromotionKeys as matrixNamedAccountPromotionKeys,
  singleAccountKeysToMove as matrixSingleAccountKeysToMove,
  resolveSingleAccountPromotionTarget as resolveMatrixSingleAccountPromotionTarget,
} from "../../plugin-sdk/matrix.js";
import { singleAccountKeysToMove as telegramSingleAccountKeysToMove } from "../../plugin-sdk/telegram.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  applySingleTokenPromptResult,
  buildSingleChannelSecretPromptState,
  createAccountScopedAllowFromSection,
  createAccountScopedGroupAccessSection,
  createAllowFromSection,
  createLegacyCompatChannelDmPolicy,
  createNestedChannelAllowFromSetter,
  createNestedChannelDmPolicy,
  createNestedChannelDmPolicySetter,
  createNestedChannelParsedAllowFromPrompt,
  createPromptParsedAllowFromForAccount,
  createStandardChannelSetupStatus,
  createTopLevelChannelAllowFromSetter,
  createTopLevelChannelDmPolicy,
  createTopLevelChannelDmPolicySetter,
  createTopLevelChannelGroupPolicySetter,
  createTopLevelChannelParsedAllowFromPrompt,
  normalizeAllowFromEntries,
  noteChannelLookupFailure,
  noteChannelLookupSummary,
  parseMentionOrPrefixedId,
  parseSetupEntriesAllowingWildcard,
  parseSetupEntriesWithParser,
  patchChannelConfigForAccount,
  patchLegacyDmChannelConfig,
  patchNestedChannelConfigSection,
  patchTopLevelChannelConfigSection,
  promptLegacyChannelAllowFrom,
  promptLegacyChannelAllowFromForAccount,
  promptParsedAllowFromForAccount,
  promptParsedAllowFromForScopedChannel,
  promptResolvedAllowFrom,
  promptSingleChannelSecretInput,
  promptSingleChannelToken,
  resolveAccountIdForConfigure,
  resolveEntriesWithOptionalToken,
  resolveGroupAllowlistWithLookupNotes,
  resolveParsedAllowFromEntries,
  resolveSetupAccountId,
  setAccountAllowFromForChannel,
  setAccountDmAllowFromForChannel,
  setAccountGroupPolicyForChannel,
  setChannelDmPolicyWithAllowFrom,
  setLegacyChannelAllowFrom,
  setLegacyChannelDmPolicyWithAllowFrom,
  setNestedChannelAllowFrom,
  setNestedChannelDmPolicyWithAllowFrom,
  setSetupChannelEnabled,
  setTopLevelChannelAllowFrom,
  setTopLevelChannelDmPolicyWithAllowFrom,
  setTopLevelChannelGroupPolicy,
  splitSetupEntries,
} from "./setup-wizard-helpers.js";

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
          setup: {
            namedAccountPromotionKeys: matrixNamedAccountPromotionKeys,
            resolveSingleAccountPromotionTarget: resolveMatrixSingleAccountPromotionTarget,
            singleAccountKeysToMove: matrixSingleAccountKeysToMove,
          },
        },
        pluginId: "matrix",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          setup: {
            singleAccountKeysToMove: telegramSingleAccountKeysToMove,
          },
        },
        pluginId: "telegram",
        source: "test",
      },
    ]),
  );
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function createPrompter(inputs: string[]) {
  return {
    note: vi.fn(async () => undefined),
    text: vi.fn(async () => inputs.shift() ?? ""),
  };
}

function createTokenPrompter(params: { confirms: boolean[]; texts: string[] }) {
  const confirms = [...params.confirms];
  const texts = [...params.texts];
  return {
    confirm: vi.fn(async () => confirms.shift() ?? true),
    text: vi.fn(async () => texts.shift() ?? ""),
  };
}

function parseCsvInputs(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

type AllowFromResolver = (params: {
  token: string;
  entries: string[];
}) => Promise<{ input: string; resolved: boolean; id?: string | null }[]>;

function asAllowFromResolver(resolveEntries: ReturnType<typeof vi.fn>): AllowFromResolver {
  return resolveEntries as AllowFromResolver;
}

async function runPromptResolvedAllowFromWithToken(params: {
  prompter: ReturnType<typeof createPrompter>;
  resolveEntries: AllowFromResolver;
}) {
  return await promptResolvedAllowFrom({
    existing: [],
    invalidWithoutTokenNote: "ids only",
    label: "allowlist",
    message: "msg",
    parseId: () => null,
    parseInputs: parseCsvInputs,
    placeholder: "placeholder",
    prompter: params.prompter as any,
    resolveEntries: params.resolveEntries,
    token: "xoxb-test",
  });
}

async function runPromptSingleToken(params: {
  prompter: ReturnType<typeof createTokenPrompter>;
  accountConfigured: boolean;
  canUseEnv: boolean;
  hasConfigToken: boolean;
}) {
  return await promptSingleChannelToken({
    accountConfigured: params.accountConfigured,
    canUseEnv: params.canUseEnv,
    envPrompt: "use env",
    hasConfigToken: params.hasConfigToken,
    inputPrompt: "token",
    keepPrompt: "keep",
    prompter: params.prompter,
  });
}

function createSecretInputPrompter(params: {
  selects: string[];
  confirms?: boolean[];
  texts?: string[];
}) {
  const selects = [...params.selects];
  const confirms = [...(params.confirms ?? [])];
  const texts = [...(params.texts ?? [])];
  return {
    confirm: vi.fn(async () => confirms.shift() ?? false),
    note: vi.fn(async () => undefined),
    select: vi.fn(async () => selects.shift() ?? "plaintext"),
    text: vi.fn(async () => texts.shift() ?? ""),
  };
}

async function runPromptSingleChannelSecretInput(params: {
  prompter: ReturnType<typeof createSecretInputPrompter>;
  providerHint: string;
  credentialLabel: string;
  accountConfigured: boolean;
  canUseEnv: boolean;
  hasConfigToken: boolean;
  preferredEnvVar: string;
}) {
  return await promptSingleChannelSecretInput({
    accountConfigured: params.accountConfigured,
    canUseEnv: params.canUseEnv,
    cfg: {},
    credentialLabel: params.credentialLabel,
    envPrompt: "use env",
    hasConfigToken: params.hasConfigToken,
    inputPrompt: "token",
    keepPrompt: "keep",
    preferredEnvVar: params.preferredEnvVar,
    prompter: params.prompter as any,
    providerHint: params.providerHint,
  });
}

describe("buildSingleChannelSecretPromptState", () => {
  it.each([
    {
      expected: {
        accountConfigured: false,
        canUseEnv: true,
        hasConfigToken: false,
      },
      input: {
        accountConfigured: false,
        allowEnv: true,
        envValue: "token-from-env",
        hasConfigToken: false,
      },
      name: "enables env path only when env is present and no config token exists",
    },
    {
      expected: {
        accountConfigured: true,
        canUseEnv: false,
        hasConfigToken: true,
      },
      input: {
        accountConfigured: true,
        allowEnv: true,
        envValue: "token-from-env",
        hasConfigToken: true,
      },
      name: "disables env path when config token already exists",
    },
  ])("$name", ({ input, expected }) => {
    expect(buildSingleChannelSecretPromptState(input)).toEqual(expected);
  });
});

async function runPromptLegacyAllowFrom(params: {
  cfg?: OpenClawConfig;
  channel: "discord" | "slack";
  prompter: ReturnType<typeof createPrompter>;
  existing: string[];
  token: string;
  noteTitle: string;
  noteLines: string[];
  parseId: (value: string) => string | null;
  resolveEntries: AllowFromResolver;
}) {
  return await promptLegacyChannelAllowFrom({
    cfg: params.cfg ?? {},
    channel: params.channel,
    existing: params.existing,
    invalidWithoutTokenNote: "ids only",
    message: "msg",
    noteLines: params.noteLines,
    noteTitle: params.noteTitle,
    parseId: params.parseId,
    placeholder: "placeholder",
    prompter: params.prompter as any,
    resolveEntries: params.resolveEntries,
    token: params.token,
  });
}

describe("promptResolvedAllowFrom", () => {
  it("re-prompts without token until all ids are parseable", async () => {
    const prompter = createPrompter(["@alice", "123"]);
    const resolveEntries = vi.fn();

    const result = await promptResolvedAllowFrom({
      existing: ["111"],
      invalidWithoutTokenNote: "ids only",
      label: "allowlist",
      message: "msg",
      parseId: (value) => (/^\d+$/.test(value.trim()) ? value.trim() : null),
      parseInputs: parseCsvInputs,
      placeholder: "placeholder",
      prompter: prompter as any,
      resolveEntries: resolveEntries as any,
      token: "",
    });

    expect(result).toEqual(["111", "123"]);
    expect(prompter.note).toHaveBeenCalledWith("ids only", "allowlist");
    expect(resolveEntries).not.toHaveBeenCalled();
  });

  it("re-prompts when token resolution returns unresolved entries", async () => {
    const prompter = createPrompter(["alice", "bob"]);
    const resolveEntries = vi
      .fn()
      .mockResolvedValueOnce([{ input: "alice", resolved: false }])
      .mockResolvedValueOnce([{ id: "U123", input: "bob", resolved: true }]);

    const result = await runPromptResolvedAllowFromWithToken({
      prompter,
      resolveEntries: asAllowFromResolver(resolveEntries),
    });

    expect(result).toEqual(["U123"]);
    expect(prompter.note).toHaveBeenCalledWith("Could not resolve: alice", "allowlist");
    expect(resolveEntries).toHaveBeenCalledTimes(2);
  });

  it("re-prompts when resolver throws before succeeding", async () => {
    const prompter = createPrompter(["alice", "bob"]);
    const resolveEntries = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce([{ id: "U234", input: "bob", resolved: true }]);

    const result = await runPromptResolvedAllowFromWithToken({
      prompter,
      resolveEntries: asAllowFromResolver(resolveEntries),
    });

    expect(result).toEqual(["U234"]);
    expect(prompter.note).toHaveBeenCalledWith(
      "Failed to resolve usernames. Try again.",
      "allowlist",
    );
    expect(resolveEntries).toHaveBeenCalledTimes(2);
  });
});

describe("promptLegacyChannelAllowFrom", () => {
  it("applies parsed ids without token resolution", async () => {
    const prompter = createPrompter([" 123 "]);
    const resolveEntries = vi.fn();

    const next = await runPromptLegacyAllowFrom({
      cfg: {} as OpenClawConfig,
      channel: "discord",
      existing: ["999"],
      noteLines: ["line1", "line2"],
      noteTitle: "Discord allowlist",
      parseId: (value) => (/^\d+$/.test(value.trim()) ? value.trim() : null),
      prompter,
      resolveEntries: asAllowFromResolver(resolveEntries),
      token: "",
    });

    expect(next.channels?.discord?.allowFrom).toEqual(["999", "123"]);
    expect(prompter.note).toHaveBeenCalledWith("line1\nline2", "Discord allowlist");
    expect(resolveEntries).not.toHaveBeenCalled();
  });

  it("uses resolver when token is present", async () => {
    const prompter = createPrompter(["alice"]);
    const resolveEntries = vi.fn(async () => [{ id: "U1", input: "alice", resolved: true }]);

    const next = await runPromptLegacyAllowFrom({
      cfg: {} as OpenClawConfig,
      channel: "slack",
      existing: [],
      noteLines: ["line"],
      noteTitle: "Slack allowlist",
      parseId: () => null,
      prompter,
      resolveEntries: asAllowFromResolver(resolveEntries),
      token: "xoxb-token",
    });

    expect(next.channels?.slack?.allowFrom).toEqual(["U1"]);
    expect(resolveEntries).toHaveBeenCalledWith({ entries: ["alice"], token: "xoxb-token" });
  });
});

describe("promptLegacyChannelAllowFromForAccount", () => {
  it("resolves the account before delegating to the shared prompt flow", async () => {
    const prompter = createPrompter(["alice"]);

    const next = await promptLegacyChannelAllowFromForAccount({
      cfg: {
        channels: {
          slack: {
            dm: {
              allowFrom: ["U0"],
            },
          },
        },
      } as OpenClawConfig,
      channel: "slack",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      invalidWithoutTokenNote: "need ids",
      message: "Slack allowFrom",
      noteLines: ["line"],
      noteTitle: "Slack allowlist",
      parseId: () => null,
      placeholder: "@alice",
      prompter: prompter as any,
      resolveAccount: () => ({
        botToken: "xoxb-token",
        dmAllowFrom: ["U0"],
      }),
      resolveEntries: async ({ entries }) =>
        entries.map((input) => ({ id: input.toUpperCase(), input, resolved: true })),
      resolveExisting: (account) => account.dmAllowFrom,
      resolveToken: (account) => account.botToken,
    });

    expect(next.channels?.slack?.allowFrom).toEqual(["U0", "ALICE"]);
    expect(prompter.note).toHaveBeenCalledWith("line", "Slack allowlist");
  });
});

describe("promptSingleChannelToken", () => {
  it.each([
    {
      confirms: [true],
      expectTextCalls: 0,
      expected: { token: null, useEnv: true },
      name: "uses env tokens when confirmed",
      state: {
        accountConfigured: false,
        canUseEnv: true,
        hasConfigToken: false,
      },
      texts: [],
    },
    {
      confirms: [false],
      expectTextCalls: 1,
      expected: { token: "abc", useEnv: false },
      name: "prompts for token when env exists but user declines env",
      state: {
        accountConfigured: false,
        canUseEnv: true,
        hasConfigToken: false,
      },
      texts: ["abc"],
    },
    {
      confirms: [true],
      expectTextCalls: 0,
      expected: { token: null, useEnv: false },
      name: "keeps existing configured token when confirmed",
      state: {
        accountConfigured: true,
        canUseEnv: false,
        hasConfigToken: true,
      },
      texts: [],
    },
    {
      confirms: [false],
      expectTextCalls: 1,
      expected: { token: "xyz", useEnv: false },
      name: "prompts for token when no env/config token is used",
      state: {
        accountConfigured: true,
        canUseEnv: false,
        hasConfigToken: false,
      },
      texts: ["xyz"],
    },
  ])("$name", async ({ confirms, texts, state, expected, expectTextCalls }) => {
    const prompter = createTokenPrompter({ confirms, texts });
    const result = await runPromptSingleToken({
      prompter,
      ...state,
    });
    expect(result).toEqual(expected);
    expect(prompter.text).toHaveBeenCalledTimes(expectTextCalls);
  });
});

describe("promptSingleChannelSecretInput", () => {
  it("returns use-env action when plaintext mode selects env fallback", async () => {
    const prompter = createSecretInputPrompter({
      confirms: [true],
      selects: ["plaintext"],
    });

    const result = await runPromptSingleChannelSecretInput({
      accountConfigured: false,
      canUseEnv: true,
      credentialLabel: "Telegram bot token",
      hasConfigToken: false,
      preferredEnvVar: "TELEGRAM_BOT_TOKEN",
      prompter,
      providerHint: "telegram",
    });

    expect(result).toEqual({ action: "use-env" });
  });

  it("returns ref + resolved value when external env ref is selected", async () => {
    process.env.OPENCLAW_TEST_TOKEN = "secret-token";
    const prompter = createSecretInputPrompter({
      selects: ["ref", "env"],
      texts: ["OPENCLAW_TEST_TOKEN"],
    });

    const result = await runPromptSingleChannelSecretInput({
      accountConfigured: false,
      canUseEnv: false,
      credentialLabel: "Discord bot token",
      hasConfigToken: false,
      preferredEnvVar: "OPENCLAW_TEST_TOKEN",
      prompter,
      providerHint: "discord",
    });

    expect(result).toEqual({
      action: "set",
      resolvedValue: "secret-token",
      value: {
        id: "OPENCLAW_TEST_TOKEN",
        provider: "default",
        source: "env",
      },
    });
  });

  it("returns keep action when ref mode keeps an existing configured ref", async () => {
    const prompter = createSecretInputPrompter({
      confirms: [true],
      selects: ["ref"],
    });

    const result = await runPromptSingleChannelSecretInput({
      accountConfigured: true,
      canUseEnv: false,
      credentialLabel: "Telegram bot token",
      hasConfigToken: true,
      preferredEnvVar: "TELEGRAM_BOT_TOKEN",
      prompter,
      providerHint: "telegram",
    });

    expect(result).toEqual({ action: "keep" });
    expect(prompter.text).not.toHaveBeenCalled();
  });
});

describe("applySingleTokenPromptResult", () => {
  it("writes env selection as an empty patch on target account", () => {
    const next = applySingleTokenPromptResult({
      accountId: "work",
      cfg: {},
      channel: "discord",
      tokenPatchKey: "token",
      tokenResult: { token: null, useEnv: true },
    });

    expect(next.channels?.discord?.enabled).toBe(true);
    expect(next.channels?.discord?.accounts?.work?.enabled).toBe(true);
    expect(next.channels?.discord?.accounts?.work?.token).toBeUndefined();
  });

  it("writes provided token under requested key", () => {
    const next = applySingleTokenPromptResult({
      accountId: DEFAULT_ACCOUNT_ID,
      cfg: {},
      channel: "telegram",
      tokenPatchKey: "botToken",
      tokenResult: { token: "abc", useEnv: false },
    });

    expect(next.channels?.telegram?.enabled).toBe(true);
    expect(next.channels?.telegram?.botToken).toBe("abc");
  });
});

describe("promptParsedAllowFromForScopedChannel", () => {
  it("writes parsed allowFrom values to default account channel config", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          allowFrom: ["old"],
        },
      },
    };
    const prompter = createPrompter([" Alice, ALICE "]);

    const next = await promptParsedAllowFromForScopedChannel({
      cfg,
      channel: "imessage",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      getExistingAllowFrom: ({ cfg }) => cfg.channels?.imessage?.allowFrom ?? [],
      message: "msg",
      noteLines: ["line1", "line2"],
      noteTitle: "iMessage allowlist",
      parseEntries: (raw) =>
        parseSetupEntriesWithParser(raw, (entry) => ({ value: entry.toLowerCase() })),
      placeholder: "placeholder",
      prompter,
    });

    expect(next.channels?.imessage?.allowFrom).toEqual(["alice"]);
    expect(prompter.note).toHaveBeenCalledWith("line1\nline2", "iMessage allowlist");
  });

  it("writes parsed values to non-default account allowFrom", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            alt: {
              allowFrom: ["+15555550123"],
            },
          },
        },
      },
    };
    const prompter = createPrompter(["+15555550124"]);

    const next = await promptParsedAllowFromForScopedChannel({
      accountId: "alt",
      cfg,
      channel: "signal",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      getExistingAllowFrom: ({ cfg, accountId }) =>
        cfg.channels?.signal?.accounts?.[accountId]?.allowFrom ?? [],
      message: "msg",
      noteLines: ["line"],
      noteTitle: "Signal allowlist",
      parseEntries: (raw) => ({ entries: [raw.trim()] }),
      placeholder: "placeholder",
      prompter,
    });

    expect(next.channels?.signal?.accounts?.alt?.allowFrom).toEqual(["+15555550124"]);
    expect(next.channels?.signal?.allowFrom).toBeUndefined();
  });

  it("uses parser validation from the prompt validate callback", async () => {
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async (params: { validate?: (value: string) => string | undefined }) => {
        expect(params.validate?.("")).toBe("Required");
        expect(params.validate?.("bad")).toBe("bad entry");
        expect(params.validate?.("ok")).toBeUndefined();
        return "ok";
      }),
    };

    const next = await promptParsedAllowFromForScopedChannel({
      cfg: {},
      channel: "imessage",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      getExistingAllowFrom: () => [],
      message: "msg",
      noteLines: ["line"],
      noteTitle: "title",
      parseEntries: (raw) =>
        raw.trim() === "bad"
          ? { entries: [], error: "bad entry" }
          : { entries: [raw.trim().toLowerCase()] },
      placeholder: "placeholder",
      prompter,
    });

    expect(next.channels?.imessage?.allowFrom).toEqual(["ok"]);
  });
});

describe("promptParsedAllowFromForAccount", () => {
  it("applies parsed allowFrom values through the provided writer", async () => {
    const prompter = createPrompter(["Alice, ALICE"]);

    const next = await promptParsedAllowFromForAccount({
      accountId: "alt",
      applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
        patchChannelConfigForAccount({
          accountId,
          cfg,
          channel: "bluebubbles",
          patch: { allowFrom },
        }),
      cfg: {
        channels: {
          bluebubbles: {
            accounts: {
              alt: {
                allowFrom: ["old"],
              },
            },
          },
        },
      } as OpenClawConfig,
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      getExistingAllowFrom: ({ cfg, accountId }) => [
        ...((
          cfg.channels?.bluebubbles?.accounts?.[accountId] as
            | { allowFrom?: readonly (string | number)[] }
            | undefined
        )?.allowFrom ?? []),
      ],
      message: "msg",
      noteLines: ["line"],
      noteTitle: "BlueBubbles allowlist",
      parseEntries: (raw) =>
        parseSetupEntriesWithParser(raw, (entry) => ({ value: entry.toLowerCase() })),
      placeholder: "placeholder",
      prompter,
    });

    expect(
      (
        next.channels?.bluebubbles?.accounts?.alt as
          | { allowFrom?: readonly (string | number)[] }
          | undefined
      )?.allowFrom,
    ).toEqual(["alice"]);
    expect(prompter.note).toHaveBeenCalledWith("line", "BlueBubbles allowlist");
  });

  it("can merge parsed values with existing entries", async () => {
    const next = await promptParsedAllowFromForAccount({
      applyAllowFrom: ({ cfg, allowFrom }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel: "nostr",
          patch: { allowFrom },
        }),
      cfg: {
        channels: {
          nostr: {
            allowFrom: ["old"],
          },
        },
      } as OpenClawConfig,
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      getExistingAllowFrom: ({ cfg }) => [...(cfg.channels?.nostr?.allowFrom ?? [])],
      mergeEntries: ({ existing, parsed }) => [...existing.map(String), ...parsed],
      message: "msg",
      noteLines: ["line"],
      noteTitle: "Nostr allowlist",
      parseEntries: (raw) => ({ entries: [raw.trim()] }),
      placeholder: "placeholder",
      prompter: createPrompter(["new"]),
    });

    expect(next.channels?.nostr?.allowFrom).toEqual(["old", "new"]);
  });
});

describe("createPromptParsedAllowFromForAccount", () => {
  it("supports computed default account ids and optional notes", async () => {
    const promptAllowFrom = createPromptParsedAllowFromForAccount<OpenClawConfig>({
      applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
        patchChannelConfigForAccount({
          accountId,
          cfg,
          channel: "bluebubbles",
          patch: { allowFrom },
        }),
      defaultAccountId: () => "work",
      getExistingAllowFrom: ({ cfg, accountId }) => [
        ...((
          cfg.channels?.bluebubbles?.accounts?.[accountId] as
            | { allowFrom?: readonly (string | number)[] }
            | undefined
        )?.allowFrom ?? []),
      ],
      message: "msg",
      parseEntries: (raw) => ({ entries: [raw.trim().toLowerCase()] }),
      placeholder: "placeholder",
    });

    const prompter = createPrompter(["Alice"]);
    const next = await promptAllowFrom({
      cfg: {
        channels: {
          bluebubbles: {
            accounts: {
              work: {
                allowFrom: ["old"],
              },
            },
          },
        },
      },
      prompter: prompter as any,
    });

    expect(
      (
        next.channels?.bluebubbles?.accounts?.work as
          | { allowFrom?: readonly (string | number)[] }
          | undefined
      )?.allowFrom,
    ).toEqual(["alice"]);
    expect(prompter.note).not.toHaveBeenCalled();
  });
});

describe("parsed allowFrom prompt builders", () => {
  it("builds a top-level parsed allowFrom prompt", async () => {
    const promptAllowFrom = createTopLevelChannelParsedAllowFromPrompt({
      channel: "nostr",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      message: "msg",
      noteLines: ["line"],
      noteTitle: "Nostr allowlist",
      parseEntries: (raw) => ({ entries: [raw.trim().toLowerCase()] }),
      placeholder: "placeholder",
    });

    const prompter = createPrompter(["npub1"]);
    const next = await promptAllowFrom({
      cfg: {},
      prompter: prompter as any,
    });

    expect(next.channels?.nostr?.allowFrom).toEqual(["npub1"]);
    expect(prompter.note).toHaveBeenCalledWith("line", "Nostr allowlist");
  });

  it("builds a nested parsed allowFrom prompt", async () => {
    const promptAllowFrom = createNestedChannelParsedAllowFromPrompt({
      channel: "googlechat",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      enabled: true,
      message: "msg",
      parseEntries: (raw) => ({ entries: [raw.trim()] }),
      placeholder: "placeholder",
      section: "dm",
    });

    const next = await promptAllowFrom({
      cfg: {},
      prompter: createPrompter(["users/123"]) as any,
    });

    expect(next.channels?.googlechat?.enabled).toBe(true);
    expect(next.channels?.googlechat?.dm?.allowFrom).toEqual(["users/123"]);
  });
});

describe("channel lookup note helpers", () => {
  it("emits summary lines for resolved and unresolved entries", async () => {
    const prompter = { note: vi.fn(async () => undefined) };
    await noteChannelLookupSummary({
      label: "Slack channels",
      prompter,
      resolvedSections: [
        { title: "Resolved", values: ["C1", "C2"] },
        { title: "Resolved guilds", values: [] },
      ],
      unresolved: ["#typed-name"],
    });
    expect(prompter.note).toHaveBeenCalledWith(
      "Resolved: C1, C2\nUnresolved (kept as typed): #typed-name",
      "Slack channels",
    );
  });

  it("skips note output when there is nothing to report", async () => {
    const prompter = { note: vi.fn(async () => undefined) };
    await noteChannelLookupSummary({
      label: "Discord channels",
      prompter,
      resolvedSections: [{ title: "Resolved", values: [] }],
      unresolved: [],
    });
    expect(prompter.note).not.toHaveBeenCalled();
  });

  it("formats lookup failures consistently", async () => {
    const prompter = { note: vi.fn(async () => undefined) };
    await noteChannelLookupFailure({
      error: new Error("boom"),
      label: "Discord channels",
      prompter,
    });
    expect(prompter.note).toHaveBeenCalledWith(
      "Channel lookup failed; keeping entries as typed. Error: boom",
      "Discord channels",
    );
  });
});

describe("setAccountAllowFromForChannel", () => {
  it("writes allowFrom on default account channel config", () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          accounts: {
            work: { allowFrom: ["work-old"] },
          },
          allowFrom: ["old"],
          enabled: true,
        },
      },
    };

    const next = setAccountAllowFromForChannel({
      accountId: DEFAULT_ACCOUNT_ID,
      allowFrom: ["new-default"],
      cfg,
      channel: "imessage",
    });

    expect(next.channels?.imessage?.allowFrom).toEqual(["new-default"]);
    expect(next.channels?.imessage?.accounts?.work?.allowFrom).toEqual(["work-old"]);
  });

  it("writes allowFrom on nested non-default account config", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            alt: { account: "+15555550123", allowFrom: ["alt-old"], enabled: true },
          },
          allowFrom: ["default-old"],
          enabled: true,
        },
      },
    };

    const next = setAccountAllowFromForChannel({
      accountId: "alt",
      allowFrom: ["alt-new"],
      cfg,
      channel: "signal",
    });

    expect(next.channels?.signal?.allowFrom).toEqual(["default-old"]);
    expect(next.channels?.signal?.accounts?.alt?.allowFrom).toEqual(["alt-new"]);
    expect(next.channels?.signal?.accounts?.alt?.account).toBe("+15555550123");
  });
});

describe("patchChannelConfigForAccount", () => {
  it("patches root channel config for default account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          botToken: "old",
          enabled: false,
        },
      },
    };

    const next = patchChannelConfigForAccount({
      accountId: DEFAULT_ACCOUNT_ID,
      cfg,
      channel: "telegram",
      patch: { botToken: "new", dmPolicy: "allowlist" },
    });

    expect(next.channels?.telegram?.enabled).toBe(true);
    expect(next.channels?.telegram?.botToken).toBe("new");
    expect(next.channels?.telegram?.dmPolicy).toBe("allowlist");
  });

  it("patches nested account config and preserves existing enabled flag", () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          accounts: {
            work: {
              botToken: "old-bot",
              enabled: false,
            },
          },
          enabled: true,
        },
      },
    };

    const next = patchChannelConfigForAccount({
      accountId: "work",
      cfg,
      channel: "slack",
      patch: { appToken: "new-app", botToken: "new-bot" },
    });

    expect(next.channels?.slack?.enabled).toBe(true);
    expect(next.channels?.slack?.accounts?.work?.enabled).toBe(false);
    expect(next.channels?.slack?.accounts?.work?.botToken).toBe("new-bot");
    expect(next.channels?.slack?.accounts?.work?.appToken).toBe("new-app");
  });

  it("moves single-account config into default account when patching non-default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          allowFrom: ["100"],
          botToken: "legacy-token",
          enabled: true,
          groupPolicy: "allowlist",
          streaming: { mode: "partial" },
        },
      },
    };

    const next = patchChannelConfigForAccount({
      accountId: "work",
      cfg,
      channel: "telegram",
      patch: { botToken: "work-token" },
    });

    expect(next.channels?.telegram?.accounts?.default).toEqual({
      allowFrom: ["100"],
      botToken: "legacy-token",
      groupPolicy: "allowlist",
      streaming: { mode: "partial" },
    });
    expect(next.channels?.telegram?.botToken).toBeUndefined();
    expect(next.channels?.telegram?.allowFrom).toBeUndefined();
    expect(next.channels?.telegram?.groupPolicy).toBeUndefined();
    expect(next.channels?.telegram?.streaming).toBeUndefined();
    expect(next.channels?.telegram?.accounts?.work?.botToken).toBe("work-token");
  });

  it("supports imessage/signal account-scoped channel patches", () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          enabled: false,
        },
        signal: {
          accounts: {},
          enabled: false,
        },
      },
    };

    const signalNext = patchChannelConfigForAccount({
      accountId: "work",
      cfg,
      channel: "signal",
      patch: { account: "+15555550123", cliPath: "signal-cli" },
    });
    expect(signalNext.channels?.signal?.enabled).toBe(true);
    expect(signalNext.channels?.signal?.accounts?.work?.enabled).toBe(true);
    expect(signalNext.channels?.signal?.accounts?.work?.account).toBe("+15555550123");

    const imessageNext = patchChannelConfigForAccount({
      accountId: DEFAULT_ACCOUNT_ID,
      cfg: signalNext,
      channel: "imessage",
      patch: { cliPath: "imsg" },
    });
    expect(imessageNext.channels?.imessage?.enabled).toBe(true);
    expect(imessageNext.channels?.imessage?.cliPath).toBe("imsg");
  });
});

describe("setSetupChannelEnabled", () => {
  it("updates enabled and keeps existing channel fields", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          enabled: true,
          token: "abc",
        },
      },
    };

    const next = setSetupChannelEnabled(cfg, "discord", false);
    expect(next.channels?.discord?.enabled).toBe(false);
    expect(next.channels?.discord?.token).toBe("abc");
  });

  it("creates missing channel config with enabled state", () => {
    const next = setSetupChannelEnabled({}, "signal", true);
    expect(next.channels?.signal?.enabled).toBe(true);
  });
});

describe("patchLegacyDmChannelConfig", () => {
  it("patches discord root config and defaults dm.enabled to true", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          dmPolicy: "pairing",
        },
      },
    };

    const next = patchLegacyDmChannelConfig({
      cfg,
      channel: "discord",
      patch: { allowFrom: ["123"] },
    });
    expect(next.channels?.discord?.allowFrom).toEqual(["123"]);
    expect(next.channels?.discord?.dm?.enabled).toBe(true);
  });

  it("preserves explicit dm.enabled=false for slack", () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          dm: {
            enabled: false,
          },
        },
      },
    };

    const next = patchLegacyDmChannelConfig({
      cfg,
      channel: "slack",
      patch: { dmPolicy: "open" },
    });
    expect(next.channels?.slack?.dmPolicy).toBe("open");
    expect(next.channels?.slack?.dm?.enabled).toBe(false);
  });
});

describe("setLegacyChannelDmPolicyWithAllowFrom", () => {
  it("adds wildcard allowFrom for open policy using legacy dm allowFrom fallback", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          dm: {
            allowFrom: ["123"],
            enabled: false,
          },
        },
      },
    };

    const next = setLegacyChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "discord",
      dmPolicy: "open",
    });
    expect(next.channels?.discord?.dmPolicy).toBe("open");
    expect(next.channels?.discord?.allowFrom).toEqual(["123", "*"]);
    expect(next.channels?.discord?.dm?.enabled).toBe(false);
  });

  it("sets policy without changing allowFrom when not open", () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          allowFrom: ["U1"],
        },
      },
    };

    const next = setLegacyChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "slack",
      dmPolicy: "pairing",
    });
    expect(next.channels?.slack?.dmPolicy).toBe("pairing");
    expect(next.channels?.slack?.allowFrom).toEqual(["U1"]);
  });
});

describe("setLegacyChannelAllowFrom", () => {
  it("writes allowFrom through legacy dm patching", () => {
    const next = setLegacyChannelAllowFrom({
      allowFrom: ["U123"],
      cfg: {},
      channel: "slack",
    });
    expect(next.channels?.slack?.allowFrom).toEqual(["U123"]);
    expect(next.channels?.slack?.dm?.enabled).toBe(true);
  });
});

describe("setAccountGroupPolicyForChannel", () => {
  it("writes group policy on default account config", () => {
    const next = setAccountGroupPolicyForChannel({
      accountId: DEFAULT_ACCOUNT_ID,
      cfg: {},
      channel: "discord",
      groupPolicy: "open",
    });
    expect(next.channels?.discord?.groupPolicy).toBe("open");
    expect(next.channels?.discord?.enabled).toBe(true);
  });

  it("writes group policy on nested non-default account", () => {
    const next = setAccountGroupPolicyForChannel({
      accountId: "work",
      cfg: {},
      channel: "slack",
      groupPolicy: "disabled",
    });
    expect(next.channels?.slack?.accounts?.work?.groupPolicy).toBe("disabled");
    expect(next.channels?.slack?.accounts?.work?.enabled).toBe(true);
  });
});

describe("setChannelDmPolicyWithAllowFrom", () => {
  it("adds wildcard allowFrom when setting dmPolicy=open", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          allowFrom: ["+15555550123"],
          dmPolicy: "pairing",
        },
      },
    };

    const next = setChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "signal",
      dmPolicy: "open",
    });

    expect(next.channels?.signal?.dmPolicy).toBe("open");
    expect(next.channels?.signal?.allowFrom).toEqual(["+15555550123", "*"]);
  });

  it("sets dmPolicy without changing allowFrom for non-open policies", () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          allowFrom: ["*"],
          dmPolicy: "open",
        },
      },
    };

    const next = setChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "imessage",
      dmPolicy: "pairing",
    });

    expect(next.channels?.imessage?.dmPolicy).toBe("pairing");
    expect(next.channels?.imessage?.allowFrom).toEqual(["*"]);
  });

  it("supports telegram channel dmPolicy updates", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          allowFrom: ["123"],
          dmPolicy: "pairing",
        },
      },
    };

    const next = setChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "telegram",
      dmPolicy: "open",
    });
    expect(next.channels?.telegram?.dmPolicy).toBe("open");
    expect(next.channels?.telegram?.allowFrom).toEqual(["123", "*"]);
  });
});

describe("setTopLevelChannelDmPolicyWithAllowFrom", () => {
  it("adds wildcard allowFrom for open policy", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zalo: {
          allowFrom: ["12345"],
          dmPolicy: "pairing",
        },
      },
    };

    const next = setTopLevelChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "zalo",
      dmPolicy: "open",
    });
    expect(next.channels?.zalo?.dmPolicy).toBe("open");
    expect(next.channels?.zalo?.allowFrom).toEqual(["12345", "*"]);
  });

  it("supports custom allowFrom lookup callback", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          allowFrom: ["alice"],
          dmPolicy: "pairing",
        },
      },
    };

    const next = setTopLevelChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "nextcloud-talk",
      dmPolicy: "open",
      getAllowFrom: (inputCfg) =>
        normalizeAllowFromEntries([...(inputCfg.channels?.["nextcloud-talk"]?.allowFrom ?? [])]),
    });
    expect(next.channels?.["nextcloud-talk"]?.allowFrom).toEqual(["alice", "*"]);
  });
});

describe("setTopLevelChannelAllowFrom", () => {
  it("writes allowFrom and can force enabled state", () => {
    const next = setTopLevelChannelAllowFrom({
      allowFrom: ["user-1"],
      cfg: {},
      channel: "msteams",
      enabled: true,
    });
    expect(next.channels?.msteams?.allowFrom).toEqual(["user-1"]);
    expect(next.channels?.msteams?.enabled).toBe(true);
  });
});

describe("setTopLevelChannelGroupPolicy", () => {
  it("writes groupPolicy and can force enabled state", () => {
    const next = setTopLevelChannelGroupPolicy({
      cfg: {},
      channel: "feishu",
      enabled: true,
      groupPolicy: "allowlist",
    });
    expect(next.channels?.feishu?.groupPolicy).toBe("allowlist");
    expect(next.channels?.feishu?.enabled).toBe(true);
  });
});

describe("patchTopLevelChannelConfigSection", () => {
  it("clears requested fields before applying a patch", () => {
    const next = patchTopLevelChannelConfigSection({
      cfg: {
        channels: {
          nostr: {
            privateKey: "nsec1",
            relays: ["wss://old.example"],
          },
        },
      },
      channel: "nostr",
      clearFields: ["privateKey"],
      enabled: true,
      patch: { relays: ["wss://new.example"] },
    });

    expect(next.channels?.nostr?.privateKey).toBeUndefined();
    expect(next.channels?.nostr?.relays).toEqual(["wss://new.example"]);
    expect(next.channels?.nostr?.enabled).toBe(true);
  });
});

describe("patchNestedChannelConfigSection", () => {
  it("clears requested nested fields before applying a patch", () => {
    const next = patchNestedChannelConfigSection({
      cfg: {
        channels: {
          matrix: {
            dm: {
              allowFrom: ["@alice:example.org"],
              policy: "pairing",
            },
          },
        },
      },
      channel: "matrix",
      clearFields: ["allowFrom"],
      enabled: true,
      patch: { policy: "disabled" as const },
      section: "dm",
    });

    expect(next.channels?.matrix?.enabled).toBe(true);
    expect(next.channels?.matrix?.dm?.policy).toBe("disabled");
    expect(next.channels?.matrix?.dm?.allowFrom).toBeUndefined();
  });
});

describe("createTopLevelChannelDmPolicy", () => {
  it("creates a reusable dm policy definition", () => {
    const dmPolicy = createTopLevelChannelDmPolicy({
      allowFromKey: "channels.line.allowFrom",
      channel: "line",
      getCurrent: (cfg) =>
        (cfg.channels?.line?.dmPolicy as
          | "open"
          | "pairing"
          | "allowlist"
          | "disabled"
          | undefined) ?? "pairing",
      label: "LINE",
      policyKey: "channels.line.dmPolicy",
    });

    const next = dmPolicy.setPolicy(
      {
        channels: {
          line: {
            allowFrom: ["U123"],
            dmPolicy: "pairing",
          },
        },
      },
      "open",
    );

    expect(dmPolicy.getCurrent({})).toBe("pairing");
    expect(next.channels?.line?.dmPolicy).toBe("open");
    expect(next.channels?.line?.allowFrom).toEqual(["U123", "*"]);
  });
});

describe("createTopLevelChannelDmPolicySetter", () => {
  it("reuses the shared top-level dmPolicy writer", () => {
    const setPolicy = createTopLevelChannelDmPolicySetter({
      channel: "zalo",
    });
    const next = setPolicy(
      {
        channels: {
          zalo: {
            allowFrom: ["12345"],
          },
        },
      },
      "open",
    );

    expect(next.channels?.zalo?.dmPolicy).toBe("open");
    expect(next.channels?.zalo?.allowFrom).toEqual(["12345", "*"]);
  });
});

describe("setNestedChannelAllowFrom", () => {
  it("writes nested allowFrom and can force enabled state", () => {
    const next = setNestedChannelAllowFrom({
      allowFrom: ["users/123"],
      cfg: {},
      channel: "googlechat",
      enabled: true,
      section: "dm",
    });

    expect(next.channels?.googlechat?.enabled).toBe(true);
    expect(next.channels?.googlechat?.dm?.allowFrom).toEqual(["users/123"]);
  });
});

describe("setNestedChannelDmPolicyWithAllowFrom", () => {
  it("adds wildcard allowFrom for open policy inside a nested section", () => {
    const next = setNestedChannelDmPolicyWithAllowFrom({
      cfg: {
        channels: {
          matrix: {
            dm: {
              allowFrom: ["@alice:example.org"],
              policy: "pairing",
            },
          },
        },
      },
      channel: "matrix",
      dmPolicy: "open",
      enabled: true,
      section: "dm",
    });

    expect(next.channels?.matrix?.enabled).toBe(true);
    expect(next.channels?.matrix?.dm?.policy).toBe("open");
    expect(next.channels?.matrix?.dm?.allowFrom).toEqual(["@alice:example.org", "*"]);
  });
});

describe("createNestedChannelDmPolicy", () => {
  it("creates a reusable nested dm policy definition", () => {
    const dmPolicy = createNestedChannelDmPolicy({
      allowFromKey: "channels.matrix.dm.allowFrom",
      channel: "matrix",
      enabled: true,
      getCurrent: (cfg) =>
        (
          cfg.channels?.matrix?.dm as
            | { policy?: "open" | "pairing" | "allowlist" | "disabled" }
            | undefined
        )?.policy ?? "pairing",
      label: "Matrix",
      policyKey: "channels.matrix.dm.policy",
      section: "dm",
    });

    const next = dmPolicy.setPolicy(
      {
        channels: {
          matrix: {
            dm: {
              allowFrom: ["@alice:example.org"],
            },
          },
        },
      },
      "open",
    );

    expect(next.channels?.matrix?.enabled).toBe(true);
    expect(next.channels?.matrix?.dm?.policy).toBe("open");
    expect(next.channels?.matrix?.dm?.allowFrom).toEqual(["@alice:example.org", "*"]);
  });
});

describe("createNestedChannelDmPolicySetter", () => {
  it("reuses the shared nested dmPolicy writer", () => {
    const setPolicy = createNestedChannelDmPolicySetter({
      channel: "googlechat",
      enabled: true,
      section: "dm",
    });
    const next = setPolicy({}, "disabled");

    expect(next.channels?.googlechat?.enabled).toBe(true);
    expect(next.channels?.googlechat?.dm?.policy).toBe("disabled");
  });
});

describe("createNestedChannelAllowFromSetter", () => {
  it("reuses the shared nested allowFrom writer", () => {
    const setAllowFrom = createNestedChannelAllowFromSetter({
      channel: "googlechat",
      enabled: true,
      section: "dm",
    });
    const next = setAllowFrom({}, ["users/123"]);

    expect(next.channels?.googlechat?.enabled).toBe(true);
    expect(next.channels?.googlechat?.dm?.allowFrom).toEqual(["users/123"]);
  });
});

describe("createTopLevelChannelAllowFromSetter", () => {
  it("reuses the shared top-level allowFrom writer", () => {
    const setAllowFrom = createTopLevelChannelAllowFromSetter({
      channel: "msteams",
      enabled: true,
    });
    const next = setAllowFrom({}, ["user-1"]);

    expect(next.channels?.msteams?.allowFrom).toEqual(["user-1"]);
    expect(next.channels?.msteams?.enabled).toBe(true);
  });
});

describe("createLegacyCompatChannelDmPolicy", () => {
  it("reads nested legacy dm policy and writes top-level compat fields", () => {
    const dmPolicy = createLegacyCompatChannelDmPolicy({
      channel: "slack",
      label: "Slack",
    });

    expect(
      dmPolicy.getCurrent({
        channels: {
          slack: {
            dm: {
              policy: "open",
            },
          },
        },
      }),
    ).toBe("open");

    const next = dmPolicy.setPolicy(
      {
        channels: {
          slack: {
            dm: {
              allowFrom: ["U123"],
            },
          },
        },
      },
      "open",
    );

    expect(next.channels?.slack?.dmPolicy).toBe("open");
    expect(next.channels?.slack?.allowFrom).toEqual(["U123", "*"]);
  });

  it("honors named-account dm policy state and paths", () => {
    const dmPolicy = createLegacyCompatChannelDmPolicy({
      channel: "slack",
      label: "Slack",
    });

    expect(
      dmPolicy.getCurrent(
        {
          channels: {
            slack: {
              accounts: {
                alerts: {
                  dmPolicy: "allowlist",
                },
              },
              dmPolicy: "disabled",
            },
          },
        },
        "alerts",
      ),
    ).toBe("allowlist");

    expect(dmPolicy.resolveConfigKeys?.({}, "alerts")).toEqual({
      allowFromKey: "channels.slack.accounts.alerts.allowFrom",
      policyKey: "channels.slack.accounts.alerts.dmPolicy",
    });

    const next = dmPolicy.setPolicy(
      {
        channels: {
          slack: {
            accounts: {
              alerts: {},
            },
            allowFrom: ["U123"],
          },
        },
      },
      "open",
      "alerts",
    );

    expect(next.channels?.slack?.dmPolicy).toBeUndefined();
    expect(next.channels?.slack?.accounts?.alerts?.dmPolicy).toBe("open");
    expect(next.channels?.slack?.accounts?.alerts?.allowFrom).toEqual(["U123", "*"]);
  });
});

describe("createTopLevelChannelGroupPolicySetter", () => {
  it("reuses the shared top-level groupPolicy writer", () => {
    const setGroupPolicy = createTopLevelChannelGroupPolicySetter({
      channel: "feishu",
      enabled: true,
    });
    const next = setGroupPolicy({}, "allowlist");

    expect(next.channels?.feishu?.groupPolicy).toBe("allowlist");
    expect(next.channels?.feishu?.enabled).toBe(true);
  });
});

describe("setAccountDmAllowFromForChannel", () => {
  it("writes account-scoped allowlist dm config", () => {
    const next = setAccountDmAllowFromForChannel({
      accountId: DEFAULT_ACCOUNT_ID,
      allowFrom: ["123"],
      cfg: {},
      channel: "discord",
    });

    expect(next.channels?.discord?.dmPolicy).toBe("allowlist");
    expect(next.channels?.discord?.allowFrom).toEqual(["123"]);
  });
});

describe("resolveGroupAllowlistWithLookupNotes", () => {
  it("returns resolved values when lookup succeeds", async () => {
    const prompter = createPrompter([]);
    await expect(
      resolveGroupAllowlistWithLookupNotes({
        entries: ["general"],
        fallback: [],
        label: "Discord channels",
        prompter,
        resolve: async () => ["guild/channel"],
      }),
    ).resolves.toEqual(["guild/channel"]);
    expect(prompter.note).not.toHaveBeenCalled();
  });

  it("notes lookup failure and returns the fallback", async () => {
    const prompter = createPrompter([]);
    await expect(
      resolveGroupAllowlistWithLookupNotes({
        entries: ["general"],
        fallback: ["general"],
        label: "Slack channels",
        prompter,
        resolve: async () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toEqual(["general"]);
    expect(prompter.note).toHaveBeenCalledTimes(2);
  });
});

describe("createAccountScopedAllowFromSection", () => {
  it("builds an account-scoped allowFrom section with shared apply wiring", async () => {
    const section = createAccountScopedAllowFromSection({
      channel: "discord",
      credentialInputKey: "token",
      invalidWithoutCredentialNote: "need ids",
      message: "Discord allowFrom",
      parseId: (value) => value.trim() || null,
      placeholder: "@alice",
      resolveEntries: async ({ entries }) =>
        entries.map((input) => ({ id: input.toUpperCase(), input, resolved: true })),
    });

    expect(section.credentialInputKey).toBe("token");
    await expect(
      resolveSetupWizardAllowFromEntries({
        accountId: DEFAULT_ACCOUNT_ID,
        entries: ["alice"],
        resolveEntries: section.resolveEntries,
      }),
    ).resolves.toEqual([{ id: "ALICE", input: "alice", resolved: true }]);

    const next = await section.apply({
      accountId: DEFAULT_ACCOUNT_ID,
      allowFrom: ["123"],
      cfg: {},
    });

    expect(next.channels?.discord?.dmPolicy).toBe("allowlist");
    expect(next.channels?.discord?.allowFrom).toEqual(["123"]);
  });
});

describe("createAllowFromSection", () => {
  it("builds a parsed allowFrom section with default local resolution", async () => {
    const section = createAllowFromSection({
      apply: ({ cfg, accountId, allowFrom }) =>
        patchChannelConfigForAccount({
          accountId,
          cfg,
          channel: "line",
          patch: { allowFrom, dmPolicy: "allowlist" },
        }),
      credentialInputKey: "token",
      helpLines: ["line"],
      helpTitle: "LINE allowlist",
      invalidWithoutCredentialNote: "need ids",
      message: "LINE allowFrom",
      parseId: (value) => value.trim().toUpperCase() || null,
      placeholder: "U123",
    });

    expect(section.helpTitle).toBe("LINE allowlist");
    await expect(
      resolveSetupWizardAllowFromEntries({
        accountId: DEFAULT_ACCOUNT_ID,
        entries: ["u1"],
        resolveEntries: section.resolveEntries,
      }),
    ).resolves.toEqual([{ id: "U1", input: "u1", resolved: true }]);

    const next = await section.apply({
      accountId: DEFAULT_ACCOUNT_ID,
      allowFrom: ["U1"],
      cfg: {},
    });
    expect(next.channels?.line?.allowFrom).toEqual(["U1"]);
  });
});

describe("createAccountScopedGroupAccessSection", () => {
  it("builds group access with shared setPolicy and fallback lookup notes", async () => {
    const prompter = createPrompter([]);
    const section = createAccountScopedGroupAccessSection({
      applyAllowlist: ({ cfg, resolved, accountId }) =>
        patchChannelConfigForAccount({
          accountId,
          cfg,
          channel: "slack",
          patch: {
            channels: Object.fromEntries(resolved.map((entry) => [entry, { allow: true }])),
          },
        }),
      channel: "slack",
      currentEntries: () => [],
      currentPolicy: () => "allowlist",
      fallbackResolved: (entries) => entries,
      label: "Slack channels",
      placeholder: "#general",
      resolveAllowlist: async () => {
        throw new Error("boom");
      },
      updatePrompt: () => false,
    });

    const policyNext = section.setPolicy({
      accountId: DEFAULT_ACCOUNT_ID,
      cfg: {},
      policy: "open",
    });
    expect(policyNext.channels?.slack?.groupPolicy).toBe("open");

    await expect(
      resolveSetupWizardGroupAllowlist({
        accountId: DEFAULT_ACCOUNT_ID,
        entries: ["general"],
        prompter,
        resolveAllowlist: section.resolveAllowlist,
      }),
    ).resolves.toEqual(["general"]);
    expect(prompter.note).toHaveBeenCalledTimes(2);

    const allowlistNext = section.applyAllowlist?.({
      accountId: DEFAULT_ACCOUNT_ID,
      cfg: {},
      resolved: ["C123"],
    });
    expect(allowlistNext?.channels?.slack?.channels).toEqual({
      C123: { allow: true },
    });
  });
});

describe("splitSetupEntries", () => {
  it("splits comma/newline/semicolon input and trims blanks", () => {
    expect(splitSetupEntries(" alice, bob \ncarol;  ;\n")).toEqual(["alice", "bob", "carol"]);
  });
});

describe("parseSetupEntriesWithParser", () => {
  it("maps entries and de-duplicates parsed values", () => {
    expect(
      parseSetupEntriesWithParser(" alice, ALICE ; * ", (entry) => {
        if (entry === "*") {
          return { value: "*" };
        }
        return { value: entry.toLowerCase() };
      }),
    ).toEqual({
      entries: ["alice", "*"],
    });
  });

  it("returns parser errors and clears parsed entries", () => {
    expect(
      parseSetupEntriesWithParser("ok, bad", (entry) =>
        entry === "bad" ? { error: "invalid entry: bad" } : { value: entry },
      ),
    ).toEqual({
      entries: [],
      error: "invalid entry: bad",
    });
  });
});

describe("parseSetupEntriesAllowingWildcard", () => {
  it("preserves wildcard and delegates non-wildcard entries", () => {
    expect(
      parseSetupEntriesAllowingWildcard(" *, Foo ", (entry) => ({
        value: entry.toLowerCase(),
      })),
    ).toEqual({
      entries: ["*", "foo"],
    });
  });

  it("returns parser errors for non-wildcard entries", () => {
    expect(
      parseSetupEntriesAllowingWildcard("ok,bad", (entry) =>
        entry === "bad" ? { error: "bad entry" } : { value: entry },
      ),
    ).toEqual({
      entries: [],
      error: "bad entry",
    });
  });
});

describe("resolveEntriesWithOptionalToken", () => {
  it("returns unresolved entries when token is missing", async () => {
    await expect(
      resolveEntriesWithOptionalToken({
        buildWithoutToken: (input) => ({ id: null, input, resolved: false }),
        entries: ["alice", "bob"],
        resolveEntries: async () => {
          throw new Error("should not run");
        },
      }),
    ).resolves.toEqual([
      { id: null, input: "alice", resolved: false },
      { id: null, input: "bob", resolved: false },
    ]);
  });

  it("delegates to the resolver when token exists", async () => {
    await expect(
      resolveEntriesWithOptionalToken<{
        input: string;
        resolved: boolean;
        id: string | null;
      }>({
        buildWithoutToken: (input) => ({ id: null, input, resolved: false }),
        entries: ["alice"],
        resolveEntries: async ({ token, entries }) =>
          entries.map((input) => ({ id: `${token}:${input}`, input, resolved: true })),
        token: "xoxb-test",
      }),
    ).resolves.toEqual([{ id: "xoxb-test:alice", input: "alice", resolved: true }]);
  });
});

describe("resolveParsedAllowFromEntries", () => {
  it("maps parsed ids into resolved/unresolved entries", () => {
    expect(
      resolveParsedAllowFromEntries({
        entries: ["alice", " "],
        parseId: (raw) => raw.trim() || null,
      }),
    ).toEqual([
      { id: "alice", input: "alice", resolved: true },
      { id: null, input: " ", resolved: false },
    ]);
  });
});

describe("parseMentionOrPrefixedId", () => {
  it("parses mention ids", () => {
    expect(
      parseMentionOrPrefixedId({
        idPattern: /^\d+$/,
        mentionPattern: /^<@!?(\d+)>$/,
        prefixPattern: /^(user:|discord:)/i,
        value: "<@!123>",
      }),
    ).toBe("123");
  });

  it("parses prefixed ids and normalizes result", () => {
    expect(
      parseMentionOrPrefixedId({
        idPattern: /^[A-Z][A-Z0-9]+$/i,
        mentionPattern: /^<@([A-Z0-9]+)>$/i,
        normalizeId: (id) => id.toUpperCase(),
        prefixPattern: /^(slack:|user:)/i,
        value: "slack:u123abc",
      }),
    ).toBe("U123ABC");
  });

  it("returns null for blank or invalid input", () => {
    expect(
      parseMentionOrPrefixedId({
        idPattern: /^\d+$/,
        mentionPattern: /^<@!?(\d+)>$/,
        prefixPattern: /^(user:|discord:)/i,
        value: "   ",
      }),
    ).toBeNull();
    expect(
      parseMentionOrPrefixedId({
        idPattern: /^\d+$/,
        mentionPattern: /^<@!?(\d+)>$/,
        prefixPattern: /^(user:|discord:)/i,
        value: "@alice",
      }),
    ).toBeNull();
  });
});

describe("normalizeAllowFromEntries", () => {
  it("normalizes values, preserves wildcard, and removes duplicates", () => {
    expect(
      normalizeAllowFromEntries([" +15555550123 ", "*", "+15555550123", "bad"], (value) =>
        value.startsWith("+1") ? value : null,
      ),
    ).toEqual(["+15555550123", "*"]);
  });

  it("trims and de-duplicates without a normalizer", () => {
    expect(normalizeAllowFromEntries([" alice ", "bob", "alice"])).toEqual(["alice", "bob"]);
  });
});

describe("createStandardChannelSetupStatus", () => {
  it("returns the shared status fields without status lines by default", async () => {
    const status = createStandardChannelSetupStatus({
      channelLabel: "Demo",
      configuredHint: "ready",
      configuredLabel: "configured",
      configuredScore: 2,
      resolveConfigured: ({ cfg }) => Boolean(cfg.channels?.demo),
      unconfiguredHint: "missing token",
      unconfiguredLabel: "needs token",
      unconfiguredScore: 0,
    });

    expect(status.configuredHint).toBe("ready");
    expect(status.unconfiguredHint).toBe("missing token");
    expect(status.configuredScore).toBe(2);
    expect(status.unconfiguredScore).toBe(0);
    expect(await status.resolveConfigured({ cfg: { channels: { demo: {} } } })).toBe(true);
    expect(status.resolveStatusLines).toBeUndefined();
  });

  it("builds the default status line plus extra lines when requested", async () => {
    const status = createStandardChannelSetupStatus({
      channelLabel: "Demo",
      configuredLabel: "configured",
      includeStatusLine: true,
      resolveConfigured: ({ cfg }) => Boolean(cfg.channels?.demo),
      resolveExtraStatusLines: ({ configured }) => [`Configured: ${configured ? "yes" : "no"}`],
      unconfiguredLabel: "needs token",
    });

    expect(
      await status.resolveStatusLines?.({
        cfg: { channels: { demo: {} } },
        configured: true,
      }),
    ).toEqual(["Demo: configured", "Configured: yes"]);
  });
});

describe("resolveSetupAccountId", () => {
  it("normalizes provided account ids", () => {
    expect(
      resolveSetupAccountId({
        accountId: " Work Account ",
        defaultAccountId: DEFAULT_ACCOUNT_ID,
      }),
    ).toBe("work-account");
  });

  it("falls back to default account id when input is blank", () => {
    expect(
      resolveSetupAccountId({
        accountId: "   ",
        defaultAccountId: "custom-default",
      }),
    ).toBe("custom-default");
  });
});

describe("resolveAccountIdForConfigure", () => {
  it("uses normalized override without prompting", async () => {
    const accountId = await resolveAccountIdForConfigure({
      accountOverride: " Team Primary ",
      cfg: {},
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      label: "Signal",
      listAccountIds: () => ["default", "team-primary"],
      prompter: {} as any,
      shouldPromptAccountIds: true,
    });
    expect(accountId).toBe("team-primary");
  });

  it("uses default account when override is missing and prompting disabled", async () => {
    const accountId = await resolveAccountIdForConfigure({
      cfg: {},
      defaultAccountId: "fallback",
      label: "Signal",
      listAccountIds: () => ["default"],
      prompter: {} as any,
      shouldPromptAccountIds: false,
    });
    expect(accountId).toBe("fallback");
  });

  it("prompts for account id when prompting is enabled and no override is provided", async () => {
    const prompter = {
      note: vi.fn(async () => undefined),
      select: vi.fn(async () => "prompted-id"),
      text: vi.fn(async () => ""),
    };

    const accountId = await resolveAccountIdForConfigure({
      cfg: {},
      defaultAccountId: "fallback",
      label: "Signal",
      listAccountIds: () => ["default", "prompted-id"],
      prompter: prompter as any,
      shouldPromptAccountIds: true,
    });

    expect(accountId).toBe("prompted-id");
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "fallback",
        message: "Signal account",
      }),
    );
    expect(prompter.text).not.toHaveBeenCalled();
  });
});
