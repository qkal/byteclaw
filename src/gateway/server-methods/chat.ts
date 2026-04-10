import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveThinkingDefault } from "../../agents/model-selection.js";
import { rewriteTranscriptEntriesInSessionFile } from "../../agents/pi-embedded-runner/transcript-rewrite.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import {
  extractAssistantText as extractAssistantHistoryText,
  hasAssistantPhaseMetadata,
} from "../../agents/tools/chat-history-text.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { resolveSessionFilePath } from "../../config/sessions.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { type SavedMedia, saveMediaBuffer } from "../../media/store.js";
import { createChannelReplyPipeline } from "../../plugin-sdk/channel-reply-pipeline.js";
import { type InputProvenance, normalizeInputProvenance } from "../../sessions/input-provenance.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveAssistantMessagePhase } from "../../shared/chat-message-content.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import {
  stripInlineDirectiveTagsForDisplay,
  stripInlineDirectiveTagsFromMessageForDisplay,
} from "../../utils/directive-tags.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isGatewayCliClient,
  isWebchatClient,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import {
  type ChatAbortControllerEntry,
  type ChatAbortOps,
  abortChatRunById,
  isChatStopCommandText,
  resolveChatRunExpiresAtMs,
} from "../chat-abort.js";
import {
  type ChatImageContent,
  MediaOffloadError,
  type OffloadedRef,
  parseMessageWithAttachments,
} from "../chat-attachments.js";
import { stripEnvelopeFromMessage, stripEnvelopeFromMessages } from "../chat-sanitize.js";
import { augmentChatHistoryWithCliSessionImports } from "../cli-session-history.js";
import { isSuppressedControlReplyText } from "../control-reply-text.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  hasGatewayClientCap,
} from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatInjectParams,
  validateChatSendParams,
} from "../protocol/index.js";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../protocol/schema/primitives.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import {
  capArrayByJsonBytes,
  loadSessionEntry,
  readSessionMessages,
  resolveGatewayModelSupportsImages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
import { setGatewayDedupeEntry } from "./agent-wait-dedupe.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import { buildWebchatAudioContentBlocksFromReplyPayloads } from "./chat-webchat-media.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

interface TranscriptAppendResult {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
}

type AbortOrigin = "rpc" | "stop-command";

interface AbortedPartialSnapshot {
  runId: string;
  sessionId: string;
  text: string;
  abortOrigin: AbortOrigin;
}

interface ChatAbortRequester {
  connId?: string;
  deviceId?: string;
  isAdmin: boolean;
}

export const DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS = 12_000;
const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
let chatHistoryPlaceholderEmitCount = 0;
const CHANNEL_AGNOSTIC_SESSION_SCOPES = new Set([
  "main",
  "direct",
  "dm",
  "group",
  "channel",
  "cron",
  "run",
  "subagent",
  "acp",
  "thread",
  "topic",
]);
const CHANNEL_SCOPED_SESSION_SHAPES = new Set(["direct", "dm", "group", "channel"]);

interface ChatSendDeliveryEntry {
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  origin?: {
    provider?: string;
    accountId?: string;
    threadId?: string | number;
  };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
}

interface ChatSendOriginatingRoute {
  originatingChannel: string;
  originatingTo?: string;
  accountId?: string;
  messageThreadId?: string | number;
  explicitDeliverRoute: boolean;
}

interface ChatSendExplicitOrigin {
  originatingChannel?: string;
  originatingTo?: string;
  accountId?: string;
  messageThreadId?: string;
}

interface SideResultPayload {
  kind: "btw";
  runId: string;
  sessionKey: string;
  question: string;
  text: string;
  isError?: boolean;
  ts: number;
}

function resolveChatSendOriginatingRoute(params: {
  client?: { mode?: string | null; id?: string | null } | null;
  deliver?: boolean;
  entry?: ChatSendDeliveryEntry;
  explicitOrigin?: ChatSendExplicitOrigin;
  hasConnectedClient?: boolean;
  mainKey?: string;
  sessionKey: string;
}): ChatSendOriginatingRoute {
  if (params.explicitOrigin?.originatingChannel && params.explicitOrigin.originatingTo) {
    return {
      originatingChannel: params.explicitOrigin.originatingChannel,
      originatingTo: params.explicitOrigin.originatingTo,
      ...(params.explicitOrigin.accountId ? { accountId: params.explicitOrigin.accountId } : {}),
      ...(params.explicitOrigin.messageThreadId
        ? { messageThreadId: params.explicitOrigin.messageThreadId }
        : {}),
      explicitDeliverRoute: params.deliver === true,
    };
  }
  const shouldDeliverExternally = params.deliver === true;
  if (!shouldDeliverExternally) {
    return {
      explicitDeliverRoute: false,
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
    };
  }

  const routeChannelCandidate = normalizeMessageChannel(
    params.entry?.deliveryContext?.channel ??
      params.entry?.lastChannel ??
      params.entry?.origin?.provider,
  );
  const routeToCandidate = params.entry?.deliveryContext?.to ?? params.entry?.lastTo;
  const routeAccountIdCandidate =
    params.entry?.deliveryContext?.accountId ??
    params.entry?.lastAccountId ??
    params.entry?.origin?.accountId ??
    undefined;
  const routeThreadIdCandidate =
    params.entry?.deliveryContext?.threadId ??
    params.entry?.lastThreadId ??
    params.entry?.origin?.threadId;
  if (params.sessionKey.length > CHAT_SEND_SESSION_KEY_MAX_LENGTH) {
    return {
      explicitDeliverRoute: false,
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
    };
  }

  const parsedSessionKey = parseAgentSessionKey(params.sessionKey);
  const sessionScopeParts = (parsedSessionKey?.rest ?? params.sessionKey)
    .split(":", 3)
    .filter(Boolean);
  const sessionScopeHead = sessionScopeParts[0];
  const sessionChannelHint = normalizeMessageChannel(sessionScopeHead);
  const normalizedSessionScopeHead = normalizeLowercaseStringOrEmpty(sessionScopeHead);
  const sessionPeerShapeCandidates = [sessionScopeParts[1], sessionScopeParts[2]]
    .map((part) => normalizeLowercaseStringOrEmpty(part))
    .filter(Boolean);
  const isChannelAgnosticSessionScope = CHANNEL_AGNOSTIC_SESSION_SCOPES.has(
    normalizedSessionScopeHead,
  );
  const isChannelScopedSession = sessionPeerShapeCandidates.some((part) =>
    CHANNEL_SCOPED_SESSION_SHAPES.has(part),
  );
  const hasLegacyChannelPeerShape =
    !isChannelScopedSession &&
    typeof sessionScopeParts[1] === "string" &&
    sessionChannelHint === routeChannelCandidate;
  const isFromWebchatClient = isWebchatClient(params.client);
  const isFromGatewayCliClient = isGatewayCliClient(params.client);
  const hasClientMetadata =
    (typeof params.client?.mode === "string" && params.client.mode.trim().length > 0) ||
    (typeof params.client?.id === "string" && params.client.id.trim().length > 0);
  const configuredMainKey = normalizeLowercaseStringOrEmpty(params.mainKey ?? "main");
  const isConfiguredMainSessionScope =
    normalizedSessionScopeHead.length > 0 && normalizedSessionScopeHead === configuredMainKey;
  const canInheritConfiguredMainRoute =
    isConfiguredMainSessionScope &&
    params.hasConnectedClient &&
    (isFromGatewayCliClient || !hasClientMetadata);

  // Webchat clients never inherit external delivery routes. Configured-main
  // Sessions are stricter than channel-scoped sessions: only CLI callers, or
  // Legacy callers with no client metadata, may inherit the last external route.
  const canInheritDeliverableRoute = Boolean(
    !isFromWebchatClient &&
    sessionChannelHint &&
    sessionChannelHint !== INTERNAL_MESSAGE_CHANNEL &&
    ((!isChannelAgnosticSessionScope && (isChannelScopedSession || hasLegacyChannelPeerShape)) ||
      canInheritConfiguredMainRoute),
  );
  const hasDeliverableRoute =
    canInheritDeliverableRoute &&
    routeChannelCandidate &&
    routeChannelCandidate !== INTERNAL_MESSAGE_CHANNEL &&
    typeof routeToCandidate === "string" &&
    routeToCandidate.trim().length > 0;

  if (!hasDeliverableRoute) {
    return {
      explicitDeliverRoute: false,
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
    };
  }

  return {
    accountId: routeAccountIdCandidate,
    explicitDeliverRoute: true,
    messageThreadId: routeThreadIdCandidate,
    originatingChannel: routeChannelCandidate,
    originatingTo: routeToCandidate,
  };
}

function stripDisallowedChatControlChars(message: string): string {
  let output = "";
  for (const char of message) {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      output += char;
    }
  }
  return output;
}

