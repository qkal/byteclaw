import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const msTeamsChannelConfigUiHints = {
  "": {
    help: "Microsoft Teams channel provider configuration and provider-specific policy toggles. Use this section to isolate Teams behavior from other enterprise chat providers.",
    label: "MS Teams",
  },
  configWrites: {
    help: "Allow Microsoft Teams to write config in response to channel events/commands (default: true).",
    label: "MS Teams Config Writes",
  },
} satisfies Record<string, ChannelConfigUiHint>;
