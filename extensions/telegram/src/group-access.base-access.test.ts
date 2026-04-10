import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { type NormalizedAllowFrom, normalizeAllowFrom } from "./bot-access.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";

function allow(entries: string[], hasWildcard = false): NormalizedAllowFrom {
  return {
    entries,
    hasEntries: entries.length > 0 || hasWildcard,
    hasWildcard,
    invalidEntries: [],
  };
}

describe("evaluateTelegramGroupBaseAccess", () => {
  it("normalizes sender-only allowlist entries and rejects group ids", () => {
    const result = normalizeAllowFrom(["-1001234567890", " tg:-100999 ", "745123456", "@someone"]);

    expect(result).toEqual({
      entries: ["745123456"],
      hasEntries: true,
      hasWildcard: false,
      invalidEntries: ["-1001234567890", "-100999", "@someone"],
    });
  });

  it("fails closed when explicit group allowFrom override is empty", () => {
    const result = evaluateTelegramGroupBaseAccess({
      effectiveGroupAllow: allow([]),
      enforceAllowOverride: true,
      hasGroupAllowOverride: true,
      isGroup: true,
      requireSenderForAllowOverride: true,
      senderId: "12345",
      senderUsername: "tester",
    });

    expect(result).toEqual({ allowed: false, reason: "group-override-unauthorized" });
  });

  it("allows group message when override is not configured", () => {
    const result = evaluateTelegramGroupBaseAccess({
      effectiveGroupAllow: allow([]),
      enforceAllowOverride: true,
      hasGroupAllowOverride: false,
      isGroup: true,
      requireSenderForAllowOverride: true,
      senderId: "12345",
      senderUsername: "tester",
    });

    expect(result).toEqual({ allowed: true });
  });

  it("allows sender explicitly listed in override", () => {
    const result = evaluateTelegramGroupBaseAccess({
      effectiveGroupAllow: allow(["12345"]),
      enforceAllowOverride: true,
      hasGroupAllowOverride: true,
      isGroup: true,
      requireSenderForAllowOverride: true,
      senderId: "12345",
      senderUsername: "tester",
    });

    expect(result).toEqual({ allowed: true });
  });
});

/**
 * Minimal stubs shared across group policy tests.
 */
const baseCfg = {
  channels: { telegram: {} },
} as unknown as OpenClawConfig;

const baseTelegramCfg: TelegramAccountConfig = {
  groupPolicy: "allowlist",
} as unknown as TelegramAccountConfig;

const emptyAllow = { entries: [], hasEntries: false, hasWildcard: false, invalidEntries: [] };
const senderAllow = {
  entries: ["111"],
  hasEntries: true,
  hasWildcard: false,
  invalidEntries: [],
};

type GroupAccessParams = Parameters<typeof evaluateTelegramGroupPolicyAccess>[0];

const DEFAULT_GROUP_ACCESS_PARAMS: GroupAccessParams = {
  allowEmptyAllowlistEntries: false,
  cfg: baseCfg,
  chatId: "-100123456",
  checkChatAllowlist: true,
  effectiveGroupAllow: emptyAllow,
  enforceAllowlistAuthorization: true,
  enforcePolicy: true,
  isGroup: true,
  requireSenderForAllowlistAuthorization: true,
  resolveGroupPolicy: () => ({
    allowed: true,
    allowlistEnabled: true,
    groupConfig: { requireMention: false },
  }),
  senderId: "999",
  senderUsername: "user",
  telegramCfg: baseTelegramCfg,
  useTopicAndGroupOverrides: false,
};

function runAccess(overrides: Partial<GroupAccessParams>) {
  return evaluateTelegramGroupPolicyAccess({
    ...DEFAULT_GROUP_ACCESS_PARAMS,
    ...overrides,
    resolveGroupPolicy:
      overrides.resolveGroupPolicy ?? DEFAULT_GROUP_ACCESS_PARAMS.resolveGroupPolicy,
  });
}

