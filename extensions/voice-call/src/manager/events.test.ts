import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VoiceCallConfigSchema } from "../config.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { HangupCallInput, NormalizedEvent } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { processEvent } from "./events.js";

function createContext(overrides: Partial<CallManagerContext> = {}): CallManagerContext {
  const storePath = path.join(os.tmpdir(), `openclaw-voice-call-events-test-${Date.now()}`);
  fs.mkdirSync(storePath, { recursive: true });
  return {
    activeCalls: new Map(),
    activeTurnCalls: new Set(),
    config: VoiceCallConfigSchema.parse({
      enabled: true,
      fromNumber: "+15550000000",
      provider: "plivo",
    }),
    initialMessageInFlight: new Set(),
    maxDurationTimers: new Map(),
    processedEventIds: new Set(),
    provider: null,
    providerCallIdMap: new Map(),
    rejectedProviderCallIds: new Set(),
    storePath,
    transcriptWaiters: new Map(),
    webhookUrl: null,
    ...overrides,
  };
}

function createProvider(overrides: Partial<VoiceCallProvider> = {}): VoiceCallProvider {
  return {
    getCallStatus: async () => ({ isTerminal: false, status: "in-progress" }),
    hangupCall: async () => {},
    initiateCall: async () => ({ providerCallId: "provider-call-id", status: "initiated" }),
    name: "plivo",
    parseWebhookEvent: () => ({ events: [] }),
    playTts: async () => {},
    startListening: async () => {},
    stopListening: async () => {},
    verifyWebhook: () => ({ ok: true }),
    ...overrides,
  };
}

function createInboundDisabledConfig() {
  return VoiceCallConfigSchema.parse({
    enabled: true,
    fromNumber: "+15550000000",
    inboundPolicy: "disabled",
    provider: "plivo",
  });
}

function createInboundInitiatedEvent(params: {
  id: string;
  providerCallId: string;
  from: string;
}): NormalizedEvent {
  return {
    callId: params.providerCallId,
    direction: "inbound",
    from: params.from,
    id: params.id,
    providerCallId: params.providerCallId,
    timestamp: Date.now(),
    to: "+15550000000",
    type: "call.initiated",
  };
}

function createRejectingInboundContext(): {
  ctx: CallManagerContext;
  hangupCalls: HangupCallInput[];
} {
  const hangupCalls: HangupCallInput[] = [];
  const provider = createProvider({
    hangupCall: async (input: HangupCallInput): Promise<void> => {
      hangupCalls.push(input);
    },
  });
  const ctx = createContext({
    config: createInboundDisabledConfig(),
    provider,
  });
  return { ctx, hangupCalls };
}

function requireFirstActiveCall(ctx: CallManagerContext) {
  const call = [...ctx.activeCalls.values()][0];
  if (!call) {
    throw new Error("expected one active call");
  }
  return call;
}