export function sanitizeChatSendMessageInput(
  message: string,
): { ok: true; message: string } | { ok: false; error: string } {
  const normalized = message.normalize("NFC");
  if (normalized.includes("\u0000")) {
    return { error: "message must not contain null bytes", ok: false };
  }
  return { message: stripDisallowedChatControlChars(normalized), ok: true };
}

function normalizeOptionalChatSystemReceipt(
  value: unknown,
): { ok: true; receipt?: string } | { ok: false; error: string } {
  if (value == null) {
    return { ok: true };
  }
  if (typeof value !== "string") {
    return { error: "systemProvenanceReceipt must be a string", ok: false };
  }
  const sanitized = sanitizeChatSendMessageInput(value);
  if (!sanitized.ok) {
    return sanitized;
  }
  const receipt = sanitized.message.trim();
  return { ok: true, receipt: receipt || undefined };
}

function isAcpBridgeClient(client: GatewayRequestHandlerOptions["client"]): boolean {
  const info = client?.connect?.client;
  return (
    info?.id === GATEWAY_CLIENT_NAMES.CLI &&
    info?.mode === GATEWAY_CLIENT_MODES.CLI &&
    info?.displayName === "ACP" &&
    info?.version === "acp"
  );
}

function canInjectSystemProvenance(client: GatewayRequestHandlerOptions["client"]): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

/**
 * Persist inline images and offloaded-ref media to the transcript media store.
 *
 * Inline images are re-saved from their base64 payload so that a stable
 * filesystem path can be stored in the transcript.  Offloaded refs are already
 * on disk (saved by parseMessageWithAttachments); their SavedMedia metadata is
 * synthesised directly from the OffloadedRef, avoiding a redundant write.
 *
 * Both sets are combined so that transcript media fields remain complete
 * regardless of whether attachments were inlined or offloaded.
 */
async function persistChatSendImages(params: {
  images: ChatImageContent[];
  imageOrder: PromptImageOrderEntry[];
  offloadedRefs: OffloadedRef[];
  client: GatewayRequestHandlerOptions["client"];
  logGateway: GatewayRequestContext["logGateway"];
}): Promise<SavedMedia[]> {
  if (isAcpBridgeClient(params.client)) {
    return [];
  }

  const saved: SavedMedia[] = [];
  let inlineIndex = 0;
  let offloadedIndex = 0;
  for (const entry of params.imageOrder) {
    if (entry === "offloaded") {
      const ref = params.offloadedRefs[offloadedIndex++];
      if (!ref) {
        continue;
      }
      saved.push({
        contentType: ref.mimeType,
        id: ref.id,
        path: ref.path,
        size: 0,
      });
      continue;
    }

    const img = params.images[inlineIndex++];
    if (!img) {
      continue;
    }
    try {
      saved.push(await saveMediaBuffer(Buffer.from(img.data, "base64"), img.mimeType, "inbound"));
    } catch (error) {
      params.logGateway.warn(
        `chat.send: failed to persist inbound image (${img.mimeType}): ${formatForLog(error)}`,
      );
    }
  }

  return saved;
}

function buildChatSendTranscriptMessage(params: {
  message: string;
  savedImages: SavedMedia[];
  timestamp: number;
}) {
  const mediaFields = resolveChatSendTranscriptMediaFields(params.savedImages);
  return {
    content: params.message,
    role: "user" as const,
    timestamp: params.timestamp,
    ...mediaFields,
  };
}

function resolveChatSendTranscriptMediaFields(savedImages: SavedMedia[]) {
  const mediaPaths = savedImages.map((entry) => entry.path);
  if (mediaPaths.length === 0) {
    return {};
  }
  const mediaTypes = savedImages.map((entry) => entry.contentType ?? "application/octet-stream");
  return {
    MediaPath: mediaPaths[0],
    MediaPaths: mediaPaths,
    MediaType: mediaTypes[0],
    MediaTypes: mediaTypes,
  };
}

function extractTranscriptUserText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textBlocks = content
    .map((block) =>
      block && typeof block === "object" && "text" in block ? block.text : undefined,
    )
    .filter((text): text is string => typeof text === "string");
  return textBlocks.length > 0 ? textBlocks.join("") : undefined;
}

