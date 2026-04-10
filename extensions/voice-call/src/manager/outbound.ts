import crypto from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { CallMode } from "../config.js";
import { resolvePreferredTtsVoice } from "../tts-provider-voice.js";
import {
  type CallId,
  type CallRecord,
  type EndReason,
  type OutboundCallOptions,
  TerminalStates,
} from "../types.js";
import { mapVoiceToPolly } from "../voice-mapping.js";
import type { CallManagerContext } from "./context.js";
import { finalizeCall } from "./lifecycle.js";
import { getCallByProviderCallId } from "./lookup.js";
import { addTranscriptEntry, transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import { clearTranscriptWaiter, waitForFinalTranscript } from "./timers.js";
import { generateNotifyTwiml } from "./twiml.js";

type InitiateContext = Pick<
  CallManagerContext,
  "activeCalls" | "providerCallIdMap" | "provider" | "config" | "storePath" | "webhookUrl"
>;

type SpeakContext = Pick<
  CallManagerContext,
  "activeCalls" | "providerCallIdMap" | "provider" | "config" | "storePath"
>;

type ConversationContext = Pick<
  CallManagerContext,
  | "activeCalls"
  | "providerCallIdMap"
  | "provider"
  | "config"
  | "storePath"
  | "activeTurnCalls"
  | "transcriptWaiters"
  | "maxDurationTimers"
  | "initialMessageInFlight"
>;

type EndCallContext = Pick<
  CallManagerContext,
  | "activeCalls"
  | "providerCallIdMap"
  | "provider"
  | "storePath"
  | "transcriptWaiters"
  | "maxDurationTimers"
>;

type ConnectedCallContext = Pick<CallManagerContext, "activeCalls" | "provider">;

type ConnectedCallLookup =
  | { kind: "error"; error: string }
  | { kind: "ended"; call: CallRecord }
  | {
      kind: "ok";
      call: CallRecord;
      providerCallId: string;
      provider: NonNullable<ConnectedCallContext["provider"]>;
    };

type ConnectedCallResolution =
  | { ok: false; error: string }
  | {
      ok: true;
      call: CallRecord;
      providerCallId: string;
      provider: NonNullable<ConnectedCallContext["provider"]>;
    };

function lookupConnectedCall(ctx: ConnectedCallContext, callId: CallId): ConnectedCallLookup {
  const call = ctx.activeCalls.get(callId);
  if (!call) {
    return { error: "Call not found", kind: "error" };
  }
  if (!ctx.provider || !call.providerCallId) {
    return { error: "Call not connected", kind: "error" };
  }
  if (TerminalStates.has(call.state)) {
    return { call, kind: "ended" };
  }
  return { call, kind: "ok", provider: ctx.provider, providerCallId: call.providerCallId };
}

function requireConnectedCall(ctx: ConnectedCallContext, callId: CallId): ConnectedCallResolution {
  const lookup = lookupConnectedCall(ctx, callId);
  if (lookup.kind === "error") {
    return { error: lookup.error, ok: false };
  }
  if (lookup.kind === "ended") {
    return { error: "Call has ended", ok: false };
  }
  return {
    call: lookup.call,
    ok: true,
    provider: lookup.provider,
    providerCallId: lookup.providerCallId,
  };
}

export async function initiateCall(
  ctx: InitiateContext,
  to: string,
  sessionKey?: string,
  options?: OutboundCallOptions | string,
): Promise<{ callId: CallId; success: boolean; error?: string }> {
  const opts: OutboundCallOptions =
    typeof options === "string" ? { message: options } : (options ?? {});
  const initialMessage = opts.message;
  const mode = opts.mode ?? ctx.config.outbound.defaultMode;

  if (!ctx.provider) {
    return { callId: "", error: "Provider not initialized", success: false };
  }
  if (!ctx.webhookUrl) {
    return { callId: "", error: "Webhook URL not configured", success: false };
  }

  if (ctx.activeCalls.size >= ctx.config.maxConcurrentCalls) {
    return {
      callId: "",
      error: `Maximum concurrent calls (${ctx.config.maxConcurrentCalls}) reached`,
      success: false,
    };
  }

  const callId = crypto.randomUUID();
  const from =
    ctx.config.fromNumber || (ctx.provider?.name === "mock" ? "+15550000000" : undefined);
  if (!from) {
    return { callId: "", error: "fromNumber not configured", success: false };
  }

  const callRecord: CallRecord = {
    callId,
    direction: "outbound",
    from,
    metadata: {
      ...(initialMessage && { initialMessage }),
      mode,
    },
    processedEventIds: [],
    provider: ctx.provider.name,
    sessionKey,
    startedAt: Date.now(),
    state: "initiated",
    to,
    transcript: [],
  };

  ctx.activeCalls.set(callId, callRecord);
  persistCallRecord(ctx.storePath, callRecord);

  try {
    // For notify mode with a message, use inline TwiML with <Say>.
    let inlineTwiml: string | undefined;
    if (mode === "notify" && initialMessage) {
      const pollyVoice = mapVoiceToPolly(resolvePreferredTtsVoice(ctx.config));
      inlineTwiml = generateNotifyTwiml(initialMessage, pollyVoice);
      console.log(`[voice-call] Using inline TwiML for notify mode (voice: ${pollyVoice})`);
    }

    const result = await ctx.provider.initiateCall({
      callId,
      from,
      inlineTwiml,
      to,
      webhookUrl: ctx.webhookUrl,
    });

    callRecord.providerCallId = result.providerCallId;
    ctx.providerCallIdMap.set(result.providerCallId, callId);
    persistCallRecord(ctx.storePath, callRecord);

    return { callId, success: true };
  } catch (error) {
    finalizeCall({
      call: callRecord,
      ctx,
      endReason: "failed",
    });

    return {
      callId,
      error: formatErrorMessage(error),
      success: false,
    };
  }
}

export async function speak(
  ctx: SpeakContext,
  callId: CallId,
  text: string,
): Promise<{ success: boolean; error?: string }> {
  const connected = requireConnectedCall(ctx, callId);
  if (!connected.ok) {
    return { error: connected.error, success: false };
  }
  const { call, providerCallId, provider } = connected;

  try {
    transitionState(call, "speaking");
    persistCallRecord(ctx.storePath, call);

    const voice = provider.name === "twilio" ? resolvePreferredTtsVoice(ctx.config) : undefined;
    await provider.playTts({
      callId,
      providerCallId,
      text,
      voice,
    });

    addTranscriptEntry(call, "bot", text);
    persistCallRecord(ctx.storePath, call);

    return { success: true };
  } catch (error) {
    // A failed playback should not leave the call stuck in speaking state.
    transitionState(call, "listening");
    persistCallRecord(ctx.storePath, call);
    return { error: formatErrorMessage(error), success: false };
  }
}

export async function speakInitialMessage(
  ctx: ConversationContext,
  providerCallId: string,
): Promise<void> {
  const call = getCallByProviderCallId({
    activeCalls: ctx.activeCalls,
    providerCallId,
    providerCallIdMap: ctx.providerCallIdMap,
  });
  if (!call) {
    console.warn(`[voice-call] speakInitialMessage: no call found for ${providerCallId}`);
    return;
  }

  const initialMessage = call.metadata?.initialMessage as string | undefined;
  const mode = (call.metadata?.mode as CallMode) ?? "conversation";

  if (!initialMessage) {
    console.log(`[voice-call] speakInitialMessage: no initial message for ${call.callId}`);
    return;
  }

  if (ctx.initialMessageInFlight.has(call.callId)) {
    console.log(
      `[voice-call] speakInitialMessage: initial message already in flight for ${call.callId}`,
    );
    return;
  }
  ctx.initialMessageInFlight.add(call.callId);

  try {
    console.log(`[voice-call] Speaking initial message for call ${call.callId} (mode: ${mode})`);
    const result = await speak(ctx, call.callId, initialMessage);
    if (!result.success) {
      console.warn(`[voice-call] Failed to speak initial message: ${result.error}`);
      return;
    }

    // Clear only after successful playback so transient provider failures can retry.
    if (call.metadata) {
      delete call.metadata.initialMessage;
      persistCallRecord(ctx.storePath, call);
    }

    if (mode === "notify") {
      const delaySec = ctx.config.outbound.notifyHangupDelaySec;
      console.log(`[voice-call] Notify mode: auto-hangup in ${delaySec}s for call ${call.callId}`);
      setTimeout(async () => {
        const currentCall = ctx.activeCalls.get(call.callId);
        if (currentCall && !TerminalStates.has(currentCall.state)) {
          console.log(`[voice-call] Notify mode: hanging up call ${call.callId}`);
          await endCall(ctx, call.callId);
        }
      }, delaySec * 1000);
    }
  } finally {
    ctx.initialMessageInFlight.delete(call.callId);
  }
}

export async function continueCall(
  ctx: ConversationContext,
  callId: CallId,
  prompt: string,
): Promise<{ success: boolean; transcript?: string; error?: string }> {
  const connected = requireConnectedCall(ctx, callId);
  if (!connected.ok) {
    return { error: connected.error, success: false };
  }
  const { call, providerCallId, provider } = connected;

  if (ctx.activeTurnCalls.has(callId) || ctx.transcriptWaiters.has(callId)) {
    return { error: "Already waiting for transcript", success: false };
  }
  ctx.activeTurnCalls.add(callId);

  const turnStartedAt = Date.now();
  const turnToken = provider.name === "twilio" ? crypto.randomUUID() : undefined;

  try {
    await speak(ctx, callId, prompt);

    transitionState(call, "listening");
    persistCallRecord(ctx.storePath, call);

    const listenStartedAt = Date.now();
    await provider.startListening({ callId, providerCallId, turnToken });

    const transcript = await waitForFinalTranscript(ctx, callId, turnToken);
    const transcriptReceivedAt = Date.now();

    // Best-effort: stop listening after final transcript.
    await provider.stopListening({ callId, providerCallId });

    const lastTurnLatencyMs = transcriptReceivedAt - turnStartedAt;
    const lastTurnListenWaitMs = transcriptReceivedAt - listenStartedAt;
    const turnCount =
      call.metadata && typeof call.metadata.turnCount === "number"
        ? call.metadata.turnCount + 1
        : 1;

    call.metadata = {
      ...call.metadata,
      lastTurnCompletedAt: transcriptReceivedAt,
      lastTurnLatencyMs,
      lastTurnListenWaitMs,
      turnCount,
    };
    persistCallRecord(ctx.storePath, call);

    console.log(
      "[voice-call] continueCall latency call=" +
        call.callId +
        " totalMs=" +
        String(lastTurnLatencyMs) +
        " listenWaitMs=" +
        String(lastTurnListenWaitMs),
    );

    return { success: true, transcript };
  } catch (error) {
    return { error: formatErrorMessage(error), success: false };
  } finally {
    ctx.activeTurnCalls.delete(callId);
    clearTranscriptWaiter(ctx, callId);
  }
}

export async function endCall(
  ctx: EndCallContext,
  callId: CallId,
  options?: { reason?: EndReason },
): Promise<{ success: boolean; error?: string }> {
  const lookup = lookupConnectedCall(ctx, callId);
  if (lookup.kind === "error") {
    return { error: lookup.error, success: false };
  }
  if (lookup.kind === "ended") {
    return { success: true };
  }
  const { call, providerCallId, provider } = lookup;
  const reason = options?.reason ?? "hangup-bot";

  try {
    await provider.hangupCall({
      callId,
      providerCallId,
      reason,
    });

    finalizeCall({
      call,
      ctx,
      endReason: reason,
    });

    return { success: true };
  } catch (error) {
    return { error: formatErrorMessage(error), success: false };
  }
}
