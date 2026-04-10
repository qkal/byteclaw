import { describe, expect, it } from "vitest";
import {
  formatDeprecatedNonInteractiveAuthChoiceError,
  normalizeLegacyOnboardAuthChoice,
  resolveDeprecatedAuthChoiceReplacement,
  resolveLegacyAuthChoiceAliasesForCli,
} from "./auth-choice-legacy.js";

describe("auth choice legacy aliases", () => {
  it("maps claude-cli to the new anthropic cli choice", () => {
    expect(normalizeLegacyOnboardAuthChoice("claude-cli")).toBe("anthropic-cli");
    expect(resolveDeprecatedAuthChoiceReplacement("claude-cli")).toEqual({
      message: 'Auth choice "claude-cli" is deprecated; using Anthropic Claude CLI setup instead.',
      normalized: "anthropic-cli",
    });
    expect(formatDeprecatedNonInteractiveAuthChoiceError("claude-cli")).toBe(
      'Auth choice "claude-cli" is deprecated.\nUse "--auth-choice anthropic-cli".',
    );
  });

  it("sources deprecated cli aliases from plugin manifests", () => {
    expect(resolveLegacyAuthChoiceAliasesForCli()).toEqual(["claude-cli", "codex-cli"]);
  });
});
