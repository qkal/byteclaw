import { truncateSlackText } from "../../truncate.js";
import type { SlackMonitorContext } from "../context.js";
import { registerSlackBlockActionHandler, summarizeAction } from "./interactions.block-actions.js";
import {
  type ModalInputSummary,
  type RegisterSlackModalHandler,
  registerModalLifecycleHandler,
} from "./interactions.modal.js";

// Prefix for OpenClaw-generated action IDs to scope our handler
const OPENCLAW_ACTION_PREFIX = "openclaw:";
const SLACK_INTERACTION_EVENT_PREFIX = "Slack interaction: ";
const REDACTED_INTERACTION_VALUE = "[redacted]";
const SLACK_INTERACTION_EVENT_MAX_CHARS = 2400;
const SLACK_INTERACTION_STRING_MAX_CHARS = 160;
const SLACK_INTERACTION_ARRAY_MAX_ITEMS = 64;
const SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS = 3;
const SLACK_INTERACTION_REDACTED_KEYS = new Set([
  "triggerId",
  "responseUrl",
  "workflowTriggerUrl",
  "privateMetadata",
  "viewHash",
]);

function sanitizeSlackInteractionPayloadValue(value: unknown, key?: string): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (key && SLACK_INTERACTION_REDACTED_KEYS.has(key)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return undefined;
    }
    return REDACTED_INTERACTION_VALUE;
  }
  if (typeof value === "string") {
    return truncateSlackText(value, SLACK_INTERACTION_STRING_MAX_CHARS);
  }
  if (Array.isArray(value)) {
    const sanitized = value
      .slice(0, SLACK_INTERACTION_ARRAY_MAX_ITEMS)
      .map((entry) => sanitizeSlackInteractionPayloadValue(entry))
      .filter((entry) => entry !== undefined);
    if (value.length > SLACK_INTERACTION_ARRAY_MAX_ITEMS) {
      sanitized.push(`…+${value.length - SLACK_INTERACTION_ARRAY_MAX_ITEMS} more`);
    }
    return sanitized;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    const sanitized = sanitizeSlackInteractionPayloadValue(entryValue, entryKey);
    if (sanitized === undefined) {
      continue;
    }
    if (typeof sanitized === "string" && sanitized.length === 0) {
      continue;
    }
    if (Array.isArray(sanitized) && sanitized.length === 0) {
      continue;
    }
    output[entryKey] = sanitized;
  }
  return output;
}

function buildCompactSlackInteractionPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const rawInputs = Array.isArray(payload.inputs) ? payload.inputs : [];
  const compactInputs = rawInputs
    .slice(0, SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS)
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const typed = entry as Record<string, unknown>;
      return [
        {
          actionId: typed.actionId,
          actionType: typed.actionType,
          blockId: typed.blockId,
          inputKind: typed.inputKind,
          inputNumber: typed.inputNumber,
          inputValue: typed.inputValue,
          richTextPreview: typed.richTextPreview,
          selectedDate: typed.selectedDate,
          selectedDateTime: typed.selectedDateTime,
          selectedLabels: typed.selectedLabels,
          selectedTime: typed.selectedTime,
          selectedValues: typed.selectedValues,
        },
      ];
    });

  return {
    actionId: payload.actionId,
    actionType: payload.actionType,
    callbackId: payload.callbackId,
    channelId: payload.channelId ?? payload.routedChannelId,
    inputs: compactInputs.length > 0 ? compactInputs : undefined,
    inputsOmitted:
      rawInputs.length > SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS
        ? rawInputs.length - SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS
        : undefined,
    interactionType: payload.interactionType,
    isCleared: payload.isCleared,
    messageTs: payload.messageTs,
    payloadTruncated: true,
    routedChannelType: payload.routedChannelType,
    selectedDate: payload.selectedDate,
    selectedDateTime: payload.selectedDateTime,
    selectedLabels: payload.selectedLabels,
    selectedTime: payload.selectedTime,
    selectedValues: payload.selectedValues,
    teamId: payload.teamId,
    threadTs: payload.threadTs,
    userId: payload.userId,
    viewId: payload.viewId,
    workflowId: payload.workflowId,
  };
}

function formatSlackInteractionSystemEvent(payload: Record<string, unknown>): string {
  const toEventText = (value: Record<string, unknown>): string =>
    `${SLACK_INTERACTION_EVENT_PREFIX}${JSON.stringify(value)}`;

  const sanitizedPayload =
    (sanitizeSlackInteractionPayloadValue(payload) as Record<string, unknown> | undefined) ?? {};
  let eventText = toEventText(sanitizedPayload);
  if (eventText.length <= SLACK_INTERACTION_EVENT_MAX_CHARS) {
    return eventText;
  }

  const compactPayload = sanitizeSlackInteractionPayloadValue(
    buildCompactSlackInteractionPayload(sanitizedPayload),
  ) as Record<string, unknown>;
  eventText = toEventText(compactPayload);
  if (eventText.length <= SLACK_INTERACTION_EVENT_MAX_CHARS) {
    return eventText;
  }

  return toEventText({
    actionId: sanitizedPayload.actionId ?? "unknown",
    channelId: sanitizedPayload.channelId ?? sanitizedPayload.routedChannelId,
    interactionType: sanitizedPayload.interactionType,
    payloadTruncated: true,
    userId: sanitizedPayload.userId,
  });
}

function summarizeViewState(values: unknown): ModalInputSummary[] {
  if (!values || typeof values !== "object") {
    return [];
  }
  const entries: ModalInputSummary[] = [];
  for (const [blockId, blockValue] of Object.entries(values as Record<string, unknown>)) {
    if (!blockValue || typeof blockValue !== "object") {
      continue;
    }
    for (const [actionId, rawAction] of Object.entries(blockValue as Record<string, unknown>)) {
      if (!rawAction || typeof rawAction !== "object") {
        continue;
      }
      const actionSummary = summarizeAction(rawAction as Record<string, unknown>);
      entries.push({
        actionId,
        blockId,
        ...actionSummary,
      });
    }
  }
  return entries;
}

export function registerSlackInteractionEvents(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;
  registerSlackBlockActionHandler({
    ctx,
    formatSystemEvent: formatSlackInteractionSystemEvent,
  });

  if (typeof ctx.app.view !== "function") {
    return;
  }
  const modalMatcher = new RegExp(`^${OPENCLAW_ACTION_PREFIX}`);

  // Handle OpenClaw modal submissions with callback_ids scoped by our prefix.
  registerModalLifecycleHandler({
    contextPrefix: "slack:interaction:view",
    ctx,
    formatSystemEvent: formatSlackInteractionSystemEvent,
    interactionType: "view_submission",
    matcher: modalMatcher,
    register: (matcher, handler) => ctx.app.view(matcher, handler),
    summarizeViewState,
  });

  const { viewClosed } = ctx.app as unknown as {
    viewClosed?: RegisterSlackModalHandler;
  };
  if (typeof viewClosed !== "function") {
    return;
  }

  // Handle modal close events so agent workflows can react to cancelled forms.
  registerModalLifecycleHandler({
    contextPrefix: "slack:interaction:view-closed",
    ctx,
    formatSystemEvent: formatSlackInteractionSystemEvent,
    interactionType: "view_closed",
    matcher: modalMatcher,
    register: viewClosed,
    summarizeViewState,
  });
}
