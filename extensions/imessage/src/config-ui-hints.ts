import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const iMessageChannelConfigUiHints = {
  "": {
    help: "iMessage channel provider configuration for CLI integration and DM access policy handling. Use explicit CLI paths when runtime environments have non-standard binary locations.",
    label: "iMessage",
  },
  cliPath: {
    help: "Filesystem path to the iMessage bridge CLI binary used for send/receive operations. Set explicitly when the binary is not on PATH in service runtime environments.",
    label: "iMessage CLI Path",
  },
  configWrites: {
    help: "Allow iMessage to write config in response to channel events/commands (default: true).",
    label: "iMessage Config Writes",
  },
  dmPolicy: {
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.imessage.allowFrom=["*"].',
    label: "iMessage DM Policy",
  },
} satisfies Record<string, ChannelConfigUiHint>;
