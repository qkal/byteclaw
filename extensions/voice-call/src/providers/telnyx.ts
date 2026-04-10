import crypto from "node:crypto";
import type { TelnyxConfig } from "../config.js";
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
import { verifyTelnyxWebhook } from "../webhook-security.js";
import type { VoiceCallProvider } from "./base.js";
import { guardedJsonApiRequest } from "./shared/guarded-json-api.js";

/**
 * Telnyx Voice API provider implementation.
 *
 * Uses Telnyx Call Control API v2 for managing calls.
 * @see https://developers.telnyx.com/docs/api/v2/call-control
 */
export interface TelnyxProviderOptions {
  /** Skip webhook signature verification (development only, NOT for production) */
  skipVerification?: boolean;
}

export class TelnyxProvider implements VoiceCallProvider {
  readonly name = "telnyx" as const;

  private readonly apiKey: string;
  private readonly connectionId: string;
  private readonly publicKey: string | undefined;
  private readonly options: TelnyxProviderOptions;
  private readonly baseUrl = "https://api.telnyx.com/v2";
  private readonly apiHost = "api.telnyx.com";

  constructor(config: TelnyxConfig, options: TelnyxProviderOptions = {}) {
    if (!config.apiKey) {
      throw new Error("Telnyx API key is required");
    }
    if (!config.connectionId) {
      throw new Error("Telnyx connection ID is required");
    }

    this.apiKey = config.apiKey;
    this.connectionId = config.connectionId;
    this.publicKey = config.publicKey;
    this.options = options;
  }

  /**
   * Make an authenticated request to the Telnyx API.
   */
  private async apiRequest<T = unknown>(
    endpoint: string,
    body: Record<string, unknown>,
    options?: { allowNotFound?: boolean },
  ): Promise<T> {
    return await guardedJsonApiRequest<T>({
      allowNotFound: options?.allowNotFound,
      allowedHostnames: [this.apiHost],
      auditContext: "voice-call.telnyx.api",
      body,
      errorPrefix: "Telnyx API error",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      url: `${this.baseUrl}${endpoint}`,
    });
  }

