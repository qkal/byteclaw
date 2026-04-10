import { redactToolDetail } from "../logging/redact.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { shortenHomeInString } from "../utils.js";
import {
  defaultTitle,
  formatDetailKey,
  formatToolDetailText,
  normalizeToolName,
  resolveToolVerbAndDetailForArgs,
} from "./tool-display-common.js";
import { TOOL_DISPLAY_CONFIG } from "./tool-display-config.js";

export interface ToolDisplay {
  name: string;
  emoji: string;
  title: string;
  label: string;
  verb?: string;
  detail?: string;
}

const FALLBACK = TOOL_DISPLAY_CONFIG.fallback ?? { emoji: "🧩" };
const TOOL_MAP = TOOL_DISPLAY_CONFIG.tools ?? {};
const DETAIL_LABEL_OVERRIDES: Record<string, string> = {
  agentId: "agent",
  channelId: "channel",
  guildId: "guild",
  includeTools: "tools",
  maxChars: "max chars",
  messageId: "message",
  nodeId: "node",
  pollQuestion: "poll",
  requestId: "request",
  runTimeoutSeconds: "timeout",
  sessionKey: "session",
  targetId: "target",
  targetUrl: "url",
  threadId: "thread",
  timeoutSeconds: "timeout",
  userId: "user",
};
const MAX_DETAIL_ENTRIES = 8;

export function resolveToolDisplay(params: {
  name?: string;
  args?: unknown;
  meta?: string;
}): ToolDisplay {
  const name = normalizeToolName(params.name);
  const key = normalizeLowercaseStringOrEmpty(name);
  const spec = TOOL_MAP[key];
  const emoji = spec?.emoji ?? FALLBACK.emoji ?? "🧩";
  const title = spec?.title ?? defaultTitle(name);
  const label = spec?.label ?? title;
  let { verb, detail } = resolveToolVerbAndDetailForArgs({
    args: params.args,
    detailFormatKey: (raw) => formatDetailKey(raw, DETAIL_LABEL_OVERRIDES),
    detailMaxEntries: MAX_DETAIL_ENTRIES,
    detailMode: "summary",
    fallbackDetailKeys: FALLBACK.detailKeys,
    meta: params.meta,
    spec,
    toolKey: key,
  });

  if (detail) {
    detail = shortenHomeInString(detail);
  }

  return {
    detail,
    emoji,
    label,
    name,
    title,
    verb,
  };
}

export function formatToolDetail(display: ToolDisplay): string | undefined {
  const detailRaw = display.detail ? redactToolDetail(display.detail) : undefined;
  return formatToolDetailText(detailRaw);
}

export function formatToolSummary(display: ToolDisplay): string {
  const detail = formatToolDetail(display);
  return detail
    ? `${display.emoji} ${display.label}: ${detail}`
    : `${display.emoji} ${display.label}`;
}
