import {
  type MessagingTarget,
  type MessagingTargetKind,
  type MessagingTargetParseOptions,
  buildMessagingTarget,
  parseMentionPrefixOrAtUserTarget,
  requireTargetKind,
} from "openclaw/plugin-sdk/messaging-targets";

export type DiscordTargetKind = MessagingTargetKind;

export type DiscordTarget = MessagingTarget;

export type DiscordTargetParseOptions = MessagingTargetParseOptions;

export function parseDiscordTarget(
  raw: string,
  options: DiscordTargetParseOptions = {},
): DiscordTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const userTarget = parseMentionPrefixOrAtUserTarget({
    atUserErrorMessage: "Discord DMs require a user id (use user:<id> or a <@id> mention)",
    atUserPattern: /^\d+$/,
    mentionPattern: /^<@!?(\d+)>$/,
    prefixes: [
      { kind: "user", prefix: "user:" },
      { kind: "channel", prefix: "channel:" },
      { kind: "user", prefix: "discord:" },
    ],
    raw: trimmed,
  });
  if (userTarget) {
    return userTarget;
  }
  if (/^\d+$/.test(trimmed)) {
    if (options.defaultKind) {
      return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
    }
    throw new Error(
      options.ambiguousMessage ??
        `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`,
    );
  }
  return buildMessagingTarget("channel", trimmed, trimmed);
}

export function resolveDiscordChannelId(raw: string): string {
  const target = parseDiscordTarget(raw, { defaultKind: "channel" });
  return requireTargetKind({ kind: "channel", platform: "Discord", target });
}
