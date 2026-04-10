import { getChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelId, ChannelMessageActionName } from "../channels/plugins/types.js";
import type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";
import { formatGatewaySummary, formatOutboundDeliverySummary } from "../infra/outbound/format.js";
import type { MessageActionRunResult } from "../infra/outbound/message-action-runner.js";
import { formatTargetDisplay } from "../infra/outbound/target-resolver.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { isRich, theme } from "../terminal/theme.js";
import { shortenText } from "./text-format.js";

const resolveChannelLabel = (channel: ChannelId) =>
  getChannelPlugin(channel)?.meta.label ?? channel;

function extractMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const direct = (payload as { messageId?: unknown }).messageId;
  const directId = normalizeOptionalString(direct);
  if (directId) {
    return directId;
  }
  const { result } = payload as { result?: unknown };
  if (result && typeof result === "object") {
    const nested = (result as { messageId?: unknown }).messageId;
    const nestedId = normalizeOptionalString(nested);
    if (nestedId) {
      return nestedId;
    }
  }
  return null;
}

export interface MessageCliJsonEnvelope {
  action: ChannelMessageActionName;
  channel: ChannelId;
  dryRun: boolean;
  handledBy: "plugin" | "core" | "dry-run";
  payload: unknown;
}

export function buildMessageCliJson(result: MessageActionRunResult): MessageCliJsonEnvelope {
  return {
    action: result.action,
    channel: result.channel,
    dryRun: result.dryRun,
    handledBy: result.handledBy,
    payload: result.payload,
  };
}

interface FormatOpts {
  width: number;
}

function renderObjectSummary(payload: unknown, opts: FormatOpts): string[] {
  if (!payload || typeof payload !== "object") {
    return [String(payload)];
  }
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return [theme.muted("(empty)")];
  }

  const rows = keys.slice(0, 20).map((k) => {
    const v = obj[k];
    const value =
      v == null
        ? "null"
        : Array.isArray(v)
          ? `${v.length} items`
          : typeof v === "object"
            ? "object"
            : typeof v === "string"
              ? v
              : typeof v === "number"
                ? String(v)
                : typeof v === "boolean"
                  ? v
                    ? "true"
                    : "false"
                  : typeof v === "bigint"
                    ? v.toString()
                    : typeof v === "symbol"
                      ? v.toString()
                      : typeof v === "function"
                        ? "function"
                        : "unknown";
    return { Key: k, Value: shortenText(value, 96) };
  });
  return [
    renderTable({
      columns: [
        { header: "Key", key: "Key", minWidth: 16 },
        { flex: true, header: "Value", key: "Value", minWidth: 24 },
      ],
      rows,
      width: opts.width,
    }).trimEnd(),
  ];
}

function renderMessageList(messages: unknown[], opts: FormatOpts, emptyLabel: string): string[] {
  const rows = messages.slice(0, 25).map((m) => {
    const msg = m as Record<string, unknown>;
    const id =
      (typeof msg.id === "string" && msg.id) ||
      (typeof msg.ts === "string" && msg.ts) ||
      (typeof msg.messageId === "string" && msg.messageId) ||
      "";
    const authorObj = msg.author as Record<string, unknown> | undefined;
    const author =
      (typeof msg.authorTag === "string" && msg.authorTag) ||
      (typeof authorObj?.username === "string" && authorObj.username) ||
      (typeof msg.user === "string" && msg.user) ||
      "";
    const time =
      (typeof msg.timestamp === "string" && msg.timestamp) ||
      (typeof msg.ts === "string" && msg.ts) ||
      "";
    const text =
      (typeof msg.content === "string" && msg.content) ||
      (typeof msg.text === "string" && msg.text) ||
      "";
    return {
      Author: shortenText(author, 22),
      Id: shortenText(id, 22),
      Text: shortenText(text.replace(/\s+/g, " ").trim(), 90),
      Time: shortenText(time, 28),
    };
  });

  if (rows.length === 0) {
    return [theme.muted(emptyLabel)];
  }

  return [
    renderTable({
      columns: [
        { header: "Time", key: "Time", minWidth: 14 },
        { header: "Author", key: "Author", minWidth: 10 },
        { flex: true, header: "Text", key: "Text", minWidth: 24 },
        { header: "Id", key: "Id", minWidth: 10 },
      ],
      rows,
      width: opts.width,
    }).trimEnd(),
  ];
}

