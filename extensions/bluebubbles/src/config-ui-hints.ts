import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const bluebubblesChannelConfigUiHints = {
  "": {
    help: "BlueBubbles channel provider configuration used for Apple messaging bridge integrations. Keep DM policy aligned with your trusted sender model in shared deployments.",
    label: "BlueBubbles",
  },
  dmPolicy: {
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.bluebubbles.allowFrom=["*"].',
    label: "BlueBubbles DM Policy",
  },
} satisfies Record<string, ChannelConfigUiHint>;
