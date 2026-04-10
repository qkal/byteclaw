import {
  type MessagingTarget,
  type MessagingTargetKind,
  type MessagingTargetParseOptions,
  buildMessagingTarget,
  ensureTargetId,
  parseMentionPrefixOrAtUserTarget,
  requireTargetKind,
} from "openclaw/plugin-sdk/messaging-targets";

export type SlackTargetKind = MessagingTargetKind;

export type SlackTarget = MessagingTarget;

export type SlackTargetParseOptions = MessagingTargetParseOptions;

export function parseSlackTarget(
  raw: string,
  options: SlackTargetParseOptions = {},
): SlackTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const userTarget = parseMentionPrefixOrAtUserTarget({
    atUserErrorMessage: "Slack DMs require a user id (use user:<id> or <@id>)",
    atUserPattern: /^[A-Z0-9]+$/i,
    mentionPattern: /^<@([A-Z0-9]+)>$/i,
    prefixes: [
      { kind: "user", prefix: "user:" },
      { kind: "channel", prefix: "channel:" },
      { kind: "user", prefix: "slack:" },
    ],
    raw: trimmed,
  });
  if (userTarget) {
    return userTarget;
  }
  if (trimmed.startsWith("#")) {
    const candidate = trimmed.slice(1).trim();
    const id = ensureTargetId({
      candidate,
      errorMessage: "Slack channels require a channel id (use channel:<id>)",
      pattern: /^[A-Z0-9]+$/i,
    });
    return buildMessagingTarget("channel", id, trimmed);
  }
  if (options.defaultKind) {
    return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
  }
  return buildMessagingTarget("channel", trimmed, trimmed);
}

export function resolveSlackChannelId(raw: string): string {
  const target = parseSlackTarget(raw, { defaultKind: "channel" });
  return requireTargetKind({ kind: "channel", platform: "Slack", target });
}

export function normalizeSlackMessagingTarget(raw: string): string | undefined {
  return parseSlackTarget(raw, { defaultKind: "channel" })?.normalized;
}

export function looksLikeSlackTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^<@([A-Z0-9]+)>$/i.test(trimmed)) {
    return true;
  }
  if (/^(user|channel):/i.test(trimmed)) {
    return true;
  }
  if (/^slack:/i.test(trimmed)) {
    return true;
  }
  if (/^[@#]/.test(trimmed)) {
    return true;
  }
  return /^[CUWGD][A-Z0-9]{8,}$/i.test(trimmed);
}
