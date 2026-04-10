import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.hoisted(() => vi.fn());
const getApiKeyForModel = vi.hoisted(() => vi.fn());
const requireApiKey = vi.hoisted(() => vi.fn());
const resolveDefaultModelForAgent = vi.hoisted(() => vi.fn());
const resolveModelAsync = vi.hoisted(() => vi.fn());
const prepareModelForSimpleCompletion = vi.hoisted(() => vi.fn());

vi.mock("@mariozechner/pi-ai", async () => {
  const original =
    await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...original,
    completeSimple,
  };
});

vi.mock("../../agents/model-auth.js", () => ({
  getApiKeyForModel,
  requireApiKey,
}));

vi.mock("../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent,
}));

vi.mock("../../agents/pi-embedded-runner/model.js", () => ({
  resolveModelAsync,
}));

vi.mock("../../agents/simple-completion-transport.js", () => ({
  prepareModelForSimpleCompletion,
}));

import { generateConversationLabel } from "./conversation-label-generator.js";

describe("generateConversationLabel", () => {
  beforeEach(() => {
    completeSimple.mockReset();
    getApiKeyForModel.mockReset();
    requireApiKey.mockReset();
    resolveDefaultModelForAgent.mockReset();
    resolveModelAsync.mockReset();
    prepareModelForSimpleCompletion.mockReset();

    resolveDefaultModelForAgent.mockReturnValue({ model: "gpt-test", provider: "openai" });
    resolveModelAsync.mockResolvedValue({
      authStorage: {},
      model: { provider: "openai" },
      modelRegistry: {},
    });
    prepareModelForSimpleCompletion.mockImplementation(({ model }) => model);
    getApiKeyForModel.mockResolvedValue({ apiKey: "resolved-key", mode: "api-key" });
    requireApiKey.mockReturnValue("resolved-key");
    completeSimple.mockResolvedValue({
      content: [{ text: "Topic label", type: "text" }],
    });
  });

  it("uses routed agentDir for model and auth resolution", async () => {
    await generateConversationLabel({
      agentDir: "/tmp/agents/billing/agent",
      agentId: "billing",
      cfg: {},
      prompt: "prompt",
      userMessage: "Need help with invoices",
    });

    expect(resolveDefaultModelForAgent).toHaveBeenCalledWith({
      agentId: "billing",
      cfg: {},
    });
    expect(resolveModelAsync).toHaveBeenCalledWith(
      "openai",
      "gpt-test",
      "/tmp/agents/billing/agent",
      {},
    );
    expect(getApiKeyForModel).toHaveBeenCalledWith({
      agentDir: "/tmp/agents/billing/agent",
      cfg: {},
      model: { provider: "openai" },
    });
    expect(prepareModelForSimpleCompletion).toHaveBeenCalledWith({
      cfg: {},
      model: { provider: "openai" },
    });
  });
});
