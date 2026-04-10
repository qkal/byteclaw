import crypto from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type {
  EndReason,
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookParseOptions,
  WebhookVerificationResult,
} from "../types.js";
import type { VoiceCallProvider } from "./base.js";

/**
 * Mock voice call provider for local testing.
 *
 * Events are driven via webhook POST with JSON body:
 * - { events: NormalizedEvent[] } for bulk events
 * - { event: NormalizedEvent } for single event
 */
export class MockProvider implements VoiceCallProvider {
  readonly name = "mock" as const;

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true };
  }

  parseWebhookEvent(
    ctx: WebhookContext,
    _options?: WebhookParseOptions,
  ): ProviderWebhookParseResult {
    try {
      const payload = JSON.parse(ctx.rawBody);
      const events: NormalizedEvent[] = [];

      if (Array.isArray(payload.events)) {
        for (const evt of payload.events) {
          const normalized = this.normalizeEvent(evt);
          if (normalized) {
            events.push(normalized);
          }
        }
      } else if (payload.event) {
        const normalized = this.normalizeEvent(payload.event);
        if (normalized) {
          events.push(normalized);
        }
      }

      return { events, statusCode: 200 };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  private normalizeEvent(evt: Partial<NormalizedEvent>): NormalizedEvent | null {
    if (!evt.type || !evt.callId) {
      return null;
    }

    const base = {
      callId: evt.callId,
      id: evt.id ?? crypto.randomUUID(),
      providerCallId: evt.providerCallId,
      timestamp: evt.timestamp ?? Date.now(),
    };

    switch (evt.type) {
      case "call.initiated":
      case "call.ringing":
      case "call.answered":
      case "call.active": {
        return { ...base, type: evt.type };
      }

      case "call.speaking": {
        const payload = evt as Partial<NormalizedEvent & { text?: string }>;
        return {
          ...base,
          text: payload.text ?? "",
          type: evt.type,
        };
      }

      case "call.speech": {
        const payload = evt as Partial<
          NormalizedEvent & {
            transcript?: string;
            isFinal?: boolean;
            confidence?: number;
          }
        >;
        return {
          ...base,
          confidence: payload.confidence,
          isFinal: payload.isFinal ?? true,
          transcript: payload.transcript ?? "",
          type: evt.type,
        };
      }

      case "call.silence": {
        const payload = evt as Partial<NormalizedEvent & { durationMs?: number }>;
        return {
          ...base,
          durationMs: payload.durationMs ?? 0,
          type: evt.type,
        };
      }

      case "call.dtmf": {
        const payload = evt as Partial<NormalizedEvent & { digits?: string }>;
        return {
          ...base,
          digits: payload.digits ?? "",
          type: evt.type,
        };
      }

      case "call.ended": {
        const payload = evt as Partial<NormalizedEvent & { reason?: EndReason }>;
        return {
          ...base,
          reason: payload.reason ?? "completed",
          type: evt.type,
        };
      }

      case "call.error": {
        const payload = evt as Partial<NormalizedEvent & { error?: string; retryable?: boolean }>;
        return {
          ...base,
          error: payload.error ?? "unknown error",
          retryable: payload.retryable,
          type: evt.type,
        };
      }

      default: {
        return null;
      }
    }
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    return {
      providerCallId: `mock-${input.callId}`,
      status: "initiated",
    };
  }

  async hangupCall(_input: HangupCallInput): Promise<void> {
    // No-op for mock
  }

  async playTts(_input: PlayTtsInput): Promise<void> {
    // No-op for mock
  }

  async startListening(_input: StartListeningInput): Promise<void> {
    // No-op for mock
  }

  async stopListening(_input: StopListeningInput): Promise<void> {
    // No-op for mock
  }

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    const id = normalizeLowercaseStringOrEmpty(input.providerCallId);
    if (id.includes("stale") || id.includes("ended") || id.includes("completed")) {
      return { isTerminal: true, status: "completed" };
    }
    return { isTerminal: false, status: "in-progress" };
  }
}
