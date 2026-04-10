import { readLoggingConfig } from "../logging/config.js";
import { redactIdentifier } from "../logging/redact-identifier.js";
import { getDefaultRedactPatterns, redactSensitiveText } from "../logging/redact.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForConsole } from "./console-sanitize.js";
import { getApiErrorPayloadFingerprint, parseApiErrorInfo } from "./pi-embedded-helpers.js";
import { stableStringify } from "./stable-stringify.js";

export { sanitizeForConsole } from "./console-sanitize.js";

const MAX_OBSERVATION_INPUT_CHARS = 64_000;
const MAX_FINGERPRINT_MESSAGE_CHARS = 8000;
const RAW_ERROR_PREVIEW_MAX_CHARS = 400;
const PROVIDER_ERROR_PREVIEW_MAX_CHARS = 200;
const REQUEST_ID_RE = /\brequest[_ ]?id\b\s*[:=]\s*["'()]*([A-Za-z0-9._:-]+)/i;
const OBSERVATION_EXTRA_REDACT_PATTERNS = [
  String.raw`\b(?:x-)?api[-_]?key\b\s*[:=]\s*(["']?)([^\s"'\\;]+)\1`,
  String.raw`"(?:api[-_]?key|api_key)"\s*:\s*"([^"]+)"`,
  String.raw`(?:\bCookie\b\s*[:=]\s*[^;=\s]+=|;\s*[^;=\s]+=)([^;\s\r\n]+)`,
];

function resolveConfiguredRedactPatterns(): string[] {
  const configured = readLoggingConfig()?.redactPatterns;
  if (!Array.isArray(configured)) {
    return [];
  }
  return configured.filter((pattern): pattern is string => typeof pattern === "string");
}

function truncateForObservation(text: string | undefined, maxChars: number): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

function boundObservationInput(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > MAX_OBSERVATION_INPUT_CHARS
    ? trimmed.slice(0, MAX_OBSERVATION_INPUT_CHARS)
    : trimmed;
}

function replaceRequestIdPreview(
  text: string | undefined,
  requestId: string | undefined,
): string | undefined {
  if (!text || !requestId) {
    return text;
  }
  return text.split(requestId).join(redactIdentifier(requestId, { len: 12 }));
}

function redactObservationText(text: string | undefined): string | undefined {
  if (!text) {
    return text;
  }
  // Observation logs must stay redacted even when operators disable general-purpose
  // Log redaction, otherwise raw provider payloads leak back into always-on logs.
  const configuredPatterns = resolveConfiguredRedactPatterns();
  return redactSensitiveText(text, {
    mode: "tools",
    patterns: [
      ...getDefaultRedactPatterns(),
      ...configuredPatterns,
      ...OBSERVATION_EXTRA_REDACT_PATTERNS,
    ],
  });
}

function buildObservationFingerprint(params: {
  raw: string;
  requestId?: string;
  httpCode?: string;
  type?: string;
  message?: string;
}): string | null {
  const boundedMessage =
    params.message && params.message.length > MAX_FINGERPRINT_MESSAGE_CHARS
      ? params.message.slice(0, MAX_FINGERPRINT_MESSAGE_CHARS)
      : params.message;
  const structured =
    params.httpCode || params.type || boundedMessage
      ? stableStringify({
          httpCode: params.httpCode,
          message: boundedMessage,
          type: params.type,
        })
      : null;
  if (structured) {
    return structured;
  }
  if (params.requestId) {
    return params.raw.split(params.requestId).join("<request_id>");
  }
  return getApiErrorPayloadFingerprint(params.raw);
}

export function buildApiErrorObservationFields(rawError?: string): {
  rawErrorPreview?: string;
  rawErrorHash?: string;
  rawErrorFingerprint?: string;
  httpCode?: string;
  providerErrorType?: string;
  providerErrorMessagePreview?: string;
  requestIdHash?: string;
} {
  const trimmed = boundObservationInput(rawError);
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = parseApiErrorInfo(trimmed);
    const requestId =
      parsed?.requestId ?? normalizeOptionalString(trimmed.match(REQUEST_ID_RE)?.[1]);
    const requestIdHash = requestId ? redactIdentifier(requestId, { len: 12 }) : undefined;
    const rawFingerprint = buildObservationFingerprint({
      httpCode: parsed?.httpCode,
      message: parsed?.message,
      raw: trimmed,
      requestId,
      type: parsed?.type,
    });
    const redactedRawPreview = replaceRequestIdPreview(redactObservationText(trimmed), requestId);
    const redactedProviderMessage = replaceRequestIdPreview(
      redactObservationText(parsed?.message),
      requestId,
    );

    return {
      httpCode: parsed?.httpCode,
      providerErrorMessagePreview: truncateForObservation(
        redactedProviderMessage,
        PROVIDER_ERROR_PREVIEW_MAX_CHARS,
      ),
      providerErrorType: parsed?.type,
      rawErrorFingerprint: rawFingerprint
        ? redactIdentifier(rawFingerprint, { len: 12 })
        : undefined,
      rawErrorHash: redactIdentifier(trimmed, { len: 12 }),
      rawErrorPreview: truncateForObservation(redactedRawPreview, RAW_ERROR_PREVIEW_MAX_CHARS),
      requestIdHash,
    };
  } catch {
    return {};
  }
}

export function buildTextObservationFields(text?: string): {
  textPreview?: string;
  textHash?: string;
  textFingerprint?: string;
  httpCode?: string;
  providerErrorType?: string;
  providerErrorMessagePreview?: string;
  requestIdHash?: string;
} {
  const observed = buildApiErrorObservationFields(text);
  return {
    httpCode: observed.httpCode,
    providerErrorMessagePreview: observed.providerErrorMessagePreview,
    providerErrorType: observed.providerErrorType,
    requestIdHash: observed.requestIdHash,
    textFingerprint: observed.rawErrorFingerprint,
    textHash: observed.rawErrorHash,
    textPreview: observed.rawErrorPreview,
  };
}