describe("evaluateTelegramGroupPolicyAccess", () => {
  it("allows a group explicitly listed in groups config even when no allowFrom entries exist", () => {
    const result = runAccess({
      resolveGroupPolicy: () => ({
        allowed: true,
        allowlistEnabled: true,
        groupConfig: { requireMention: false },
      }),
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });

  it("still blocks when only wildcard match and no allowFrom entries", () => {
    const result = runAccess({
      resolveGroupPolicy: () => ({
        allowed: true,
        allowlistEnabled: true,
        groupConfig: undefined,
      }),
    });

    expect(result).toEqual({
      allowed: false,
      groupPolicy: "allowlist",
      reason: "group-policy-allowlist-empty",
    });
  });

  it("rejects a group not in groups config", () => {
    const result = runAccess({
      chatId: "-100999999",
      resolveGroupPolicy: () => ({
        allowed: false,
        allowlistEnabled: true,
      }),
    });

    expect(result).toEqual({
      allowed: false,
      groupPolicy: "allowlist",
      reason: "group-chat-not-allowed",
    });
  });

  it("still enforces sender allowlist when checkChatAllowlist is disabled", () => {
    const result = runAccess({
      checkChatAllowlist: false,
      resolveGroupPolicy: () => ({
        allowed: true,
        allowlistEnabled: true,
        groupConfig: { requireMention: false },
      }),
    });

    expect(result).toEqual({
      allowed: false,
      groupPolicy: "allowlist",
      reason: "group-policy-allowlist-empty",
    });
  });

  it("blocks unauthorized sender even when chat is explicitly allowed and sender entries exist", () => {
    const result = runAccess({
      effectiveGroupAllow: senderAllow,
      resolveGroupPolicy: () => ({
        allowed: true,
        allowlistEnabled: true,
        groupConfig: { requireMention: false },
      }),
      senderId: "222",
      senderUsername: "other",
    });

    expect(result).toEqual({
      allowed: false,
      groupPolicy: "allowlist",
      reason: "group-policy-allowlist-unauthorized",
    });
  });

  it("allows when groupPolicy is open regardless of allowlist state", () => {
    const result = runAccess({
      resolveGroupPolicy: () => ({
        allowed: false,
        allowlistEnabled: false,
      }),
      telegramCfg: { groupPolicy: "open" } as TelegramAccountConfig,
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "open" });
  });

  it("rejects when groupPolicy is disabled", () => {
    const result = runAccess({
      resolveGroupPolicy: () => ({
        allowed: false,
        allowlistEnabled: false,
      }),
      telegramCfg: { groupPolicy: "disabled" } as TelegramAccountConfig,
    });

    expect(result).toEqual({
      allowed: false,
      groupPolicy: "disabled",
      reason: "group-policy-disabled",
    });
  });

  it("allows non-group messages without any checks", () => {
    const result = runAccess({
      chatId: "12345",
      isGroup: false,
      resolveGroupPolicy: () => ({
        allowed: false,
        allowlistEnabled: true,
      }),
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });

  it("blocks allowlist groups without sender identity before sender matching", () => {
    const result = runAccess({
      effectiveGroupAllow: senderAllow,
      resolveGroupPolicy: () => ({
        allowed: true,
        allowlistEnabled: true,
        groupConfig: { requireMention: false },
      }),
      senderId: undefined,
      senderUsername: undefined,
    });

    expect(result).toEqual({
      allowed: false,
      groupPolicy: "allowlist",
      reason: "group-policy-allowlist-no-sender",
    });
  });

  it("allows authorized sender in wildcard-matched group with sender entries", () => {
    const result = runAccess({
      effectiveGroupAllow: senderAllow,
      resolveGroupPolicy: () => ({
        allowed: true,
        allowlistEnabled: true,
        groupConfig: undefined,
      }),
      senderId: "111",
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });
});