function renderMessagesFromPayload(payload: unknown, opts: FormatOpts): string[] | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const { messages } = payload as { messages?: unknown };
  if (!Array.isArray(messages)) {
    return null;
  }
  return renderMessageList(messages, opts, "No messages.");
}

function renderPinsFromPayload(payload: unknown, opts: FormatOpts): string[] | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const { pins } = payload as { pins?: unknown };
  if (!Array.isArray(pins)) {
    return null;
  }
  return renderMessageList(pins, opts, "No pins.");
}

function extractDiscordSearchResultsMessages(results: unknown): unknown[] | null {
  if (!results || typeof results !== "object") {
    return null;
  }
  const raw = (results as { messages?: unknown }).messages;
  if (!Array.isArray(raw)) {
    return null;
  }
  // Discord search returns messages as array-of-array; first element is the message.
  const flattened: unknown[] = [];
  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length > 0) {
      flattened.push(entry[0]);
    } else if (entry && typeof entry === "object") {
      flattened.push(entry);
    }
  }
  return flattened.length ? flattened : null;
}

function renderReactions(payload: unknown, opts: FormatOpts): string[] | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const { reactions } = payload as { reactions?: unknown };
  if (!Array.isArray(reactions)) {
    return null;
  }

  const rows = reactions.slice(0, 50).map((r) => {
    const entry = r as Record<string, unknown>;
    const emojiObj = entry.emoji as Record<string, unknown> | undefined;
    const emoji =
      (typeof emojiObj?.raw === "string" && emojiObj.raw) ||
      (typeof entry.name === "string" && entry.name) ||
      (typeof entry.emoji === "string" && entry.emoji) ||
      "";
    const count = typeof entry.count === "number" ? String(entry.count) : "";
    const userList = Array.isArray(entry.users)
      ? (entry.users as unknown[])
          .slice(0, 8)
          .map((u) => {
            if (typeof u === "string") {
              return u;
            }
            if (!u || typeof u !== "object") {
              return "";
            }
            const user = u as Record<string, unknown>;
            return (
              (typeof user.tag === "string" && user.tag) ||
              (typeof user.username === "string" && user.username) ||
              (typeof user.id === "string" && user.id) ||
              ""
            );
          })
          .filter(Boolean)
      : [];
    return {
      Count: count,
      Emoji: emoji,
      Users: shortenText(userList.join(", "), 72),
    };
  });

  if (rows.length === 0) {
    return [theme.muted("No reactions.")];
  }

  return [
    renderTable({
      columns: [
        { header: "Emoji", key: "Emoji", minWidth: 8 },
        { align: "right", header: "Count", key: "Count", minWidth: 6 },
        { flex: true, header: "Users", key: "Users", minWidth: 20 },
      ],
      rows,
      width: opts.width,
    }).trimEnd(),
  ];
}