async function rewriteChatSendUserTurnMediaPaths(params: {
  transcriptPath: string;
  sessionKey: string;
  message: string;
  savedImages: SavedMedia[];
}) {
  const mediaFields = resolveChatSendTranscriptMediaFields(params.savedImages);
  if (!("MediaPath" in mediaFields)) {
    return;
  }
  const sessionManager = SessionManager.open(params.transcriptPath);
  const branch = sessionManager.getBranch();
  const target = [...branch].toReversed().find((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") {
      return false;
    }
    const existingPaths = Array.isArray((entry.message as { MediaPaths?: unknown }).MediaPaths)
      ? (entry.message as { MediaPaths?: unknown[] }).MediaPaths
      : undefined;
    if (
      (typeof (entry.message as { MediaPath?: unknown }).MediaPath === "string" &&
        (entry.message as { MediaPath?: string }).MediaPath) ||
      (existingPaths && existingPaths.length > 0)
    ) {
      return false;
    }
    return (
      extractTranscriptUserText((entry.message as { content?: unknown }).content) === params.message
    );
  });
  if (!target || target.type !== "message") {
    return;
  }
  const rewrittenMessage = {
    ...target.message,
    ...mediaFields,
  };
  await rewriteTranscriptEntriesInSessionFile({
    request: {
      replacements: [
        {
          entryId: target.id,
          message: rewrittenMessage,
        },
      ],
    },
    sessionFile: params.transcriptPath,
    sessionKey: params.sessionKey,
  });
}

