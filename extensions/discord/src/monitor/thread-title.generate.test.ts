import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import * as agentRuntimeModule from "openclaw/plugin-sdk/simple-completion-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const completeWithPreparedSimpleCompletionModelMock =
  vi.fn<typeof agentRuntimeModule.completeWithPreparedSimpleCompletionModel>();
const prepareSimpleCompletionModelForAgentMock =
  vi.fn<typeof agentRuntimeModule.prepareSimpleCompletionModelForAgent>();
const extractAssistantTextMock = vi.fn<typeof agentRuntimeModule.extractAssistantText>();

let generateThreadTitle: typeof import("./thread-title.js").generateThreadTitle;

beforeAll(async () => {
  ({ generateThreadTitle } = await import("./thread-title.js"));
});

beforeEach(() => {
  vi.restoreAllMocks();
  completeWithPreparedSimpleCompletionModelMock.mockReset();
  prepareSimpleCompletionModelForAgentMock.mockReset();
  extractAssistantTextMock.mockReset();

  prepareSimpleCompletionModelForAgentMock.mockResolvedValue({
    auth: {
      apiKey: "sk-test",
      mode: "api-key",
      source: "env:TEST_API_KEY",
    },
    model: {
      id: "claude-sonnet-4-6",
      provider: "anthropic",
    },
    selection: {
      agentDir: "/tmp/openclaw-agent",
      modelId: "claude-sonnet-4-6",
      provider: "anthropic",
    },
  } as Awaited<ReturnType<typeof agentRuntimeModule.prepareSimpleCompletionModelForAgent>>);
  completeWithPreparedSimpleCompletionModelMock.mockResolvedValue(
    {} as Awaited<ReturnType<typeof agentRuntimeModule.completeWithPreparedSimpleCompletionModel>>,
  );
  extractAssistantTextMock.mockReturnValue("Generated title");
  vi.spyOn(agentRuntimeModule, "prepareSimpleCompletionModelForAgent").mockImplementation(
    (...args) => prepareSimpleCompletionModelForAgentMock(...args),
  );
  vi.spyOn(agentRuntimeModule, "completeWithPreparedSimpleCompletionModel").mockImplementation(
    (...args) => completeWithPreparedSimpleCompletionModelMock(...args),
  );
  vi.spyOn(agentRuntimeModule, "extractAssistantText").mockImplementation((...args) =>
    extractAssistantTextMock(...args),
  );
});

describe("generateThreadTitle", () => {
  it("calls shared one-shot model prep with aws-sdk allowance", async () => {
    prepareSimpleCompletionModelForAgentMock.mockResolvedValueOnce({
      auth: {
        apiKey: "sk-openrouter",
        mode: "api-key",
        source: "profile:work",
      },
      model: {
        id: "anthropic/claude-sonnet-4-5",
        provider: "openrouter",
      },
      selection: {
        agentDir: "/tmp/openclaw-agent",
        modelId: "anthropic/claude-sonnet-4-5",
        profileId: "work",
        provider: "openrouter",
      },
    } as Awaited<ReturnType<typeof agentRuntimeModule.prepareSimpleCompletionModelForAgent>>);
    const cfg = {
      agents: {
        defaults: {
          model: "openrouter/anthropic/claude-sonnet-4-5@work",
        },
      },
    } as OpenClawConfig;

    await generateThreadTitle({
      agentId: "main",
      cfg,
      messageText: "Need a generated title.",
    });

    expect(prepareSimpleCompletionModelForAgentMock).toHaveBeenCalledWith({
      agentId: "main",
      allowMissingApiKeyModes: ["aws-sdk"],
      cfg,
    });
  });

  it("passes model override refs into shared model prep", async () => {
    const cfg = {} as OpenClawConfig;
    await generateThreadTitle({
      agentId: "main",
      cfg,
      messageText: "Need a generated title.",
      modelRef: "openai/gpt-4.1-mini@local",
    });

    expect(prepareSimpleCompletionModelForAgentMock).toHaveBeenCalledWith({
      agentId: "main",
      allowMissingApiKeyModes: ["aws-sdk"],
      cfg,
      modelRef: "openai/gpt-4.1-mini@local",
    });
  });

  it("returns null when shared model prep cannot resolve selection", async () => {
    prepareSimpleCompletionModelForAgentMock.mockResolvedValueOnce({
      error: "No model configured for agent main.",
    } as Awaited<ReturnType<typeof agentRuntimeModule.prepareSimpleCompletionModelForAgent>>);

    const result = await generateThreadTitle({
      agentId: "main",
      cfg: {} as OpenClawConfig,
      messageText: "Need a thread title.",
    });

    expect(result).toBeNull();
    expect(completeWithPreparedSimpleCompletionModelMock).not.toHaveBeenCalled();
  });

  it("returns null when shared completion prep fails", async () => {
    prepareSimpleCompletionModelForAgentMock.mockResolvedValue({
      error: 'No API key resolved for provider "anthropic" (auth mode: api-key).',
      selection: {
        agentDir: "/tmp/openclaw-agent",
        modelId: "claude-sonnet-4-6",
        provider: "anthropic",
      },
    } as Awaited<ReturnType<typeof agentRuntimeModule.prepareSimpleCompletionModelForAgent>>);

    const result = await generateThreadTitle({
      agentId: "main",
      cfg: {} as OpenClawConfig,
      messageText: "Need a thread title.",
    });

    expect(result).toBeNull();
    expect(completeWithPreparedSimpleCompletionModelMock).not.toHaveBeenCalled();
  });

  it("builds contextual prompt and forwards completion options", async () => {
    const result = await generateThreadTitle({
      agentId: "main",
      cfg: {} as OpenClawConfig,
      channelDescription: "Deploy updates and incident notes",
      channelName: "release-status",
      messageText: "Summarize deployment blockers and owner follow-ups.",
    });

    expect(result).toBe("Generated title");
    expect(completeWithPreparedSimpleCompletionModelMock).toHaveBeenCalledTimes(1);
    expect(completeWithPreparedSimpleCompletionModelMock.mock.calls[0]?.[0]?.context).toEqual(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining("Channel: release-status"),
            role: "user",
          }),
        ],
        systemPrompt:
          "Generate a concise Discord thread title (3-6 words). Return only the title. Use channel context when provided and avoid redundant channel-name words unless needed for clarity.",
      }),
    );
    expect(
      completeWithPreparedSimpleCompletionModelMock.mock.calls[0]?.[0]?.context?.messages?.[0]
        ?.content,
    ).toContain("Channel description: Deploy updates and incident notes");
    expect(completeWithPreparedSimpleCompletionModelMock.mock.calls[0]?.[0]?.options).toEqual(
      expect.objectContaining({
        maxTokens: 512,
      }),
    );
    expect(
      completeWithPreparedSimpleCompletionModelMock.mock.calls[0]?.[0]?.options,
    ).not.toHaveProperty("temperature");
  });

  it("returns null when completion throws", async () => {
    completeWithPreparedSimpleCompletionModelMock.mockRejectedValueOnce(
      new Error("network timeout"),
    );

    const result = await generateThreadTitle({
      agentId: "main",
      cfg: {} as OpenClawConfig,
      messageText: "Generate title.",
    });

    expect(result).toBeNull();
  });
});
