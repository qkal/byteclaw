import { createEnvPatchedAccountSetupAdapter } from "openclaw/plugin-sdk/setup-adapter-runtime";
import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/setup-runtime";

const channel = "discord" as const;

export const discordSetupAdapter: ChannelSetupAdapter = createEnvPatchedAccountSetupAdapter({
  buildPatch: (input) => (input.token ? { token: input.token } : {}),
  channelKey: channel,
  defaultAccountOnlyEnvError: "DISCORD_BOT_TOKEN can only be used for the default account.",
  hasCredentials: (input) => Boolean(input.token),
  missingCredentialError: "Discord requires token (or --use-env).",
});
