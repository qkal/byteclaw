import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  clearAllCliSessions,
  clearCliSession,
  getCliSessionBinding,
  hashCliSessionText,
  resolveCliSessionReuse,
  setCliSessionBinding,
} from "./cli-session.js";

describe("cli-session helpers", () => {
  it("persists binding metadata alongside legacy session ids", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };

    setCliSessionBinding(entry, "claude-cli", {
      authEpoch: "auth-epoch",
      authProfileId: "anthropic:work",
      extraSystemPromptHash: "prompt-hash",
      mcpConfigHash: "mcp-hash",
      sessionId: "cli-session-1",
    });

    expect(entry.cliSessionIds?.["claude-cli"]).toBe("cli-session-1");
    expect(entry.claudeCliSessionId).toBe("cli-session-1");
    expect(getCliSessionBinding(entry, "claude-cli")).toEqual({
      authEpoch: "auth-epoch",
      authProfileId: "anthropic:work",
      extraSystemPromptHash: "prompt-hash",
      mcpConfigHash: "mcp-hash",
      sessionId: "cli-session-1",
    });
  });

  it("keeps legacy bindings reusable until richer metadata is persisted", () => {
    const entry: SessionEntry = {
      claudeCliSessionId: "legacy-session",
      cliSessionIds: { "claude-cli": "legacy-session" },
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };

    expect(resolveCliSessionReuse({ binding: getCliSessionBinding(entry, "claude-cli") })).toEqual({
      sessionId: "legacy-session",
    });
  });

  it("invalidates legacy bindings when auth, prompt, or MCP state changes", () => {
    const entry: SessionEntry = {
      claudeCliSessionId: "legacy-session",
      cliSessionIds: { "claude-cli": "legacy-session" },
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };
    const binding = getCliSessionBinding(entry, "claude-cli");

    expect(
      resolveCliSessionReuse({
        authProfileId: "anthropic:work",
        binding,
      }),
    ).toEqual({ invalidatedReason: "auth-profile" });
    expect(
      resolveCliSessionReuse({
        binding,
        extraSystemPromptHash: "prompt-hash",
      }),
    ).toEqual({ invalidatedReason: "system-prompt" });
    expect(
      resolveCliSessionReuse({
        binding,
        mcpConfigHash: "mcp-hash",
      }),
    ).toEqual({ invalidatedReason: "mcp" });
  });

  it("invalidates reuse when stored auth profile or prompt shape changes", () => {
    const binding = {
      authEpoch: "auth-epoch-a",
      authProfileId: "anthropic:work",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
      sessionId: "cli-session-1",
    };

    expect(
      resolveCliSessionReuse({
        authEpoch: "auth-epoch-a",
        authProfileId: "anthropic:personal",
        binding,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "auth-profile" });
    expect(
      resolveCliSessionReuse({
        authEpoch: "auth-epoch-b",
        authProfileId: "anthropic:work",
        binding,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "auth-epoch" });
    expect(
      resolveCliSessionReuse({
        authEpoch: "auth-epoch-a",
        authProfileId: "anthropic:work",
        binding,
        extraSystemPromptHash: "prompt-b",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "system-prompt" });
    expect(
      resolveCliSessionReuse({
        authEpoch: "auth-epoch-a",
        authProfileId: "anthropic:work",
        binding,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-b",
      }),
    ).toEqual({ invalidatedReason: "mcp" });
  });

  it("does not treat model changes as a session mismatch", () => {
    const binding = {
      authEpoch: "auth-epoch-a",
      authProfileId: "anthropic:work",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
      sessionId: "cli-session-1",
    };

    expect(
      resolveCliSessionReuse({
        authEpoch: "auth-epoch-a",
        authProfileId: "anthropic:work",
        binding,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ sessionId: "cli-session-1" });
  });

  it("clears provider-scoped and global CLI session state", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };
    setCliSessionBinding(entry, "claude-cli", { sessionId: "claude-session" });
    setCliSessionBinding(entry, "codex-cli", { sessionId: "codex-session" });

    clearCliSession(entry, "codex-cli");
    expect(getCliSessionBinding(entry, "codex-cli")).toBeUndefined();
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("claude-session");

    clearAllCliSessions(entry);
    expect(entry.cliSessionBindings).toBeUndefined();
    expect(entry.cliSessionIds).toBeUndefined();
    expect(entry.claudeCliSessionId).toBeUndefined();
  });

  it("hashes trimmed extra system prompts consistently", () => {
    expect(hashCliSessionText("  keep this  ")).toBe(hashCliSessionText("keep this"));
    expect(hashCliSessionText("")).toBeUndefined();
  });
});
