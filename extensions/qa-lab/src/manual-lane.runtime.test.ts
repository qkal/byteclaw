import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startQaLabServer, startQaGatewayChild, startQaMockOpenAiServer } = vi.hoisted(() => ({
  startQaGatewayChild: vi.fn(),
  startQaLabServer: vi.fn(),
  startQaMockOpenAiServer: vi.fn(),
}));

vi.mock("./lab-server.js", () => ({
  startQaLabServer,
}));

vi.mock("./gateway-child.js", () => ({
  startQaGatewayChild,
}));

vi.mock("./mock-openai-server.js", () => ({
  startQaMockOpenAiServer,
}));

import { runQaManualLane } from "./manual-lane.runtime.js";

describe("runQaManualLane", () => {
  const gatewayStop = vi.fn();
  const mockStop = vi.fn();
  const labStop = vi.fn();

  beforeEach(() => {
    gatewayStop.mockReset();
    mockStop.mockReset();
    labStop.mockReset();
    startQaLabServer.mockReset();
    startQaGatewayChild.mockReset();
    startQaMockOpenAiServer.mockReset();

    startQaLabServer.mockResolvedValue({
      baseUrl: "http://127.0.0.1:58000",
      listenUrl: "http://127.0.0.1:43124",
      state: {
        getSnapshot: () => ({
          messages: [
            {
              conversation: { id: "qa-operator" },
              direction: "outbound",
              text: "Protocol note: mock reply.",
            },
          ],
        }),
      },
      stop: labStop,
    });

    startQaGatewayChild.mockResolvedValue({
      call: vi
        .fn()
        .mockResolvedValueOnce({ runId: "run-1" })
        .mockResolvedValueOnce({ status: "ok" }),
      stop: gatewayStop,
    });

    startQaMockOpenAiServer.mockResolvedValue({
      baseUrl: "http://127.0.0.1:44080",
      stop: mockStop,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts the mock provider and threads its base url into the gateway child", async () => {
    const result = await runQaManualLane({
      alternateModel: "mock-openai/gpt-5.4-alt",
      message: "check the kickoff file",
      primaryModel: "mock-openai/gpt-5.4",
      providerMode: "mock-openai",
      repoRoot: "/tmp/openclaw-repo",
      timeoutMs: 5000,
    });

    expect(startQaMockOpenAiServer).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 0,
    });
    expect(startQaGatewayChild).toHaveBeenCalledWith(
      expect.objectContaining({
        providerBaseUrl: "http://127.0.0.1:44080/v1",
        providerMode: "mock-openai",
        repoRoot: "/tmp/openclaw-repo",
      }),
    );
    expect(startQaLabServer).toHaveBeenCalledWith({
      embeddedGateway: "disabled",
      repoRoot: "/tmp/openclaw-repo",
    });
    expect(result.reply).toBe("Protocol note: mock reply.");
    expect(gatewayStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(labStop).toHaveBeenCalledTimes(1);
  });

  it("skips the mock provider bootstrap for live frontier runs", async () => {
    const result = await runQaManualLane({
      alternateModel: "openai/gpt-5.4",
      message: "check the kickoff file",
      primaryModel: "openai/gpt-5.4",
      providerMode: "live-frontier",
      repoRoot: "/tmp/openclaw-repo",
      timeoutMs: 5000,
    });

    expect(startQaMockOpenAiServer).not.toHaveBeenCalled();
    expect(startQaLabServer).toHaveBeenCalledWith({
      embeddedGateway: "disabled",
      repoRoot: "/tmp/openclaw-repo",
    });
    expect(startQaGatewayChild).toHaveBeenCalledWith(
      expect.objectContaining({
        providerBaseUrl: undefined,
        providerMode: "live-frontier",
      }),
    );
    expect(result.reply).toBe("Protocol note: mock reply.");
  });
});
