import { describe, expect, it } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import {
  FakeProvider,
  createTestStorePath,
  makePersistedCall,
  writeCallsToStore,
} from "./manager.test-harness.js";

function requireSingleActiveCall(manager: CallManager) {
  const activeCalls = manager.getActiveCalls();
  expect(activeCalls).toHaveLength(1);
  const activeCall = activeCalls[0];
  if (!activeCall) {
    throw new Error("expected restored active call");
  }
  return activeCall;
}

describe("CallManager verification on restore", () => {
  async function initializeManager(params?: {
    callOverrides?: Parameters<typeof makePersistedCall>[0];
    providerResult?: FakeProvider["getCallStatusResult"];
    configureProvider?: (provider: FakeProvider) => void;
    configOverrides?: Partial<{ maxDurationSeconds: number }>;
  }) {
    const storePath = createTestStorePath();
    const call = makePersistedCall(params?.callOverrides);
    writeCallsToStore(storePath, [call]);

    const provider = new FakeProvider();
    if (params?.providerResult) {
      provider.getCallStatusResult = params.providerResult;
    }
    params?.configureProvider?.(provider);

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      fromNumber: "+15550000000",
      provider: "plivo",
      ...params?.configOverrides,
    });
    const manager = new CallManager(config, storePath);
    await manager.initialize(provider, "https://example.com/voice/webhook");

    return { call, manager };
  }

  it("skips stale calls reported terminal by provider", async () => {
    const { manager } = await initializeManager({
      providerResult: { isTerminal: true, status: "completed" },
    });

    expect(manager.getActiveCalls()).toHaveLength(0);
  });

  it("keeps calls reported active by provider", async () => {
    const { call, manager } = await initializeManager({
      providerResult: { isTerminal: false, status: "in-progress" },
    });

    const activeCall = requireSingleActiveCall(manager);
    expect(activeCall.callId).toBe(call.callId);
  });

  it("keeps calls when provider returns unknown (transient error)", async () => {
    const { call, manager } = await initializeManager({
      providerResult: { isTerminal: false, isUnknown: true, status: "error" },
    });

    const activeCall = requireSingleActiveCall(manager);
    expect(activeCall.callId).toBe(call.callId);
    expect(activeCall.state).toBe(call.state);
  });

  it("skips calls older than maxDurationSeconds", async () => {
    const { manager } = await initializeManager({
      callOverrides: {
        answeredAt: Date.now() - 590_000,
        startedAt: Date.now() - 600_000,
      },
      configOverrides: { maxDurationSeconds: 300 },
    });

    expect(manager.getActiveCalls()).toHaveLength(0);
  });

  it("skips calls without providerCallId", async () => {
    const { manager } = await initializeManager({
      callOverrides: { providerCallId: undefined, state: "initiated" },
    });

    expect(manager.getActiveCalls()).toHaveLength(0);
  });

  it("keeps call when getCallStatus throws (verification failure)", async () => {
    const { call, manager } = await initializeManager({
      configureProvider: (provider) => {
        provider.getCallStatus = async () => {
          throw new Error("network failure");
        };
      },
    });

    const activeCall = requireSingleActiveCall(manager);
    expect(activeCall.callId).toBe(call.callId);
    expect(activeCall.state).toBe(call.state);
  });
});
