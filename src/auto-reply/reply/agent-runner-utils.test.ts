import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun } from "./queue.js";

const hoisted = vi.hoisted(() => {
  const resolveRunModelFallbacksOverrideMock = vi.fn();
  const getChannelPluginMock = vi.fn();
  const isReasoningTagProviderMock = vi.fn();
  return { getChannelPluginMock, isReasoningTagProviderMock, resolveRunModelFallbacksOverrideMock };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveRunModelFallbacksOverride: (...args: unknown[]) =>
    hoisted.resolveRunModelFallbacksOverrideMock(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => hoisted.getChannelPluginMock(...args),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: (...args: unknown[]) => hoisted.isReasoningTagProviderMock(...args),
}));

const {
  buildThreadingToolContext,
  buildEmbeddedRunBaseParams,
  buildEmbeddedRunContexts,
  resolveModelFallbackOptions,
  resolveEnforceFinalTag,
  resolveProviderScopedAuthProfile,
} = await import("./agent-runner-utils.js");

function makeRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun["run"] {
  return {
    agentDir: "/tmp/agent",
    agentId: "agent-1",
    bashElevated: false,
    config: { models: { providers: {} } },
    enforceFinalTag: false,
    execOverrides: {},
    model: "gpt-4.1",
    ownerNumbers: ["+15550001"],
    provider: "openai",
    reasoningLevel: "none",
    sessionFile: "/tmp/session.json",
    sessionId: "session-1",
    sessionKey: "agent:test:session",
    skillsSnapshot: [],
    thinkLevel: "medium",
    timeoutMs: 60_000,
    verboseLevel: "off",
    workspaceDir: "/tmp/workspace",
    ...overrides,
  } as unknown as FollowupRun["run"];
}

describe("agent-runner-utils", () => {
  beforeEach(() => {
    hoisted.resolveRunModelFallbacksOverrideMock.mockClear();
    hoisted.getChannelPluginMock.mockReset();
    hoisted.isReasoningTagProviderMock.mockReset();
    hoisted.isReasoningTagProviderMock.mockReturnValue(false);
  });

  it("resolves model fallback options from run context", () => {
    hoisted.resolveRunModelFallbacksOverrideMock.mockReturnValue(["fallback-model"]);
    const run = makeRun();

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveRunModelFallbacksOverrideMock).toHaveBeenCalledWith({
      agentId: run.agentId,
      cfg: run.config,
      sessionKey: run.sessionKey,
    });
    expect(resolved).toEqual({
      agentDir: run.agentDir,
      cfg: run.config,
      fallbacksOverride: ["fallback-model"],
      model: run.model,
      provider: run.provider,
    });
  });

  it("passes through missing agentId for helper-based fallback resolution", () => {
    hoisted.resolveRunModelFallbacksOverrideMock.mockReturnValue(["fallback-model"]);
    const run = makeRun({ agentId: undefined });

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveRunModelFallbacksOverrideMock).toHaveBeenCalledWith({
      agentId: undefined,
      cfg: run.config,
      sessionKey: run.sessionKey,
    });
    expect(resolved.fallbacksOverride).toEqual(["fallback-model"]);
  });

  it("builds embedded run base params with auth profile and run metadata", () => {
    const run = makeRun({ enforceFinalTag: true });
    const authProfile = resolveProviderScopedAuthProfile({
      authProfileId: "profile-openai",
      authProfileIdSource: "user",
      primaryProvider: "openai",
      provider: "openai",
    });

    const resolved = buildEmbeddedRunBaseParams({
      authProfile,
      model: "gpt-4.1-mini",
      provider: "openai",
      run,
      runId: "run-1",
    });

    expect(resolved).toMatchObject({
      agentDir: run.agentDir,
      authProfileId: "profile-openai",
      authProfileIdSource: "user",
      bashElevated: run.bashElevated,
      config: run.config,
      enforceFinalTag: true,
      execOverrides: run.execOverrides,
      model: "gpt-4.1-mini",
      ownerNumbers: run.ownerNumbers,
      provider: "openai",
      reasoningLevel: run.reasoningLevel,
      runId: "run-1",
      sessionFile: run.sessionFile,
      skillsSnapshot: run.skillsSnapshot,
      thinkLevel: run.thinkLevel,
      timeoutMs: run.timeoutMs,
      verboseLevel: run.verboseLevel,
      workspaceDir: run.workspaceDir,
    });
  });

  it("does not force final-tag enforcement for minimax providers", () => {
    const run = makeRun();

    expect(resolveEnforceFinalTag(run, "minimax", "MiniMax-M2.7")).toBe(false);
    expect(hoisted.isReasoningTagProviderMock).toHaveBeenCalledWith("minimax", {
      config: run.config,
      modelId: "MiniMax-M2.7",
      workspaceDir: run.workspaceDir,
    });
  });

  it("builds embedded contexts and scopes auth profile by provider", () => {
    const run = makeRun({
      authProfileId: "profile-openai",
      authProfileIdSource: "auto",
    });

    const resolved = buildEmbeddedRunContexts({
      hasRepliedRef: undefined,
      provider: "anthropic",
      run,
      sessionCtx: {
        Provider: "OpenAI",
        SenderId: "sender-1",
        To: "channel-1",
      },
    });

    expect(resolved.authProfile).toEqual({
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(resolved.embeddedContext).toMatchObject({
      agentId: run.agentId,
      messageProvider: "openai",
      messageTo: "channel-1",
      sessionId: run.sessionId,
      sessionKey: run.sessionKey,
    });
    expect(resolved.senderContext).toEqual({
      senderE164: undefined,
      senderId: "sender-1",
      senderName: undefined,
      senderUsername: undefined,
    });
  });

  it("prefers OriginatingChannel over Provider for messageProvider", () => {
    const run = makeRun();

    const resolved = buildEmbeddedRunContexts({
      hasRepliedRef: undefined,
      provider: "openai",
      run,
      sessionCtx: {
        OriginatingChannel: "Telegram",
        OriginatingTo: "268300329",
        Provider: "heartbeat",
      },
    });

    expect(resolved.embeddedContext.messageProvider).toBe("telegram");
    expect(resolved.embeddedContext.messageTo).toBe("268300329");
  });

  it("uses telegram plugin threading context for native commands", () => {
    hoisted.getChannelPluginMock.mockReturnValue({
      threading: {
        buildToolContext: ({
          context,
          hasRepliedRef,
        }: {
          context: { To?: string; MessageThreadId?: string | number };
          hasRepliedRef?: { value: boolean };
        }) => ({
          currentChannelId: context.To?.trim() || undefined,
          currentThreadTs:
            context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
          hasRepliedRef,
        }),
      },
    });

    const context = buildThreadingToolContext({
      config: { channels: { telegram: { allowFrom: ["*"] } } },
      hasRepliedRef: undefined,
      sessionCtx: {
        MessageSid: "2284",
        MessageThreadId: 928,
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:-1003841603622",
        Provider: "telegram",
        To: "slash:8460800771",
      },
    });

    expect(context).toMatchObject({
      currentChannelId: "telegram:-1003841603622",
      currentMessageId: "2284",
      currentThreadTs: "928",
    });
  });

  it("uses OriginatingTo for threading tool context on discord native commands", () => {
    const context = buildThreadingToolContext({
      config: {},
      hasRepliedRef: undefined,
      sessionCtx: {
        MessageSid: "msg-9",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:123456789012345678",
        Provider: "discord",
        To: "slash:1177378744822943744",
      },
    });

    expect(context).toMatchObject({
      currentChannelId: "channel:123456789012345678",
      currentMessageId: "msg-9",
    });
  });
});
