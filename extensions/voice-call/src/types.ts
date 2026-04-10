import { z } from "openclaw/plugin-sdk/zod";
import type { CallMode } from "./config.js";

// -----------------------------------------------------------------------------
// Provider Identifiers
// -----------------------------------------------------------------------------

export const ProviderNameSchema = z.enum(["telnyx", "twilio", "plivo", "mock"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

// -----------------------------------------------------------------------------
// Core Call Identifiers
// -----------------------------------------------------------------------------

/** Internal call identifier (UUID) */
export type CallId = string;

/** Provider-specific call identifier */
export type ProviderCallId = string;

// -----------------------------------------------------------------------------
// Call Lifecycle States
// -----------------------------------------------------------------------------

export const CallStateSchema = z.enum([
  // Non-terminal states
  "initiated",
  "ringing",
  "answered",
  "active",
  "speaking",
  "listening",
  // Terminal states
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
]);
export type CallState = z.infer<typeof CallStateSchema>;

export const TerminalStates = new Set<CallState>([
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
]);

export const EndReasonSchema = z.enum([
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
]);
export type EndReason = z.infer<typeof EndReasonSchema>;

// -----------------------------------------------------------------------------
// Normalized Call Events
// -----------------------------------------------------------------------------

const BaseEventSchema = z.object({
  id: z.string(),
  // Stable provider-derived key for idempotency/replay dedupe.
  dedupeKey: z.string().optional(),
  callId: z.string(),
  providerCallId: z.string().optional(),
  timestamp: z.number(),
  // Optional per-turn nonce for speech events (Twilio <Gather> replay hardening).
  turnToken: z.string().optional(),
  // Optional fields for inbound call detection
  direction: z.enum(["inbound", "outbound"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const NormalizedEventSchema = z.discriminatedUnion("type", [
  BaseEventSchema.extend({
    type: z.literal("call.initiated"),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.ringing"),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.answered"),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.active"),
  }),
  BaseEventSchema.extend({
    text: z.string(),
    type: z.literal("call.speaking"),
  }),
  BaseEventSchema.extend({
    confidence: z.number().min(0).max(1).optional(),
    isFinal: z.boolean(),
    transcript: z.string(),
    type: z.literal("call.speech"),
  }),
  BaseEventSchema.extend({
    durationMs: z.number(),
    type: z.literal("call.silence"),
  }),
  BaseEventSchema.extend({
    digits: z.string(),
    type: z.literal("call.dtmf"),
  }),
  BaseEventSchema.extend({
    reason: EndReasonSchema,
    type: z.literal("call.ended"),
  }),
  BaseEventSchema.extend({
    error: z.string(),
    retryable: z.boolean().optional(),
    type: z.literal("call.error"),
  }),
]);
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

// -----------------------------------------------------------------------------
// Call Direction
// -----------------------------------------------------------------------------

export const CallDirectionSchema = z.enum(["outbound", "inbound"]);
export type CallDirection = z.infer<typeof CallDirectionSchema>;

// -----------------------------------------------------------------------------
// Call Record
// -----------------------------------------------------------------------------

export const TranscriptEntrySchema = z.object({
  isFinal: z.boolean().default(true),
  speaker: z.enum(["bot", "user"]),
  text: z.string(),
  timestamp: z.number(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const CallRecordSchema = z.object({
  answeredAt: z.number().optional(),
  callId: z.string(),
  direction: CallDirectionSchema,
  endReason: EndReasonSchema.optional(),
  endedAt: z.number().optional(),
  from: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  processedEventIds: z.array(z.string()).default([]),
  provider: ProviderNameSchema,
  providerCallId: z.string().optional(),
  sessionKey: z.string().optional(),
  startedAt: z.number(),
  state: CallStateSchema,
  to: z.string(),
  transcript: z.array(TranscriptEntrySchema).default([]),
});
export type CallRecord = z.infer<typeof CallRecordSchema>;

// -----------------------------------------------------------------------------
// Webhook Types
// -----------------------------------------------------------------------------

export interface WebhookVerificationResult {
  ok: boolean;
  reason?: string;
  /** Signature is valid, but request was seen before within replay window. */
  isReplay?: boolean;
  /** Stable key derived from authenticated request material. */
  verifiedRequestKey?: string;
}

export interface WebhookParseOptions {
  /** Stable request key from verifyWebhook. */
  verifiedRequestKey?: string;
}

export interface WebhookContext {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  query?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
}

export interface ProviderWebhookParseResult {
  events: NormalizedEvent[];
  providerResponseBody?: string;
  providerResponseHeaders?: Record<string, string>;
  statusCode?: number;
}

// -----------------------------------------------------------------------------
// Provider Method Types
// -----------------------------------------------------------------------------

export interface InitiateCallInput {
  callId: CallId;
  from: string;
  to: string;
  webhookUrl: string;
  clientState?: Record<string, string>;
  /** Inline TwiML to execute (skips webhook, used for notify mode) */
  inlineTwiml?: string;
}

export interface InitiateCallResult {
  providerCallId: ProviderCallId;
  status: "initiated" | "queued";
}

export interface HangupCallInput {
  callId: CallId;
  providerCallId: ProviderCallId;
  reason: EndReason;
}

export interface PlayTtsInput {
  callId: CallId;
  providerCallId: ProviderCallId;
  text: string;
  voice?: string;
  locale?: string;
}

export interface StartListeningInput {
  callId: CallId;
  providerCallId: ProviderCallId;
  language?: string;
  /** Optional per-turn nonce for provider callbacks (replay hardening). */
  turnToken?: string;
}

export interface StopListeningInput {
  callId: CallId;
  providerCallId: ProviderCallId;
}

// -----------------------------------------------------------------------------
// Call Status Verification (used on restart to verify persisted calls)
// -----------------------------------------------------------------------------

export interface GetCallStatusInput {
  providerCallId: ProviderCallId;
}

export interface GetCallStatusResult {
  /** Provider-specific status string (e.g. "completed", "in-progress") */
  status: string;
  /** True when the provider confirms the call has ended */
  isTerminal: boolean;
  /** True when the status could not be determined (transient error) */
  isUnknown?: boolean;
}

// -----------------------------------------------------------------------------
// Outbound Call Options
// -----------------------------------------------------------------------------

export interface OutboundCallOptions {
  /** Message to speak when call connects */
  message?: string;
  /** Call mode (overrides config default) */
  mode?: CallMode;
}

// -----------------------------------------------------------------------------
// Tool Result Types
// -----------------------------------------------------------------------------

export interface InitiateCallToolResult {
  success: boolean;
  callId?: string;
  status?: "initiated" | "queued" | "no-answer" | "busy" | "failed";
  error?: string;
}

export interface ContinueCallToolResult {
  success: boolean;
  transcript?: string;
  error?: string;
}

export interface SpeakToUserToolResult {
  success: boolean;
  error?: string;
}

export interface EndCallToolResult {
  success: boolean;
  error?: string;
}
