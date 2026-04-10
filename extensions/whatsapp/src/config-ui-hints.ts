import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const whatsAppChannelConfigUiHints = {
  "": {
    help: "WhatsApp channel provider configuration for access policy and message batching behavior. Use this section to tune responsiveness and direct-message routing safety for WhatsApp chats.",
    label: "WhatsApp",
  },
  configWrites: {
    help: "Allow WhatsApp to write config in response to channel events/commands (default: true).",
    label: "WhatsApp Config Writes",
  },
  debounceMs: {
    help: "Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable).",
    label: "WhatsApp Message Debounce (ms)",
  },
  dmPolicy: {
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.whatsapp.allowFrom=["*"].',
    label: "WhatsApp DM Policy",
  },
  selfChatMode: {
    help: "Same-phone setup (bot uses your personal WhatsApp number).",
    label: "WhatsApp Self-Phone Mode",
  },
} satisfies Record<string, ChannelConfigUiHint>;