describe("processEvent (functional)", () => {
  it("calls provider hangup when rejecting inbound call", () => {
    const { ctx, hangupCalls } = createRejectingInboundContext();
    const event = createInboundInitiatedEvent({
      from: "+15559999999",
      id: "evt-1",
      providerCallId: "prov-1",
    });

    processEvent(ctx, event);

    expect(ctx.activeCalls.size).toBe(0);
    expect(hangupCalls).toHaveLength(1);
    expect(hangupCalls[0]).toEqual({
      callId: "prov-1",
      providerCallId: "prov-1",
      reason: "hangup-bot",
    });
  });

  it("does not call hangup when provider is null", () => {
    const ctx = createContext({
      config: createInboundDisabledConfig(),
      provider: null,
    });
    const event = createInboundInitiatedEvent({
      from: "+15551111111",
      id: "evt-2",
      providerCallId: "prov-2",
    });

    processEvent(ctx, event);

    expect(ctx.activeCalls.size).toBe(0);
  });

  it("calls hangup only once for duplicate events for same rejected call", () => {
    const { ctx, hangupCalls } = createRejectingInboundContext();
    const event1 = createInboundInitiatedEvent({
      from: "+15552222222",
      id: "evt-init",
      providerCallId: "prov-dup",
    });
    const event2: NormalizedEvent = {
      callId: "prov-dup",
      direction: "inbound",
      from: "+15552222222",
      id: "evt-ring",
      providerCallId: "prov-dup",
      timestamp: Date.now(),
      to: "+15550000000",
      type: "call.ringing",
    };

    processEvent(ctx, event1);
    processEvent(ctx, event2);

    expect(ctx.activeCalls.size).toBe(0);
    expect(hangupCalls).toEqual([
      expect.objectContaining({
        providerCallId: "prov-dup",
        reason: "hangup-bot",
      }),
    ]);
  });

  it("updates providerCallId map when provider ID changes", () => {
    const now = Date.now();
    const ctx = createContext();
    ctx.activeCalls.set("call-1", {
      callId: "call-1",
      direction: "outbound",
      from: "+15550000000",
      metadata: {},
      processedEventIds: [],
      provider: "plivo",
      providerCallId: "request-uuid",
      startedAt: now,
      state: "initiated",
      to: "+15550000001",
      transcript: [],
    });
    ctx.providerCallIdMap.set("request-uuid", "call-1");

    processEvent(ctx, {
      callId: "call-1",
      id: "evt-provider-id-change",
      providerCallId: "call-uuid",
      timestamp: now + 1,
      type: "call.answered",
    });

    const activeCall = ctx.activeCalls.get("call-1");
    if (!activeCall) {
      throw new Error("expected active call after provider id change");
    }
    expect(activeCall.providerCallId).toBe("call-uuid");
    expect(ctx.providerCallIdMap.get("call-uuid")).toBe("call-1");
    expect(ctx.providerCallIdMap.has("request-uuid")).toBe(false);
  });

  it("invokes onCallAnswered hook for answered events", () => {
    const now = Date.now();
    let answeredCallId: string | null = null;
    const ctx = createContext({
      onCallAnswered: (call) => {
        answeredCallId = call.callId;
      },
    });
    ctx.activeCalls.set("call-2", {
      callId: "call-2",
      direction: "inbound",
      from: "+15550000002",
      metadata: {},
      processedEventIds: [],
      provider: "plivo",
      providerCallId: "call-2-provider",
      startedAt: now,
      state: "ringing",
      to: "+15550000000",
      transcript: [],
    });
    ctx.providerCallIdMap.set("call-2-provider", "call-2");

    processEvent(ctx, {
      callId: "call-2",
      id: "evt-answered-hook",
      providerCallId: "call-2-provider",
      timestamp: now + 1,
      type: "call.answered",
    });

    expect(answeredCallId).toBe("call-2");
  });

  it("when hangup throws, logs and does not throw", () => {
    const provider = createProvider({
      hangupCall: async (): Promise<void> => {
        throw new Error("provider down");
      },
    });
    const ctx = createContext({
      config: createInboundDisabledConfig(),
      provider,
    });
    const event = createInboundInitiatedEvent({
      from: "+15553333333",
      id: "evt-fail",
      providerCallId: "prov-fail",
    });

    expect(() => processEvent(ctx, event)).not.toThrow();
    expect(ctx.activeCalls.size).toBe(0);
  });

  it("auto-registers externally-initiated outbound-api calls with correct direction", () => {
    const ctx = createContext();
    const event: NormalizedEvent = {
      callId: "CA-external-123",
      direction: "outbound",
      from: "+15550000000",
      id: "evt-external-1",
      providerCallId: "CA-external-123",
      timestamp: Date.now(),
      to: "+15559876543",
      type: "call.initiated",
    };

    processEvent(ctx, event);

    // Call should be registered in activeCalls and providerCallIdMap
    expect(ctx.activeCalls.size).toBe(1);
    const call = requireFirstActiveCall(ctx);
    expect(ctx.providerCallIdMap.get("CA-external-123")).toBe(call.callId);
    expect(call.providerCallId).toBe("CA-external-123");
    expect(call.direction).toBe("outbound");
    expect(call.from).toBe("+15550000000");
    expect(call.to).toBe("+15559876543");
  });

  it("does not reject externally-initiated outbound calls even with disabled inbound policy", () => {
    const { ctx, hangupCalls } = createRejectingInboundContext();
    const event: NormalizedEvent = {
      callId: "CA-external-456",
      direction: "outbound",
      from: "+15550000000",
      id: "evt-external-2",
      providerCallId: "CA-external-456",
      timestamp: Date.now(),
      to: "+15559876543",
      type: "call.initiated",
    };

    processEvent(ctx, event);

    // External outbound calls bypass inbound policy — they should be accepted
    expect(ctx.activeCalls.size).toBe(1);
    expect(hangupCalls).toHaveLength(0);
    const call = requireFirstActiveCall(ctx);
    expect(call.direction).toBe("outbound");
  });

  it("preserves inbound direction for auto-registered inbound calls", () => {
    const ctx = createContext({
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        fromNumber: "+15550000000",
        inboundPolicy: "open",
        provider: "plivo",
      }),
    });
    const event: NormalizedEvent = {
      callId: "CA-inbound-789",
      direction: "inbound",
      from: "+15554444444",
      id: "evt-inbound-dir",
      providerCallId: "CA-inbound-789",
      timestamp: Date.now(),
      to: "+15550000000",
      type: "call.initiated",
    };

    processEvent(ctx, event);

    expect(ctx.activeCalls.size).toBe(1);
    const call = requireFirstActiveCall(ctx);
    expect(call.direction).toBe("inbound");
  });

  it("deduplicates by dedupeKey even when event IDs differ", () => {
    const now = Date.now();
    const ctx = createContext();
    ctx.activeCalls.set("call-dedupe", {
      callId: "call-dedupe",
      direction: "outbound",
      from: "+15550000000",
      metadata: {},
      processedEventIds: [],
      provider: "plivo",
      providerCallId: "provider-dedupe",
      startedAt: now,
      state: "answered",
      to: "+15550000001",
      transcript: [],
    });
    ctx.providerCallIdMap.set("provider-dedupe", "call-dedupe");

    processEvent(ctx, {
      callId: "call-dedupe",
      dedupeKey: "stable-key-1",
      id: "evt-1",
      isFinal: true,
      providerCallId: "provider-dedupe",
      timestamp: now + 1,
      transcript: "hello",
      type: "call.speech",
    });

    processEvent(ctx, {
      callId: "call-dedupe",
      dedupeKey: "stable-key-1",
      id: "evt-2",
      isFinal: true,
      providerCallId: "provider-dedupe",
      timestamp: now + 2,
      transcript: "hello",
      type: "call.speech",
    });

    const call = ctx.activeCalls.get("call-dedupe");
    if (!call) {
      throw new Error("expected deduped call to remain active");
    }
    expect(call.transcript).toHaveLength(1);
    expect([...ctx.processedEventIds]).toEqual(["stable-key-1"]);
  });
});
