import type { ChannelOutboundAdapter, ChannelPlugin } from "../channels/plugins/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

interface StubChannelOptions {
  id: ChannelPlugin["id"];
  label: string;
  summary?: Record<string, unknown>;
}

const createStubOutboundAdapter = (channelId: ChannelPlugin["id"]): ChannelOutboundAdapter => ({
  deliveryMode: "direct",
  sendMedia: async () => ({
    channel: channelId,
    messageId: `${channelId}-msg`,
  }),
  sendText: async () => ({
    channel: channelId,
    messageId: `${channelId}-msg`,
  }),
});

const createStubChannelPlugin = (params: StubChannelOptions): ChannelPlugin => ({
  capabilities: { chatTypes: ["direct"] },
  config: {
    isConfigured: async () => false,
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: () => ({}),
  },
  gateway: {
    logoutAccount: async () => ({
      cleared: false,
      envToken: false,
      loggedOut: false,
    }),
  },
  id: params.id,
  messaging: {
    normalizeTarget: (raw) => raw,
  },
  meta: {
    blurb: "test stub.",
    docsPath: `/channels/${params.id}`,
    id: params.id,
    label: params.label,
    selectionLabel: params.label,
  },
  outbound: createStubOutboundAdapter(params.id),
  status: {
    buildChannelSummary: async () => ({
      configured: false,
      ...(params.summary ? params.summary : {}),
    }),
  },
});

export function createDefaultGatewayTestChannels() {
  return [
    {
      plugin: createStubChannelPlugin({ id: "whatsapp", label: "WhatsApp" }),
      pluginId: "whatsapp",
      source: "test" as const,
    },
    {
      plugin: createStubChannelPlugin({
        id: "telegram",
        label: "Telegram",
        summary: { lastProbeAt: null, tokenSource: "none" },
      }),
      pluginId: "telegram",
      source: "test" as const,
    },
    {
      plugin: createStubChannelPlugin({ id: "discord", label: "Discord" }),
      pluginId: "discord",
      source: "test" as const,
    },
    {
      plugin: createStubChannelPlugin({ id: "slack", label: "Slack" }),
      pluginId: "slack",
      source: "test" as const,
    },
    {
      plugin: createStubChannelPlugin({
        id: "signal",
        label: "Signal",
        summary: { lastProbeAt: null },
      }),
      pluginId: "signal",
      source: "test" as const,
    },
    {
      plugin: createStubChannelPlugin({ id: "imessage", label: "iMessage" }),
      pluginId: "imessage",
      source: "test" as const,
    },
    {
      plugin: createStubChannelPlugin({ id: "msteams", label: "Microsoft Teams" }),
      pluginId: "msteams",
      source: "test" as const,
    },
    {
      plugin: createStubChannelPlugin({ id: "matrix", label: "Matrix" }),
      pluginId: "matrix",
      source: "test" as const,
    },
    {
      plugin: createStubChannelPlugin({ id: "zalo", label: "Zalo" }),
      pluginId: "zalo",
      source: "test" as const,
    },
    {
      plugin: createStubChannelPlugin({ id: "zalouser", label: "Zalo Personal" }),
      pluginId: "zalouser",
      source: "test" as const,
    },
    {
      plugin: createStubChannelPlugin({ id: "bluebubbles", label: "BlueBubbles" }),
      pluginId: "bluebubbles",
      source: "test" as const,
    },
  ];
}
