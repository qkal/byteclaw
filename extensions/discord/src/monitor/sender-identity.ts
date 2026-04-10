import type { User } from "@buape/carbon";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { PluralKitMessageInfo } from "../pluralkit.js";
import { formatDiscordUserTag } from "./format.js";

export interface DiscordSenderIdentity {
  id: string;
  name?: string;
  tag?: string;
  label: string;
  isPluralKit: boolean;
  pluralkit?: {
    memberId: string;
    memberName?: string;
    systemId?: string;
    systemName?: string;
  };
}

interface DiscordWebhookMessageLike {
  webhookId?: string | null;
  webhook_id?: string | null;
}

interface DiscordMemberLike {
  nickname?: string | null;
  nick?: string | null;
}

export function resolveDiscordWebhookId(message: DiscordWebhookMessageLike): string | null {
  const candidate = message.webhookId ?? message.webhook_id;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

export function resolveDiscordSenderIdentity(params: {
  author: User;
  member?: DiscordMemberLike | null;
  pluralkitInfo?: PluralKitMessageInfo | null;
}): DiscordSenderIdentity {
  const pkInfo = params.pluralkitInfo ?? null;
  const pkMember = pkInfo?.member ?? undefined;
  const pkSystem = pkInfo?.system ?? undefined;
  const memberId = pkMember?.id?.trim();
  const memberNameRaw = pkMember?.display_name ?? pkMember?.name ?? "";
  const memberName = memberNameRaw?.trim();
  if (memberId && memberName) {
    const systemName = pkSystem?.name?.trim();
    const label = systemName ? `${memberName} (PK:${systemName})` : `${memberName} (PK)`;
    return {
      id: memberId,
      isPluralKit: true,
      label,
      name: memberName,
      pluralkit: {
        memberId,
        memberName,
        systemId: normalizeOptionalString(pkSystem?.id),
        systemName,
      },
      tag: normalizeOptionalString(pkMember?.name),
    };
  }

  const senderTag = formatDiscordUserTag(params.author);
  const senderDisplay =
    params.member?.nickname ??
    params.member?.nick ??
    params.author.globalName ??
    params.author.username;
  const senderLabel =
    senderDisplay && senderTag && senderDisplay !== senderTag
      ? `${senderDisplay} (${senderTag})`
      : (senderDisplay ?? senderTag ?? params.author.id);
  return {
    id: params.author.id,
    isPluralKit: false,
    label: senderLabel,
    name: params.author.username ?? undefined,
    tag: senderTag,
  };
}

export function resolveDiscordSenderLabel(params: {
  author: User;
  member?: DiscordMemberLike | null;
  pluralkitInfo?: PluralKitMessageInfo | null;
}): string {
  return resolveDiscordSenderIdentity(params).label;
}
