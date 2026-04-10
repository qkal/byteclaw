import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { applyModelOverrideToSessionEntry } from "./model-overrides.js";

function applyOpenAiSelection(entry: SessionEntry) {
  return applyModelOverrideToSessionEntry({
    entry,
    selection: {
      model: "gpt-5.4",
      provider: "openai",
    },
  });
}

function expectRuntimeModelFieldsCleared(entry: SessionEntry, before: number) {
  expect(entry.providerOverride).toBe("openai");
  expect(entry.modelOverride).toBe("gpt-5.4");
  expect(entry.modelProvider).toBeUndefined();
  expect(entry.model).toBeUndefined();
  expect((entry.updatedAt ?? 0) > before).toBe(true);
}

describe("applyModelOverrideToSessionEntry", () => {
  it("clears stale runtime model fields when switching overrides", () => {
    const before = Date.now() - 5000;
    const entry: SessionEntry = {
      contextTokens: 160_000,
      fallbackNoticeActiveModel: "anthropic/claude-sonnet-4-6",
      fallbackNoticeReason: "provider temporary failure",
      fallbackNoticeSelectedModel: "anthropic/claude-sonnet-4-6",
      model: "claude-sonnet-4-6",
      modelOverride: "claude-sonnet-4-6",
      modelProvider: "anthropic",
      providerOverride: "anthropic",
      sessionId: "sess-1",
      updatedAt: before,
    };

    const result = applyOpenAiSelection(entry);

    expect(result.updated).toBe(true);
    expectRuntimeModelFieldsCleared(entry, before);
    expect(entry.contextTokens).toBeUndefined();
    expect(entry.fallbackNoticeSelectedModel).toBeUndefined();
    expect(entry.fallbackNoticeActiveModel).toBeUndefined();
    expect(entry.fallbackNoticeReason).toBeUndefined();
    expect(entry.modelOverrideSource).toBe("user");
  });

  it("clears stale runtime model fields even when override selection is unchanged", () => {
    const before = Date.now() - 5000;
    const entry: SessionEntry = {
      contextTokens: 160_000,
      model: "claude-sonnet-4-6",
      modelOverride: "gpt-5.4",
      modelProvider: "anthropic",
      providerOverride: "openai",
      sessionId: "sess-2",
      updatedAt: before,
    };

    const result = applyOpenAiSelection(entry);

    expect(result.updated).toBe(true);
    expectRuntimeModelFieldsCleared(entry, before);
    expect(entry.contextTokens).toBeUndefined();
  });

  it("retains aligned runtime model fields when selection and runtime already match", () => {
    const before = Date.now() - 5000;
    const entry: SessionEntry = {
      contextTokens: 200_000,
      model: "gpt-5.4",
      modelOverride: "gpt-5.4",
      modelProvider: "openai",
      providerOverride: "openai",
      sessionId: "sess-3",
      updatedAt: before,
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        model: "gpt-5.4",
        provider: "openai",
      },
    });

    expect(result.updated).toBe(true);
    expect(entry.modelProvider).toBe("openai");
    expect(entry.model).toBe("gpt-5.4");
    expect(entry.modelOverrideSource).toBe("user");
    expect(entry.contextTokens).toBe(200_000);
    expect((entry.updatedAt ?? 0) >= before).toBe(true);
  });

  it("clears stale contextTokens when switching back to the default model", () => {
    const before = Date.now() - 5000;
    const entry: SessionEntry = {
      contextTokens: 4096,
      modelOverride: "sunapi386/llama-3-lexi-uncensored:8b",
      providerOverride: "local",
      sessionId: "sess-4",
      updatedAt: before,
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        isDefault: true,
        model: "llama3.1:8b",
        provider: "local",
      },
    });

    expect(result.updated).toBe(true);
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.modelOverrideSource).toBeUndefined();
    expect(entry.contextTokens).toBeUndefined();
    expect((entry.updatedAt ?? 0) > before).toBe(true);
  });

  it("marks non-default overrides with the provided source", () => {
    const entry: SessionEntry = {
      sessionId: "sess-5a",
      updatedAt: Date.now() - 5000,
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        model: "claude-sonnet-4-6",
        provider: "anthropic",
      },
      selectionSource: "auto",
    });

    expect(result.updated).toBe(true);
    expect(entry.providerOverride).toBe("anthropic");
    expect(entry.modelOverride).toBe("claude-sonnet-4-6");
    expect(entry.modelOverrideSource).toBe("auto");
  });

  it("sets liveModelSwitchPending only when explicitly requested", () => {
    const entry: SessionEntry = {
      modelOverride: "claude-sonnet-4-6",
      providerOverride: "anthropic",
      sessionId: "sess-5",
      updatedAt: Date.now() - 5000,
    };

    const withoutFlag = applyModelOverrideToSessionEntry({
      entry: { ...entry },
      selection: {
        model: "gpt-5.4",
        provider: "openai",
      },
    });
    expect(withoutFlag.updated).toBe(true);
    expect(entry.liveModelSwitchPending).toBeUndefined();

    const withFlagEntry: SessionEntry = { ...entry };
    const withFlag = applyModelOverrideToSessionEntry({
      entry: withFlagEntry,
      markLiveSwitchPending: true,
      selection: {
        model: "gpt-5.4",
        provider: "openai",
      },
    });
    expect(withFlag.updated).toBe(true);
    expect(withFlagEntry.liveModelSwitchPending).toBe(true);
  });
});
