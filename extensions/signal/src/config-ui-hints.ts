import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const signalChannelConfigUiHints = {
  "": {
    help: "Signal channel provider configuration including account identity and DM policy behavior. Keep account mapping explicit so routing remains stable across multi-device setups.",
    label: "Signal",
  },
  account: {
    help: "Signal account identifier (phone/number handle) used to bind this channel config to a specific Signal identity. Keep this aligned with your linked device/session state.",
    label: "Signal Account",
  },
  configWrites: {
    help: "Allow Signal to write config in response to channel events/commands (default: true).",
    label: "Signal Config Writes",
  },
  dmPolicy: {
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.signal.allowFrom=["*"].',
    label: "Signal DM Policy",
  },
} satisfies Record<string, ChannelConfigUiHint>;