export function formatMessageCliText(result: MessageActionRunResult): string[] {
  const rich = isRich();
  const ok = (text: string) => (rich ? theme.success(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);
  const heading = (text: string) => (rich ? theme.heading(text) : text);

  const width = getTerminalTableWidth();
  const opts: FormatOpts = { width };

  if (result.handledBy === "dry-run") {
    return [muted(`[dry-run] would run ${result.action} via ${result.channel}`)];
  }

  if (result.kind === "broadcast") {
    const results = result.payload.results ?? [];
    const rows = results.map((entry) => ({
      Channel: resolveChannelLabel(entry.channel),
      Error: entry.ok ? "" : shortenText(entry.error ?? "unknown error", 48),
      Status: entry.ok ? "ok" : "error",
      Target: shortenText(formatTargetDisplay({ channel: entry.channel, target: entry.to }), 36),
    }));
    const okCount = results.filter((entry) => entry.ok).length;
    const total = results.length;
    const headingLine = ok(
      `✅ Broadcast complete (${okCount}/${total} succeeded, ${total - okCount} failed)`,
    );
    return [
      headingLine,
      renderTable({
        columns: [
          { header: "Channel", key: "Channel", minWidth: 10 },
          { flex: true, header: "Target", key: "Target", minWidth: 12 },
          { header: "Status", key: "Status", minWidth: 6 },
          { flex: true, header: "Error", key: "Error", minWidth: 20 },
        ],
        rows: rows.slice(0, 50),
        width: opts.width,
      }).trimEnd(),
    ];
  }

  if (result.kind === "send") {
    if (result.handledBy === "core" && result.sendResult) {
      const send = result.sendResult;
      if (send.via === "direct") {
        const directResult = send.result as OutboundDeliveryResult | undefined;
        return [ok(formatOutboundDeliverySummary(send.channel, directResult))];
      }
      const gatewayResult = send.result as { messageId?: string } | undefined;
      return [
        ok(
          formatGatewaySummary({
            channel: send.channel,
            messageId: gatewayResult?.messageId ?? null,
          }),
        ),
      ];
    }

    const label = resolveChannelLabel(result.channel);
    const msgId = extractMessageId(result.payload);
    return [ok(`✅ Sent via ${label}.${msgId ? ` Message ID: ${msgId}` : ""}`)];
  }

  if (result.kind === "poll") {
    if (result.handledBy === "core" && result.pollResult) {
      const poll = result.pollResult;
      const pollId = (poll.result as { pollId?: string } | undefined)?.pollId;
      const msgId = poll.result?.messageId ?? null;
      const lines = [
        ok(
          formatGatewaySummary({
            action: "Poll sent",
            channel: poll.channel,
            messageId: msgId,
          }),
        ),
      ];
      if (pollId) {
        lines.push(ok(`Poll id: ${pollId}`));
      }
      return lines;
    }

    const label = resolveChannelLabel(result.channel);
    const msgId = extractMessageId(result.payload);
    return [ok(`✅ Poll sent via ${label}.${msgId ? ` Message ID: ${msgId}` : ""}`)];
  }

  // Channel actions (non-send/poll)
  const { payload } = result;
  const lines: string[] = [];

  if (result.action === "react") {
    const { added } = payload as { added?: unknown };
    const { removed } = payload as { removed?: unknown };
    if (typeof added === "string" && added.trim()) {
      lines.push(ok(`✅ Reaction added: ${added.trim()}`));
      return lines;
    }
    if (typeof removed === "string" && removed.trim()) {
      lines.push(ok(`✅ Reaction removed: ${removed.trim()}`));
      return lines;
    }
    if (Array.isArray(removed)) {
      const list = normalizeStringEntries(removed).join(", ");
      lines.push(ok(`✅ Reactions removed${list ? `: ${list}` : ""}`));
      return lines;
    }
    lines.push(ok("✅ Reaction updated."));
    return lines;
  }

  const reactionsTable = renderReactions(payload, opts);
  if (reactionsTable && result.action === "reactions") {
    lines.push(heading("Reactions"));
    lines.push(reactionsTable[0] ?? "");
    return lines;
  }

  if (result.action === "read") {
    const messagesTable = renderMessagesFromPayload(payload, opts);
    if (messagesTable) {
      lines.push(heading("Messages"));
      lines.push(messagesTable[0] ?? "");
      return lines;
    }
  }

  if (result.action === "list-pins") {
    const pinsTable = renderPinsFromPayload(payload, opts);
    if (pinsTable) {
      lines.push(heading("Pinned messages"));
      lines.push(pinsTable[0] ?? "");
      return lines;
    }
  }

  if (result.action === "search") {
    const { results } = payload as { results?: unknown };
    const list = extractDiscordSearchResultsMessages(results);
    if (list) {
      lines.push(heading("Search results"));
      lines.push(renderMessageList(list, opts, "No results.")[0] ?? "");
      return lines;
    }
  }

  // Generic success + compact details table.
  lines.push(ok(`✅ ${result.action} via ${resolveChannelLabel(result.channel)}.`));
  const summary = renderObjectSummary(payload, opts);
  if (summary.length) {
    lines.push("");
    lines.push(...summary);
    lines.push("");
    lines.push(muted("Tip: use --json for full output."));
  }
  return lines;
}