function truncateChatHistoryText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n...(truncated)...`,
    truncated: true,
  };
}

function sanitizeChatHistoryContentBlock(
  block: unknown,
  maxChars: number,
): { block: unknown; changed: boolean } {
  if (!block || typeof block !== "object") {
    return { block, changed: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let changed = false;
  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const res = truncateChatHistoryText(stripped.text, maxChars);
    entry.text = res.text;
    changed ||= stripped.changed || res.truncated;
  }
  if (typeof entry.partialJson === "string") {
    const res = truncateChatHistoryText(entry.partialJson, maxChars);
    entry.partialJson = res.text;
    changed ||= res.truncated;
  }
  if (typeof entry.arguments === "string") {
    const res = truncateChatHistoryText(entry.arguments, maxChars);
    entry.arguments = res.text;
    changed ||= res.truncated;
  }
  if (typeof entry.thinking === "string") {
    const res = truncateChatHistoryText(entry.thinking, maxChars);
    entry.thinking = res.text;
    changed ||= res.truncated;
  }
  if ("thinkingSignature" in entry) {
    delete entry.thinkingSignature;
    changed = true;
  }
  const type = typeof entry.type === "string" ? entry.type : "";
  if (type === "image" && typeof entry.data === "string") {
    const bytes = Buffer.byteLength(entry.data, "utf8");
    delete entry.data;
    entry.omitted = true;
    entry.bytes = bytes;
    changed = true;
  }
  return { block: changed ? entry : block, changed };
}

/**
 * Validate that a value is a finite number, returning undefined otherwise.
 */
function toFiniteNumber(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

/**
 * Sanitize usage metadata to ensure only finite numeric fields are included.
 * Prevents UI crashes from malformed transcript JSON.
 */
function sanitizeUsage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const u = raw as Record<string, unknown>;
  const out: Record<string, number> = {};

  // Whitelist known usage fields and validate they're finite numbers
  const knownFields = [
    "input",
    "output",
    "totalTokens",
    "inputTokens",
    "outputTokens",
    "cacheRead",
    "cacheWrite",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ];

  for (const k of knownFields) {
    const n = toFiniteNumber(u[k]);
    if (n !== undefined) {
      out[k] = n;
    }
  }

  // Preserve nested usage.cost when present
  if ("cost" in u && u.cost != null && typeof u.cost === "object") {
    const sanitizedCost = sanitizeCost(u.cost);
    if (sanitizedCost) {
      (out as Record<string, unknown>).cost = sanitizedCost;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Sanitize cost metadata to ensure only finite numeric fields are included.
 * Prevents UI crashes from calling .toFixed() on non-numbers.
 */
function sanitizeCost(raw: unknown): { total?: number } | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const c = raw as Record<string, unknown>;
  const total = toFiniteNumber(c.total);
  return total !== undefined ? { total } : undefined;
}

function sanitizeChatHistoryMessage(
  message: unknown,
  maxChars: number,
): { message: unknown; changed: boolean } {
  if (!message || typeof message !== "object") {
    return { changed: false, message };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let changed = false;

  if ("details" in entry) {
    delete entry.details;
    changed = true;
  }

  // Keep usage/cost so the chat UI can render per-message token and cost badges.
  // Only retain usage/cost on assistant messages and validate numeric fields to prevent UI crashes.
  if (entry.role !== "assistant") {
    if ("usage" in entry) {
      delete entry.usage;
      changed = true;
    }
    if ("cost" in entry) {
      delete entry.cost;
      changed = true;
    }
  } else {
    // Validate and sanitize usage/cost for assistant messages
    if ("usage" in entry) {
      const sanitized = sanitizeUsage(entry.usage);
      if (sanitized) {
        entry.usage = sanitized;
      } else {
        delete entry.usage;
      }
      changed = true;
    }
    if ("cost" in entry) {
      const sanitized = sanitizeCost(entry.cost);
      if (sanitized) {
        entry.cost = sanitized;
      } else {
        delete entry.cost;
      }
      changed = true;
    }
  }

  if (typeof entry.content === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
    const res = truncateChatHistoryText(stripped.text, maxChars);
    entry.content = res.text;
    changed ||= stripped.changed || res.truncated;
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) => sanitizeChatHistoryContentBlock(block, maxChars));
    const sanitizedBlocks = updated.map((item) => item.block);
    const hasPhaseMetadata = hasAssistantPhaseMetadata(entry);
    if (hasPhaseMetadata) {
      const stripped = stripInlineDirectiveTagsForDisplay(extractAssistantHistoryText(entry) ?? "");
      const res = truncateChatHistoryText(stripped.text, maxChars);
      const nonTextBlocks = sanitizedBlocks.filter(
        (block) =>
          !block || typeof block !== "object" || (block as { type?: unknown }).type !== "text",
      );
      entry.content = res.text
        ? [{ text: res.text, type: "text" }, ...nonTextBlocks]
        : nonTextBlocks;
      changed = true;
    } else if (updated.some((item) => item.changed)) {
      entry.content = sanitizedBlocks;
      changed = true;
    }
  }

  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const res = truncateChatHistoryText(stripped.text, maxChars);
    entry.text = res.text;
    changed ||= stripped.changed || res.truncated;
  }

  return { changed, message: changed ? entry : message };
}

/**
 * Extract the visible text from an assistant history message for silent-token checks.
 * Returns `undefined` for non-assistant messages or messages with no extractable text.
 * When `entry.text` is present it takes precedence over `entry.content` to avoid
 * dropping messages that carry real text alongside a stale `content: "NO_REPLY"`.
 */
function extractAssistantTextForSilentCheck(message: unknown): string | undefined {
  return extractAssistantHistoryText(message);
}

function hasAssistantNonTextContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const {content} = (message as { content?: unknown });
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (block) => block && typeof block === "object" && (block as { type?: unknown }).type !== "text",
  );
}

function shouldDropAssistantHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return false;
  }
  if (resolveAssistantMessagePhase(message) === "commentary") {
    return true;
  }
  const text = extractAssistantTextForSilentCheck(message);
  if (text === undefined || !isSuppressedControlReplyText(text)) {
    return false;
  }
  return !hasAssistantNonTextContent(message);
}

export function sanitizeChatHistoryMessages(messages: unknown[], maxChars: number): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next: unknown[] = [];
  for (const message of messages) {
    // Drop raw control-token replies before any maxChars truncation can make
    // An exact token look like partial user-visible text.
    if (shouldDropAssistantHistoryMessage(message)) {
      changed = true;
      continue;
    }
    const res = sanitizeChatHistoryMessage(message, maxChars);
    changed ||= res.changed;
    // Drop assistant commentary-only entries and exact control replies, but
    // Keep mixed assistant entries that still carry non-text content. Run this
    // Again after sanitizing so display-only cleanup can still suppress stale tokens.
    if (shouldDropAssistantHistoryMessage(res.message)) {
      changed = true;
      continue;
    }
    next.push(res.message);
  }
  return changed ? next : messages;
}

function buildOversizedHistoryPlaceholder(message?: unknown): Record<string, unknown> {
  const role =
    message &&
    typeof message === "object" &&
    typeof (message as { role?: unknown }).role === "string"
      ? (message as { role: string }).role
      : "assistant";
  const timestamp =
    message &&
    typeof message === "object" &&
    typeof (message as { timestamp?: unknown }).timestamp === "number"
      ? (message as { timestamp: number }).timestamp
      : Date.now();
  return {
    __openclaw: { reason: "oversized", truncated: true },
    content: [{ text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER, type: "text" }],
    role,
    timestamp,
  };
}

function replaceOversizedChatHistoryMessages(params: {
  messages: unknown[];
  maxSingleMessageBytes: number;
}): { messages: unknown[]; replacedCount: number } {
  const { messages, maxSingleMessageBytes } = params;
  if (messages.length === 0) {
    return { messages, replacedCount: 0 };
  }
  let replacedCount = 0;
  const next = messages.map((message) => {
    if (jsonUtf8Bytes(message) <= maxSingleMessageBytes) {
      return message;
    }
    replacedCount += 1;
    return buildOversizedHistoryPlaceholder(message);
  });
  return { messages: replacedCount > 0 ? next : messages, replacedCount };
}

function enforceChatHistoryFinalBudget(params: { messages: unknown[]; maxBytes: number }): {
  messages: unknown[];
  placeholderCount: number;
} {
  const { messages, maxBytes } = params;
  if (messages.length === 0) {
    return { messages, placeholderCount: 0 };
  }
  if (jsonUtf8Bytes(messages) <= maxBytes) {
    return { messages, placeholderCount: 0 };
  }
  const last = messages.at(-1);
  if (last && jsonUtf8Bytes([last]) <= maxBytes) {
    return { messages: [last], placeholderCount: 0 };
  }
  const placeholder = buildOversizedHistoryPlaceholder(last);
  if (jsonUtf8Bytes([placeholder]) <= maxBytes) {
    return { messages: [placeholder], placeholderCount: 1 };
  }
  return { messages: [], placeholderCount: 0 };
}

function resolveTranscriptPath(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
}): string | null {
  const { sessionId, storePath, sessionFile, agentId } = params;
  if (!storePath && !sessionFile) {
    return null;
  }
  try {
    const sessionsDir = storePath ? path.dirname(storePath) : undefined;
    return resolveSessionFilePath(
      sessionId,
      sessionFile ? { sessionFile } : undefined,
      sessionsDir || agentId ? { agentId, sessionsDir } : undefined,
    );
  } catch {
    return null;
  }
}

function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  if (fs.existsSync(params.transcriptPath)) {
    return { ok: true };
  }
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      cwd: process.cwd(),
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      type: "session",
      version: CURRENT_SESSION_VERSION,
    };
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { ok: true };
  } catch (error) {
    return { error: formatErrorMessage(error), ok: false };
  }
}

function transcriptHasIdempotencyKey(transcriptPath: string, idempotencyKey: string): boolean {
  try {
    const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const parsed = JSON.parse(line) as { message?: { idempotencyKey?: unknown } };
      if (parsed?.message?.idempotencyKey === idempotencyKey) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function appendAssistantTranscriptMessage(params: {
  message: string;
  /** Rich Pi message blocks (text, embedded audio, etc.). Overrides plain `message` when set. */
  content?: Record<string, unknown>[];
  label?: string;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  createIfMissing?: boolean;
  idempotencyKey?: string;
  abortMeta?: {
    aborted: true;
    origin: AbortOrigin;
    runId: string;
  };
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPath({
    agentId: params.agentId,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    storePath: params.storePath,
  });
  if (!transcriptPath) {
    return { error: "transcript path not resolved", ok: false };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { error: "transcript file not found", ok: false };
    }
    const ensured = ensureTranscriptFile({
      sessionId: params.sessionId,
      transcriptPath,
    });
    if (!ensured.ok) {
      return { error: ensured.error ?? "failed to create transcript file", ok: false };
    }
  }

  if (params.idempotencyKey && transcriptHasIdempotencyKey(transcriptPath, params.idempotencyKey)) {
    return { ok: true };
  }

  return appendInjectedAssistantMessageToTranscript({
    abortMeta: params.abortMeta,
    content: params.content,
    idempotencyKey: params.idempotencyKey,
    label: params.label,
    message: params.message,
    transcriptPath,
  });
}

function collectSessionAbortPartials(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  runIds: ReadonlySet<string>;
  abortOrigin: AbortOrigin;
}): AbortedPartialSnapshot[] {
  const out: AbortedPartialSnapshot[] = [];
  for (const [runId, active] of params.chatAbortControllers) {
    if (!params.runIds.has(runId)) {
      continue;
    }
    const text = params.chatRunBuffers.get(runId);
    if (!text || !text.trim()) {
      continue;
    }
    out.push({
      abortOrigin: params.abortOrigin,
      runId,
      sessionId: active.sessionId,
      text,
    });
  }
  return out;
}

function persistAbortedPartials(params: {
  context: Pick<GatewayRequestContext, "logGateway">;
  sessionKey: string;
  snapshots: AbortedPartialSnapshot[];
}) {
  if (params.snapshots.length === 0) {
    return;
  }
  const { storePath, entry } = loadSessionEntry(params.sessionKey);
  for (const snapshot of params.snapshots) {
    const sessionId = entry?.sessionId ?? snapshot.sessionId ?? snapshot.runId;
    const appended = appendAssistantTranscriptMessage({
      abortMeta: {
        aborted: true,
        origin: snapshot.abortOrigin,
        runId: snapshot.runId,
      },
      createIfMissing: true,
      idempotencyKey: `${snapshot.runId}:assistant`,
      message: snapshot.text,
      sessionFile: entry?.sessionFile,
      sessionId,
      storePath,
    });
    if (!appended.ok) {
      params.context.logGateway.warn(
        `chat.abort transcript append failed: ${appended.error ?? "unknown error"}`,
      );
    }
  }
}

function createChatAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    agentRunSeq: context.agentRunSeq,
    broadcast: context.broadcast,
    chatAbortControllers: context.chatAbortControllers,
    chatAbortedRuns: context.chatAbortedRuns,
    chatDeltaLastBroadcastLen: context.chatDeltaLastBroadcastLen,
    chatDeltaSentAt: context.chatDeltaSentAt,
    chatRunBuffers: context.chatRunBuffers,
    nodeSendToSession: context.nodeSendToSession,
    removeChatRun: context.removeChatRun,
  };
}

function normalizeExplicitChatSendOrigin(
  params: ChatSendExplicitOrigin,
): { ok: true; value?: ChatSendExplicitOrigin } | { ok: false; error: string } {
  const originatingChannel = normalizeOptionalString(params.originatingChannel);
  const originatingTo = normalizeOptionalString(params.originatingTo);
  const accountId = normalizeOptionalString(params.accountId);
  const messageThreadId = normalizeOptionalString(params.messageThreadId);
  const hasAnyExplicitOriginField = Boolean(
    originatingChannel || originatingTo || accountId || messageThreadId,
  );
  if (!hasAnyExplicitOriginField) {
    return { ok: true };
  }
  const normalizedChannel = normalizeMessageChannel(originatingChannel);
  if (!normalizedChannel) {
    return {
      error: "originatingChannel is required when using originating route fields",
      ok: false,
    };
  }
  if (!originatingTo) {
    return {
      error: "originatingTo is required when using originating route fields",
      ok: false,
    };
  }
  return {
    ok: true,
    value: {
      originatingChannel: normalizedChannel,
      originatingTo,
      ...(accountId ? { accountId } : {}),
      ...(messageThreadId ? { messageThreadId } : {}),
    },
  };
}

function resolveChatAbortRequester(
  client: GatewayRequestHandlerOptions["client"],
): ChatAbortRequester {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return {
    connId: normalizeOptionalString(client?.connId),
    deviceId: normalizeOptionalString(client?.connect?.device?.id),
    isAdmin: scopes.includes(ADMIN_SCOPE),
  };
}

function canRequesterAbortChatRun(
  entry: ChatAbortControllerEntry,
  requester: ChatAbortRequester,
): boolean {
  if (requester.isAdmin) {
    return true;
  }
  const ownerDeviceId = normalizeOptionalString(entry.ownerDeviceId);
  const ownerConnId = normalizeOptionalString(entry.ownerConnId);
  if (!ownerDeviceId && !ownerConnId) {
    return true;
  }
  if (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) {
    return true;
  }
  if (ownerConnId && requester.connId && ownerConnId === requester.connId) {
    return true;
  }
  return false;
}

function resolveAuthorizedRunIdsForSession(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  sessionKey: string;
  requester: ChatAbortRequester;
}) {
  const authorizedRunIds: string[] = [];
  let matchedSessionRuns = 0;
  for (const [runId, active] of params.chatAbortControllers) {
    if (active.sessionKey !== params.sessionKey) {
      continue;
    }
    matchedSessionRuns += 1;
    if (canRequesterAbortChatRun(active, params.requester)) {
      authorizedRunIds.push(runId);
    }
  }
  return {
    authorizedRunIds,
    matchedSessionRuns,
  };
}

function abortChatRunsForSessionKeyWithPartials(params: {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  abortOrigin: AbortOrigin;
  stopReason?: string;
  requester: ChatAbortRequester;
}) {
  const { matchedSessionRuns, authorizedRunIds } = resolveAuthorizedRunIdsForSession({
    chatAbortControllers: params.context.chatAbortControllers,
    requester: params.requester,
    sessionKey: params.sessionKey,
  });
  if (authorizedRunIds.length === 0) {
    return {
      aborted: false,
      runIds: [],
      unauthorized: matchedSessionRuns > 0,
    };
  }
  const authorizedRunIdSet = new Set(authorizedRunIds);
  const snapshots = collectSessionAbortPartials({
    abortOrigin: params.abortOrigin,
    chatAbortControllers: params.context.chatAbortControllers,
    chatRunBuffers: params.context.chatRunBuffers,
    runIds: authorizedRunIdSet,
  });
  const runIds: string[] = [];
  for (const runId of authorizedRunIds) {
    const res = abortChatRunById(params.ops, {
      runId,
      sessionKey: params.sessionKey,
      stopReason: params.stopReason,
    });
    if (res.aborted) {
      runIds.push(runId);
    }
  }
  const res = { aborted: runIds.length > 0, runIds, unauthorized: false };
  if (res.aborted) {
    persistAbortedPartials({
      context: params.context,
      sessionKey: params.sessionKey,
      snapshots,
    });
  }
  return res;
}

function nextChatSeq(context: { agentRunSeq: Map<string, number> }, runId: string) {
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, next);
  return next;
}

function broadcastChatFinal(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  message?: Record<string, unknown>;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const strippedEnvelopeMessage = stripEnvelopeFromMessage(params.message) as
    | Record<string, unknown>
    | undefined;
  const payload = {
    message: stripInlineDirectiveTagsFromMessageForDisplay(strippedEnvelopeMessage),
    runId: params.runId,
    seq,
    sessionKey: params.sessionKey,
    state: "final" as const,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.runId);
}

function isBtwReplyPayload(payload: ReplyPayload | undefined): payload is ReplyPayload & {
  btw: { question: string };
  text: string;
} {
  return (
    typeof payload?.btw?.question === "string" &&
    payload.btw.question.trim().length > 0 &&
    typeof payload.text === "string" &&
    payload.text.trim().length > 0
  );
}

function broadcastSideResult(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  payload: SideResultPayload;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.payload.runId);
  params.context.broadcast("chat.side_result", {
    ...params.payload,
    seq,
  });
  params.context.nodeSendToSession(params.payload.sessionKey, "chat.side_result", {
    ...params.payload,
    seq,
  });
}

function broadcastChatError(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  errorMessage?: string;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    errorMessage: params.errorMessage,
    runId: params.runId,
    seq,
    sessionKey: params.sessionKey,
    state: "error" as const,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.runId);
}

export const chatHandlers: GatewayRequestHandlers = {
  "chat.abort": ({ params, respond, context, client }) => {
    if (!validateChatAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey: rawSessionKey, runId } = params as {
      sessionKey: string;
      runId?: string;
    };

    const ops = createChatAbortOps(context);
    const requester = resolveChatAbortRequester(client);

    if (!runId) {
      const res = abortChatRunsForSessionKeyWithPartials({
        abortOrigin: "rpc",
        context,
        ops,
        requester,
        sessionKey: rawSessionKey,
        stopReason: "rpc",
      });
      if (res.unauthorized) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      respond(true, { aborted: res.aborted, ok: true, runIds: res.runIds });
      return;
    }

    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      respond(true, { aborted: false, ok: true, runIds: [] });
      return;
    }
    if (active.sessionKey !== rawSessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }
    if (!canRequesterAbortChatRun(active, requester)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }

    const partialText = context.chatRunBuffers.get(runId);
    const res = abortChatRunById(ops, {
      runId,
      sessionKey: rawSessionKey,
      stopReason: "rpc",
    });
    if (res.aborted && partialText && partialText.trim()) {
      persistAbortedPartials({
        context,
        sessionKey: rawSessionKey,
        snapshots: [
          {
            abortOrigin: "rpc",
            runId,
            sessionId: active.sessionId,
            text: partialText,
          },
        ],
      });
    }
    respond(true, {
      aborted: res.aborted,
      ok: true,
      runIds: res.aborted ? [runId] : [],
    });
  },
  "chat.history": async ({ params, respond, context }) => {
    if (!validateChatHistoryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
        ),
      );
      return;
    }
    const {
      sessionKey,
      limit,
      maxChars: rpcMaxChars,
    } = params as {
      sessionKey: string;
      limit?: number;
      maxChars?: number;
    };
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
    const configMaxChars = cfg.gateway?.webchat?.chatHistoryMaxChars;
    const effectiveMaxChars =
      typeof rpcMaxChars === "number"
        ? rpcMaxChars
        : (typeof configMaxChars === "number"
          ? configMaxChars
          : DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS);
    const sessionAgentId = resolveSessionAgentId({ config: cfg, sessionKey });
    const sessionId = entry?.sessionId;
    const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
    const localMessages =
      sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
    const rawMessages = augmentChatHistoryWithCliSessionImports({
      entry,
      localMessages,
      provider: resolvedSessionModel.provider,
    });
    const hardMax = 1000;
    const defaultLimit = 200;
    const requested = typeof limit === "number" ? limit : defaultLimit;
    const max = Math.min(hardMax, requested);
    const sliced = rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
    const sanitized = stripEnvelopeFromMessages(sliced);
    const normalized = sanitizeChatHistoryMessages(sanitized, effectiveMaxChars);
    const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
    const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
    const replaced = replaceOversizedChatHistoryMessages({
      maxSingleMessageBytes: perMessageHardCap,
      messages: normalized,
    });
    const capped = capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
    const bounded = enforceChatHistoryFinalBudget({ maxBytes: maxHistoryBytes, messages: capped });
    const placeholderCount = replaced.replacedCount + bounded.placeholderCount;
    if (placeholderCount > 0) {
      chatHistoryPlaceholderEmitCount += placeholderCount;
      context.logGateway.debug(
        `chat.history omitted oversized payloads placeholders=${placeholderCount} total=${chatHistoryPlaceholderEmitCount}`,
      );
    }
    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const sessionAgentId = resolveSessionAgentId({
        config: cfg,
        sessionKey,
      });
      const resolvedModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
      const catalog = await context.loadGatewayModelCatalog();
      thinkingLevel = resolveThinkingDefault({
        catalog,
        cfg,
        model: resolvedModel.model,
        provider: resolvedModel.provider,
      });
    }
    const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
    respond(true, {
      fastMode: entry?.fastMode,
      messages: bounded.messages,
      sessionId,
      sessionKey,
      thinkingLevel,
      verboseLevel,
    });
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const rawSessionKey = p.sessionKey;
    const { cfg, storePath, entry, canonicalKey: sessionKey } = loadSessionEntry(rawSessionKey);
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }

    const appended = appendAssistantTranscriptMessage({
      agentId: resolveSessionAgentId({ sessionKey, config: cfg }),
      createIfMissing: true,
      label: p.label,
      message: p.message,
      sessionFile: entry?.sessionFile,
      sessionId,
      storePath,
    });
    if (!appended.ok || !appended.messageId || !appended.message) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to write transcript: ${appended.error ?? "unknown error"}`,
        ),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const chatPayload = {
      message: stripInlineDirectiveTagsFromMessageForDisplay(
        stripEnvelopeFromMessage(appended.message) as Record<string, unknown>,
      ),
      runId: `inject-${appended.messageId}`,
      seq: 0,
      sessionKey,
      state: "final" as const,
    };
    context.broadcast("chat", chatPayload);
    context.nodeSendToSession(sessionKey, "chat", chatPayload);

    respond(true, { messageId: appended.messageId, ok: true });
  },
  "chat.send": async ({ params, respond, context, client }) => {
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      thinking?: string;
      deliver?: boolean;
      originatingChannel?: string;
      originatingTo?: string;
      originatingAccountId?: string;
      originatingThreadId?: string;
      attachments?: {
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }[];
      timeoutMs?: number;
      systemInputProvenance?: InputProvenance;
      systemProvenanceReceipt?: string;
      idempotencyKey: string;
    };
    const explicitOriginResult = normalizeExplicitChatSendOrigin({
      accountId: p.originatingAccountId,
      messageThreadId: p.originatingThreadId,
      originatingChannel: p.originatingChannel,
      originatingTo: p.originatingTo,
    });
    if (!explicitOriginResult.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, explicitOriginResult.error));
      return;
    }
    if (
      (p.systemInputProvenance || p.systemProvenanceReceipt || explicitOriginResult.value) &&
      !canInjectSystemProvenance(client)
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          p.systemInputProvenance || p.systemProvenanceReceipt
            ? "system provenance fields require admin scope"
            : "originating route fields require admin scope",
        ),
      );
      return;
    }
    const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
    if (!sanitizedMessageResult.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, sanitizedMessageResult.error),
      );
      return;
    }
    const systemReceiptResult = normalizeOptionalChatSystemReceipt(p.systemProvenanceReceipt);
    if (!systemReceiptResult.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, systemReceiptResult.error));
      return;
    }
    const inboundMessage = sanitizedMessageResult.message;
    const systemInputProvenance = normalizeInputProvenance(p.systemInputProvenance);
    const systemProvenanceReceipt = systemReceiptResult.receipt;
    const stopCommand = isChatStopCommandText(inboundMessage);
    const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);
    const rawMessage = inboundMessage.trim();
    if (!rawMessage && normalizedAttachments.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "message or attachment required"),
      );
      return;
    }

    // Load session entry before attachment parsing so we can gate media-URI
    // Marker injection on the model's image capability. This prevents opaque
    // media:// markers from leaking into prompts for text-only model runs.
    const rawSessionKey = p.sessionKey;
    const { cfg, entry, canonicalKey: sessionKey } = loadSessionEntry(rawSessionKey);

    let parsedMessage = inboundMessage;
    let parsedImages: ChatImageContent[] = [];
    let parsedImageOrder: PromptImageOrderEntry[] = [];
    let parsedOffloadedRefs: OffloadedRef[] = [];

    const timeoutMs = resolveAgentTimeoutMs({
      cfg,
      overrideMs: p.timeoutMs,
    });
    const now = Date.now();
    const clientRunId = p.idempotencyKey;

    const sendPolicy = resolveSendPolicy({
      cfg,
      channel: entry?.channel,
      chatType: entry?.chatType,
      entry,
      sessionKey,
    });
    if (sendPolicy === "deny") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
      );
      return;
    }

    if (stopCommand) {
      const res = abortChatRunsForSessionKeyWithPartials({
        abortOrigin: "stop-command",
        context,
        ops: createChatAbortOps(context),
        requester: resolveChatAbortRequester(client),
        sessionKey: rawSessionKey,
        stopReason: "stop",
      });
      if (res.unauthorized) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      respond(true, { aborted: res.aborted, ok: true, runIds: res.runIds });
      return;
    }

    const cached = context.dedupe.get(`chat:${clientRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }

    const activeExisting = context.chatAbortControllers.get(clientRunId);
    if (activeExisting) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }

    if (normalizedAttachments.length > 0) {
      const sessionAgentId = resolveSessionAgentId({ config: cfg, sessionKey });
      const modelRef = resolveSessionModelRef(cfg, entry, sessionAgentId);
      const supportsImages = await resolveGatewayModelSupportsImages({
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
        model: modelRef.model,
        provider: modelRef.provider,
      });

      try {
        const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments, {
          log: context.logGateway,
          maxBytes: 5_000_000,
          supportsImages,
        });
        parsedMessage = parsed.message;
        parsedImages = parsed.images;
        parsedImageOrder = parsed.imageOrder;
        parsedOffloadedRefs = parsed.offloadedRefs;
      } catch (error) {
        // MediaOffloadError indicates a server-side storage fault (ENOSPC, EPERM,
        // etc.). All other errors are client-side input validation failures.
        // Map them to different HTTP status codes so callers can retry server
        // faults without treating them as bad requests.
        const isServerFault = error instanceof MediaOffloadError;
        respond(
          false,
          undefined,
          errorShape(
            isServerFault ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
            String(error),
          ),
        );
        return;
      }
    }

    try {
      const abortController = new AbortController();
      context.chatAbortControllers.set(clientRunId, {
        controller: abortController,
        expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
        ownerConnId: normalizeOptionalString(client?.connId),
        ownerDeviceId: normalizeOptionalString(client?.connect?.device?.id),
        sessionId: entry?.sessionId ?? clientRunId,
        sessionKey: rawSessionKey,
        startedAtMs: now,
      });
      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
      };
      respond(true, ackPayload, undefined, { runId: clientRunId });

      // Persist both inline images and already-offloaded refs to the media
      // Store so that transcript media fields remain complete for all attachment
      // Sizes. Offloaded refs are already on disk; persistChatSendImages converts
      // Their metadata without re-writing the files.
      const persistedImagesPromise = persistChatSendImages({
        client,
        imageOrder: parsedImageOrder,
        images: parsedImages,
        logGateway: context.logGateway,
        offloadedRefs: parsedOffloadedRefs,
      });

      const trimmedMessage = parsedMessage.trim();
      const injectThinking = Boolean(
        p.thinking && trimmedMessage && !trimmedMessage.startsWith("/"),
      );
      const commandBody = injectThinking ? `/think ${p.thinking} ${parsedMessage}` : parsedMessage;
      const messageForAgent = systemProvenanceReceipt
        ? [systemProvenanceReceipt, parsedMessage].filter(Boolean).join("\n\n")
        : parsedMessage;
      const clientInfo = client?.connect?.client;
      const {
        originatingChannel,
        originatingTo,
        accountId,
        messageThreadId,
        explicitDeliverRoute,
      } = resolveChatSendOriginatingRoute({
        client: clientInfo,
        deliver: p.deliver,
        entry,
        explicitOrigin: explicitOriginResult.value,
        hasConnectedClient: client?.connect !== undefined,
        mainKey: cfg.session?.mainKey,
        sessionKey,
      });
      // Inject timestamp so agents know the current date/time.
      // Only BodyForAgent gets the timestamp — Body stays raw for UI display.
      // See: https://github.com/openclaw/openclaw/issues/3658
      const stampedMessage = injectTimestamp(messageForAgent, timestampOptsFromConfig(cfg));

      const ctx: MsgContext = {
        AccountId: accountId,
        Body: messageForAgent,
        BodyForAgent: stampedMessage,
        BodyForCommands: commandBody,
        ChatType: "direct",
        CommandAuthorized: true,
        CommandBody: commandBody,
        ExplicitDeliverRoute: explicitDeliverRoute,
        GatewayClientScopes: client?.connect?.scopes ?? [],
        InputProvenance: systemInputProvenance,
        MessageSid: clientRunId,
        MessageThreadId: messageThreadId,
        OriginatingChannel: originatingChannel,
        OriginatingTo: originatingTo,
        Provider: INTERNAL_MESSAGE_CHANNEL,
        RawBody: parsedMessage,
        SenderId: clientInfo?.id,
        SenderName: clientInfo?.displayName,
        SenderUsername: clientInfo?.displayName,
        SessionKey: sessionKey,
        Surface: INTERNAL_MESSAGE_CHANNEL,
      };

      const agentId = resolveSessionAgentId({
        config: cfg,
        sessionKey,
      });
      const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
        agentId,
        cfg,
        channel: INTERNAL_MESSAGE_CHANNEL,
      });
      const deliveredReplies: { payload: ReplyPayload; kind: "block" | "final" }[] = [];
      let userTranscriptUpdatePromise: Promise<void> | null = null;
      const emitUserTranscriptUpdate = async () => {
        if (userTranscriptUpdatePromise) {
          await userTranscriptUpdatePromise;
          return;
        }
        userTranscriptUpdatePromise = (async () => {
          const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey);
          const resolvedSessionId = latestEntry?.sessionId ?? entry?.sessionId;
          if (!resolvedSessionId) {
            return;
          }
          const transcriptPath = resolveTranscriptPath({
            agentId,
            sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
            sessionId: resolvedSessionId,
            storePath: latestStorePath,
          });
          if (!transcriptPath) {
            return;
          }
          const persistedImages = await persistedImagesPromise;
          emitSessionTranscriptUpdate({
            message: buildChatSendTranscriptMessage({
              message: parsedMessage,
              savedImages: persistedImages,
              timestamp: now,
            }),
            sessionFile: transcriptPath,
            sessionKey,
          });
        })();
        await userTranscriptUpdatePromise;
      };
      let transcriptMediaRewriteDone = false;
      const rewriteUserTranscriptMedia = async () => {
        if (transcriptMediaRewriteDone) {
          return;
        }
        const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey);
        const resolvedSessionId = latestEntry?.sessionId ?? entry?.sessionId;
        if (!resolvedSessionId) {
          return;
        }
        const transcriptPath = resolveTranscriptPath({
          agentId,
          sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
          sessionId: resolvedSessionId,
          storePath: latestStorePath,
        });
        if (!transcriptPath) {
          return;
        }
        transcriptMediaRewriteDone = true;
        await rewriteChatSendUserTurnMediaPaths({
          message: parsedMessage,
          savedImages: await persistedImagesPromise,
          sessionKey,
          transcriptPath,
        });
      };
      const dispatcher = createReplyDispatcher({
        ...replyPipeline,
        deliver: async (payload, info) => {
          if (info.kind !== "block" && info.kind !== "final") {
            return;
          }
          deliveredReplies.push({ payload, kind: info.kind });
        },
        onError: (err) => {
          context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
        },
      });

      // Surface accepted inbound turns immediately so transcript subscribers
      // (gateway watchers, MCP bridges, external channel backends) do not wait
      // On model startup, completion, or failure paths before seeing the user turn.
      void emitUserTranscriptUpdate().catch((error) => {
        context.logGateway.warn(
          `webchat eager user transcript update failed: ${formatForLog(error)}`,
        );
      });

      let agentRunStarted = false;
      void dispatchInboundMessage({
        cfg,
        ctx,
        dispatcher,
        replyOptions: {
          abortSignal: abortController.signal,
          imageOrder: parsedImageOrder.length > 0 ? parsedImageOrder : undefined,
          images: parsedImages.length > 0 ? parsedImages : undefined,
          onAgentRunStart: (runId) => {
            agentRunStarted = true;
            void emitUserTranscriptUpdate();
            const connId = typeof client?.connId === "string" ? client.connId : undefined;
            const wantsToolEvents = hasGatewayClientCap(
              client?.connect?.caps,
              GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
            );
            if (connId && wantsToolEvents) {
              context.registerToolEventRecipient(runId, connId);
              // Register for any other active runs *in the same session* so
              // late-joining clients (e.g. page refresh mid-response) receive
              // in-progress tool events without leaking cross-session data.
              for (const [activeRunId, active] of context.chatAbortControllers) {
                if (activeRunId !== runId && active.sessionKey === p.sessionKey) {
                  context.registerToolEventRecipient(activeRunId, connId);
                }
              }
            }
          },
          onModelSelected,
          runId: clientRunId,
        },
      })
        .then(async () => {
          await rewriteUserTranscriptMedia();
          if (!agentRunStarted) {
            await emitUserTranscriptUpdate();
            const btwReplies = deliveredReplies
              .map((entry) => entry.payload)
              .filter(isBtwReplyPayload);
            const btwText = btwReplies
              .map((payload) => payload.text.trim())
              .filter(Boolean)
              .join("\n\n")
              .trim();
            if (btwReplies.length > 0 && btwText) {
              broadcastSideResult({
                context,
                payload: {
                  isError: btwReplies.some((payload) => payload.isError),
                  kind: "btw",
                  question: btwReplies[0].btw.question.trim(),
                  runId: clientRunId,
                  sessionKey,
                  text: btwText,
                  ts: Date.now(),
                },
              });
              broadcastChatFinal({
                context,
                runId: clientRunId,
                sessionKey,
              });
            } else {
              const finalPayloads = deliveredReplies
                .filter((entry) => entry.kind === "final")
                .map((entry) => entry.payload);
              const combinedReply = finalPayloads
                .map((part) => part.text?.trim() ?? "")
                .filter(Boolean)
                .join("\n\n")
                .trim();
              const audioBlocks = buildWebchatAudioContentBlocksFromReplyPayloads(finalPayloads);
              const assistantContent: Record<string, unknown>[] = [];
              if (combinedReply) {
                assistantContent.push({ text: combinedReply, type: "text" });
              } else if (audioBlocks.length > 0) {
                assistantContent.push({ text: "Audio reply", type: "text" });
              }
              assistantContent.push(...audioBlocks);

              let message: Record<string, unknown> | undefined;
              if (assistantContent.length > 0) {
                const { storePath: latestStorePath, entry: latestEntry } =
                  loadSessionEntry(sessionKey);
                const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
                const transcriptFallbackText =
                  combinedReply || (audioBlocks.length > 0 ? "Audio reply" : "");
                const appended = appendAssistantTranscriptMessage({
                  agentId,
                  content: assistantContent,
                  createIfMissing: true,
                  message: transcriptFallbackText,
                  sessionFile: latestEntry?.sessionFile,
                  sessionId,
                  storePath: latestStorePath,
                });
                if (appended.ok) {
                  ({ message } = appended);
                } else {
                  context.logGateway.warn(
                    `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
                  );
                  const now = Date.now();
                  message = {
                    role: "assistant",
                    content: assistantContent,
                    timestamp: now,
                    // Keep this compatible with Pi stopReason enums even though this message isn't
                    // Persisted to the transcript due to the append failure.
                    stopReason: "stop",
                    usage: { input: 0, output: 0, totalTokens: 0 },
                  };
                }
              }
              broadcastChatFinal({
                context,
                message,
                runId: clientRunId,
                sessionKey,
              });
            }
          } else {
            void emitUserTranscriptUpdate();
          }
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            entry: {
              ok: true,
              payload: { runId: clientRunId, status: "ok" as const },
              ts: Date.now(),
            },
            key: `chat:${clientRunId}`,
          });
        })
        .catch((error) => {
          void rewriteUserTranscriptMedia().catch((rewriteErr) => {
            context.logGateway.warn(
              `webchat transcript media rewrite failed after error: ${formatForLog(rewriteErr)}`,
            );
          });
          void emitUserTranscriptUpdate().catch((transcriptErr) => {
            context.logGateway.warn(
              `webchat user transcript update failed after error: ${formatForLog(transcriptErr)}`,
            );
          });
          const error = errorShape(ErrorCodes.UNAVAILABLE, String(error));
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: {
              ts: Date.now(),
              ok: false,
              payload: {
                runId: clientRunId,
                status: "error" as const,
                summary: String(error),
              },
              error,
            },
          });
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey,
            errorMessage: String(error),
          });
        })
        .finally(() => {
          context.chatAbortControllers.delete(clientRunId);
        });
    } catch (error) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(error));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(error),
      };
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${clientRunId}`,
        entry: {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        },
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(error),
      });
    }
  },
};
