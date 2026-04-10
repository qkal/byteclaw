import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { __testing, runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

vi.mock("../run-wait.js", () => ({
  readLatestAssistantReply: vi.fn().mockResolvedValue("Test announce reply"),
  waitForAgentRun: vi.fn().mockResolvedValue({ status: "ok" }),
}));

vi.mock("./agent-step.js", () => ({
  runAgentStep: vi.fn().mockResolvedValue("Test announce reply"),
}));

describe("runSessionsSendA2AFlow announce delivery", () => {
  let gatewayCalls: CallGatewayOptions[];

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    gatewayCalls = [];
    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(opts: CallGatewayOptions) => {
        gatewayCalls.push(opts);
        return {} as T;
      },
    });
  });

  afterEach(() => {
    __testing.setDepsForTest();
    vi.restoreAllMocks();
  });

  it("passes threadId through to gateway send for Telegram forum topics", async () => {
    await runSessionsSendA2AFlow({
      announceTimeoutMs: 10_000,
      displayKey: "agent:main:telegram:group:-100123:topic:554",
      maxPingPongTurns: 0,
      message: "Test message",
      roundOneReply: "Worker completed successfully",
      targetSessionKey: "agent:main:telegram:group:-100123:topic:554",
    });

    // Find the gateway send call (not the waitForAgentRun call)
    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.threadId).toBe("554");
  });

  it("omits threadId for non-topic sessions", async () => {
    await runSessionsSendA2AFlow({
      announceTimeoutMs: 10_000,
      displayKey: "agent:main:discord:group:dev",
      maxPingPongTurns: 0,
      message: "Test message",
      roundOneReply: "Worker completed successfully",
      targetSessionKey: "agent:main:discord:group:dev",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.threadId).toBeUndefined();
  });
});
