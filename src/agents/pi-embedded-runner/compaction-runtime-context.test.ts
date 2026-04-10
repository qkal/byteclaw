import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildEmbeddedCompactionRuntimeContext,
  resolveEmbeddedCompactionTarget,
} from "./compaction-runtime-context.js";

describe("buildEmbeddedCompactionRuntimeContext", () => {
  it("preserves sender and current message routing for compaction", () => {
    expect(
      buildEmbeddedCompactionRuntimeContext({
        agentAccountId: "acct-1",
        agentDir: "/tmp/agent",
        authProfileId: "openai:p1",
        config: {} as OpenClawConfig,
        currentChannelId: "C123",
        currentMessageId: "msg-42",
        currentThreadTs: "thread-9",
        extraSystemPrompt: "extra",
        messageChannel: "slack",
        messageProvider: "slack",
        modelId: "gpt-5.4",
        ownerNumbers: ["+15555550123"],
        provider: "openai-codex",
        reasoningLevel: "on",
        senderId: "user-123",
        senderIsOwner: true,
        sessionKey: "agent:main:thread:1",
        thinkLevel: "off",
        workspaceDir: "/tmp/workspace",
      }),
    ).toMatchObject({
      agentAccountId: "acct-1",
      agentDir: "/tmp/agent",
      authProfileId: "openai:p1",
      currentChannelId: "C123",
      currentMessageId: "msg-42",
      currentThreadTs: "thread-9",
      messageChannel: "slack",
      messageProvider: "slack",
      model: "gpt-5.4",
      provider: "openai-codex",
      senderId: "user-123",
      sessionKey: "agent:main:thread:1",
      workspaceDir: "/tmp/workspace",
    });
  });

  it("normalizes nullable compaction routing fields to undefined", () => {
    expect(
      buildEmbeddedCompactionRuntimeContext({
        agentAccountId: null,
        agentDir: "/tmp/agent",
        authProfileId: null,
        currentChannelId: null,
        currentMessageId: null,
        currentThreadTs: null,
        messageChannel: null,
        messageProvider: null,
        modelId: null,
        provider: null,
        senderId: null,
        sessionKey: null,
        workspaceDir: "/tmp/workspace",
      }),
    ).toMatchObject({
      agentAccountId: undefined,
      authProfileId: undefined,
      currentChannelId: undefined,
      currentMessageId: undefined,
      currentThreadTs: undefined,
      messageChannel: undefined,
      messageProvider: undefined,
      model: undefined,
      provider: undefined,
      senderId: undefined,
      sessionKey: undefined,
    });
  });

  it("applies compaction.model override with provider/model format", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      agentDir: "/tmp/agent",
      authProfileId: "ollama:default",
      config: {
        agents: { defaults: { compaction: { model: "anthropic/claude-opus-4-6" } } },
      } as OpenClawConfig,
      modelId: "minimax-m2.7:cloud",
      provider: "ollama",
      workspaceDir: "/tmp/workspace",
    });
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-opus-4-6");
    // Auth profile dropped because provider changed
    expect(result.authProfileId).toBeUndefined();
  });

  it("applies compaction.model override with model-only format", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      agentDir: "/tmp/agent",
      authProfileId: "openai:p1",
      config: {
        agents: { defaults: { compaction: { model: "gpt-4o" } } },
      } as OpenClawConfig,
      modelId: "gpt-3.5-turbo",
      provider: "openai",
      workspaceDir: "/tmp/workspace",
    });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o");
    // Auth profile preserved because provider didn't change
    expect(result.authProfileId).toBe("openai:p1");
  });

  it("uses session model when no compaction.model override configured", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      agentDir: "/tmp/agent",
      authProfileId: "ollama:default",
      config: {} as OpenClawConfig,
      modelId: "minimax-m2.7:cloud",
      provider: "ollama",
      workspaceDir: "/tmp/workspace",
    });
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("minimax-m2.7:cloud");
    expect(result.authProfileId).toBe("ollama:default");
  });

  it("applies runtime defaults when resolving the effective compaction target", () => {
    expect(
      resolveEmbeddedCompactionTarget({
        authProfileId: "openai:p1",
        config: {
          agents: { defaults: { compaction: { model: "anthropic/" } } },
        } as OpenClawConfig,
        defaultModel: "gpt-5.4",
        defaultProvider: "openai-codex",
        modelId: "gpt-5.4",
        provider: "openai-codex",
      }),
    ).toEqual({
      authProfileId: undefined,
      model: "gpt-5.4",
      provider: "anthropic",
    });
  });
});