  /**
   * Verify Telnyx webhook signature using Ed25519.
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    const result = verifyTelnyxWebhook(ctx, this.publicKey, {
      skipVerification: this.options.skipVerification,
    });

    return {
      isReplay: result.isReplay,
      ok: result.ok,
      reason: result.reason,
      verifiedRequestKey: result.verifiedRequestKey,
    };
  }

  /**
   * Parse Telnyx webhook event into normalized format.
   */
  parseWebhookEvent(
    ctx: WebhookContext,
    options?: WebhookParseOptions,
  ): ProviderWebhookParseResult {
    try {
      const payload = JSON.parse(ctx.rawBody);
      const { data } = payload;

      if (!data || !data.event_type) {
        return { events: [], statusCode: 200 };
      }

      const event = this.normalizeEvent(data, options?.verifiedRequestKey);
      return {
        events: event ? [event] : [],
        statusCode: 200,
      };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  /**
   * Convert Telnyx event to normalized event format.
   */
  private normalizeEvent(data: TelnyxEvent, dedupeKey?: string): NormalizedEvent | null {
    // Decode client_state from Base64 (we encode it in initiateCall)
    let callId = "";
    if (data.payload?.client_state) {
      try {
        callId = Buffer.from(data.payload.client_state, "base64").toString("utf8");
      } catch {
        // Fallback if not valid Base64
        callId = data.payload.client_state;
      }
    }
    if (!callId) {
      callId = data.payload?.call_control_id || "";
    }

    const baseEvent = {
      callId,
      dedupeKey,
      id: data.id || crypto.randomUUID(),
      providerCallId: data.payload?.call_control_id,
      timestamp: Date.now(),
    };

    switch (data.event_type) {
      case "call.initiated": {
        return { ...baseEvent, type: "call.initiated" };
      }

      case "call.ringing": {
        return { ...baseEvent, type: "call.ringing" };
      }

      case "call.answered": {
        return { ...baseEvent, type: "call.answered" };
      }

      case "call.bridged": {
        return { ...baseEvent, type: "call.active" };
      }

      case "call.speak.started": {
        return {
          ...baseEvent,
          text: data.payload?.text || "",
          type: "call.speaking",
        };
      }

      case "call.transcription": {
        return {
          ...baseEvent,
          confidence: data.payload?.confidence,
          isFinal: data.payload?.is_final ?? true,
          transcript: data.payload?.transcription || "",
          type: "call.speech",
        };
      }

      case "call.hangup": {
        return {
          ...baseEvent,
          reason: this.mapHangupCause(data.payload?.hangup_cause),
          type: "call.ended",
        };
      }

      case "call.dtmf.received": {
        return {
          ...baseEvent,
          digits: data.payload?.digit || "",
          type: "call.dtmf",
        };
      }

      default: {
        return null;
      }
    }
  }

  /**
   * Map Telnyx hangup cause to normalized end reason.
   * @see https://developers.telnyx.com/docs/api/v2/call-control/Call-Commands#hangup-causes
   */
  private mapHangupCause(cause?: string): EndReason {
    switch (cause) {
      case "normal_clearing":
      case "normal_unspecified": {
        return "completed";
      }
      case "originator_cancel": {
        return "hangup-bot";
      }
      case "call_rejected":
      case "user_busy": {
        return "busy";
      }
      case "no_answer":
      case "no_user_response": {
        return "no-answer";
      }
      case "destination_out_of_order":
      case "network_out_of_order":
      case "service_unavailable":
      case "recovery_on_timer_expire": {
        return "failed";
      }
      case "machine_detected":
      case "fax_detected": {
        return "voicemail";
      }
      case "user_hangup":
      case "subscriber_absent": {
        return "hangup-user";
      }
      default: {
        // Unknown cause - log it for debugging and return completed
        if (cause) {
          console.warn(`[telnyx] Unknown hangup cause: ${cause}`);
        }
        return "completed";
      }
    }
  }

  /**
   * Initiate an outbound call via Telnyx API.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const result = await this.apiRequest<TelnyxCallResponse>("/calls", {
      client_state: Buffer.from(input.callId).toString("base64"),
      connection_id: this.connectionId,
      from: input.from,
      timeout_secs: 30,
      to: input.to,
      webhook_url: input.webhookUrl,
      webhook_url_method: "POST",
    });

    return {
      providerCallId: result.data.call_control_id,
      status: "initiated",
    };
  }

  /**
   * Hang up a call via Telnyx API.
   */
  async hangupCall(input: HangupCallInput): Promise<void> {
    await this.apiRequest(
      `/calls/${input.providerCallId}/actions/hangup`,
      { command_id: crypto.randomUUID() },
      { allowNotFound: true },
    );
  }

  /**
   * Play TTS audio via Telnyx speak action.
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    await this.apiRequest(`/calls/${input.providerCallId}/actions/speak`, {
      command_id: crypto.randomUUID(),
      language: input.locale || "en-US",
      payload: input.text,
      voice: input.voice || "female",
    });
  }

  /**
   * Start transcription (STT) via Telnyx.
   */
  async startListening(input: StartListeningInput): Promise<void> {
    await this.apiRequest(`/calls/${input.providerCallId}/actions/transcription_start`, {
      command_id: crypto.randomUUID(),
      language: input.language || "en",
    });
  }

  /**
   * Stop transcription via Telnyx.
   */
  async stopListening(input: StopListeningInput): Promise<void> {
    await this.apiRequest(
      `/calls/${input.providerCallId}/actions/transcription_stop`,
      { command_id: crypto.randomUUID() },
      { allowNotFound: true },
    );
  }

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    try {
      const data = await guardedJsonApiRequest<{ data?: { state?: string; is_alive?: boolean } }>({
        allowNotFound: true,
        allowedHostnames: [this.apiHost],
        auditContext: "telnyx-get-call-status",
        errorPrefix: "Telnyx get call status error",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        method: "GET",
        url: `${this.baseUrl}/calls/${input.providerCallId}`,
      });

      if (!data) {
        return { isTerminal: true, status: "not-found" };
      }

      const state = data.data?.state ?? "unknown";
      const isAlive = data.data?.is_alive;
      // If is_alive is missing, treat as unknown rather than terminal (P1 fix)
      if (isAlive === undefined) {
        return { isTerminal: false, isUnknown: true, status: state };
      }
      return { isTerminal: !isAlive, status: state };
    } catch {
      return { isTerminal: false, isUnknown: true, status: "error" };
    }
  }
}

// -----------------------------------------------------------------------------
// Telnyx-specific types
// -----------------------------------------------------------------------------

interface TelnyxEvent {
  id?: string;
  event_type: string;
  payload?: {
    call_control_id?: string;
    client_state?: string;
    text?: string;
    transcription?: string;
    is_final?: boolean;
    confidence?: number;
    hangup_cause?: string;
    digit?: string;
    [key: string]: unknown;
  };
}

interface TelnyxCallResponse {
  data: {
    call_control_id: string;
    call_leg_id: string;
    call_session_id: string;
    is_alive: boolean;
    record_type: string;
  };
}
