import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: () => ({ enabled: false }),
}));

vi.mock("../../agents/model-auth-label.js", () => ({
  resolveModelAuthLabel: () => "api-key",
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  listSubagentRunsForRequester: () => [],
}));

vi.mock("../../infra/provider-usage.js", () => ({
  formatUsageWindowSummary: () => undefined,
  loadProviderUsageSummary: async () => ({
    providers: [],
    updatedAt: Date.now(),
  }),
  resolveUsageProviderId: () => undefined,
}));

vi.mock("../group-activation.js", () => ({
  normalizeGroupActivation: (value: unknown) => value,
}));

vi.mock("./queue.js", () => ({
  getFollowupQueueDepth: () => 0,
  resolveQueueSettings: () => ({ mode: "interrupt" }),
}));

const { buildStatusReply } = await import("./commands-status.js");

describe("buildStatusReply", () => {
  it("shows per-agent thinkingDefault in the status card", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
        list: [
          {
            id: "kira",
            model: "openai/gpt-5.4",
            thinkingDefault: "xhigh",
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;

    const reply = await buildStatusReply({
      cfg,
      command: {
        channel: "whatsapp",
        isAuthorizedSender: true,
      } as never,
      contextTokens: 0,
      defaultGroupActivation: () => "mention",
      isGroup: false,
      model: "gpt-5.4",
      provider: "openai",
      resolveDefaultThinkingLevel: async () => undefined,
      resolvedReasoningLevel: "off",
      resolvedVerboseLevel: "off",
      sessionKey: "agent:kira:main",
    });

    expect(reply?.text).toContain("Think: xhigh");
  });

  it("shows per-agent fallback overrides in the status card", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["anthropic/claude-sonnet-4-6"],
            primary: "openai/gpt-5.4",
          },
        },
        list: [
          {
            id: "kira",
            model: {
              fallbacks: ["google/gemini-2.5-flash"],
              primary: "openai/gpt-5.4",
            },
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;

    const reply = await buildStatusReply({
      cfg,
      command: {
        channel: "whatsapp",
        isAuthorizedSender: true,
      } as never,
      contextTokens: 0,
      defaultGroupActivation: () => "mention",
      isGroup: false,
      model: "gpt-5.4",
      provider: "openai",
      resolveDefaultThinkingLevel: async () => undefined,
      resolvedReasoningLevel: "off",
      resolvedVerboseLevel: "off",
      sessionKey: "agent:kira:main",
    });

    expect(reply?.text).toContain("Fallbacks: google/gemini-2.5-flash");
    expect(reply?.text).not.toContain("Fallbacks: anthropic/claude-sonnet-4-6");
  });

  it("keeps default fallback config when the agent has no explicit fallback override", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["anthropic/claude-sonnet-4-6"],
            primary: "openai/gpt-5.4",
          },
        },
        list: [
          {
            id: "kira",
            model: {
              primary: "openai/gpt-5.4",
            },
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;

    const reply = await buildStatusReply({
      cfg,
      command: {
        channel: "whatsapp",
        isAuthorizedSender: true,
      } as never,
      contextTokens: 0,
      defaultGroupActivation: () => "mention",
      isGroup: false,
      model: "gpt-5.4",
      provider: "openai",
      resolveDefaultThinkingLevel: async () => undefined,
      resolvedReasoningLevel: "off",
      resolvedVerboseLevel: "off",
      sessionKey: "agent:kira:main",
    });

    expect(reply?.text).toContain("Fallbacks: anthropic/claude-sonnet-4-6");
  });

  it("treats an explicit empty per-agent fallback override as disabling inherited fallbacks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["anthropic/claude-sonnet-4-6"],
            primary: "openai/gpt-5.4",
          },
        },
        list: [
          {
            id: "kira",
            model: {
              fallbacks: [],
              primary: "openai/gpt-5.4",
            },
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;

    const reply = await buildStatusReply({
      cfg,
      command: {
        channel: "whatsapp",
        isAuthorizedSender: true,
      } as never,
      contextTokens: 0,
      defaultGroupActivation: () => "mention",
      isGroup: false,
      model: "gpt-5.4",
      provider: "openai",
      resolveDefaultThinkingLevel: async () => undefined,
      resolvedReasoningLevel: "off",
      resolvedVerboseLevel: "off",
      sessionKey: "agent:kira:main",
    });

    expect(reply?.text).not.toContain("Fallbacks:");
  });
});
