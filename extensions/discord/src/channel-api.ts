export { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
export {
  buildTokenChannelStatusSummary,
  PAIRING_APPROVED_MESSAGE,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
} from "openclaw/plugin-sdk/channel-status";
export { createScopedChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
export type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

const DISCORD_CHANNEL_META = {
  blurb: "very well supported right now.",
  detailLabel: "Discord Bot",
  docsLabel: "discord",
  docsPath: "/channels/discord",
  id: "discord",
  label: "Discord",
  markdownCapable: true,
  selectionLabel: "Discord (Bot API)",
  systemImage: "bubble.left.and.bubble.right",
} as const;

export function getChatChannelMeta(id: string) {
  if (id !== DISCORD_CHANNEL_META.id) {
    throw new Error(`Unsupported Discord channel meta lookup: ${id}`);
  }
  return DISCORD_CHANNEL_META;
}
