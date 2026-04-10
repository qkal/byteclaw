import { buildUntrustedChannelMetadata } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

export function resolveSlackRoomContextHints(params: {
  isRoomish: boolean;
  channelInfo?: { topic?: string; purpose?: string };
  channelConfig?: { systemPrompt?: string | null } | null;
}): {
  untrustedChannelMetadata?: ReturnType<typeof buildUntrustedChannelMetadata>;
  groupSystemPrompt?: string;
} {
  const untrustedChannelMetadata = params.isRoomish
    ? buildUntrustedChannelMetadata({
        entries: [params.channelInfo?.topic, params.channelInfo?.purpose],
        label: "Slack channel description",
        source: "slack",
      })
    : undefined;

  const systemPromptParts = [
    params.isRoomish ? (normalizeOptionalString(params.channelConfig?.systemPrompt) ?? null) : null,
  ].filter((entry): entry is string => Boolean(entry));
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;

  return {
    groupSystemPrompt,
    untrustedChannelMetadata,
  };
}
