import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";

interface MessageActionTargetAliasSpec {
  aliases: string[];
}

export const messageActionTargetAliases = {
  "channel-info": { aliases: ["chatId"] },
  "list-pins": { aliases: ["chatId"] },
  pin: { aliases: ["messageId"] },
  read: { aliases: ["messageId"] },
  unpin: { aliases: ["messageId"] },
} satisfies Partial<Record<ChannelMessageActionName, MessageActionTargetAliasSpec>>;
