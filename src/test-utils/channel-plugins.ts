import type {
  ChannelCapabilities,
  ChannelId,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../channels/plugins/types.js";
import type { PluginRegistry } from "../plugins/registry.js";

export interface TestChannelRegistration {
  pluginId: string;
  plugin: unknown;
  source: string;
}

export const createTestRegistry = (channels: TestChannelRegistration[] = []): PluginRegistry => ({
  channelSetups: channels.map((entry) => ({
    enabled: true,
    plugin: entry.plugin as PluginRegistry["channelSetups"][number]["plugin"],
    pluginId: entry.pluginId,
    source: entry.source,
  })),
  channels: channels as unknown as PluginRegistry["channels"],
  cliRegistrars: [],
  commands: [],
  conversationBindingResolvedHandlers: [],
  diagnostics: [],
  gatewayHandlers: {},
  gatewayMethodScopes: {},
  hooks: [],
  httpRoutes: [],
  imageGenerationProviders: [],
  mediaUnderstandingProviders: [],
  memoryEmbeddingProviders: [],
  musicGenerationProviders: [],
  nodeHostCommands: [],
  plugins: [],
  providers: [],
  realtimeTranscriptionProviders: [],
  realtimeVoiceProviders: [],
  reloads: [],
  securityAuditCollectors: [],
  services: [],
  speechProviders: [],
  tools: [],
  typedHooks: [],
  videoGenerationProviders: [],
  webFetchProviders: [],
  webSearchProviders: [],
});

export const createChannelTestPluginBase = (params: {
  id: ChannelId;
  label?: string;
  docsPath?: string;
  markdownCapable?: boolean;
  capabilities?: ChannelCapabilities;
  config?: Partial<ChannelPlugin["config"]>;
}): Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config"> => ({
  capabilities: params.capabilities ?? { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({}),
    ...params.config,
  },
  id: params.id,
  meta: {
    blurb: "test stub.",
    docsPath: params.docsPath ?? `/channels/${params.id}`,
    id: params.id,
    label: params.label ?? String(params.id),
    selectionLabel: params.label ?? String(params.id),
    ...(params.markdownCapable !== undefined ? { markdownCapable: params.markdownCapable } : {}),
  },
});

export const createMSTeamsTestPluginBase = (): Pick<
  ChannelPlugin,
  "id" | "meta" | "capabilities" | "config"
> => {
  const base = createChannelTestPluginBase({
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
    docsPath: "/channels/msteams",
    id: "msteams",
    label: "Microsoft Teams",
  });
  return {
    ...base,
    meta: {
      ...base.meta,
      aliases: ["teams"],
      blurb: "Teams SDK; enterprise support.",
      selectionLabel: "Microsoft Teams (Bot Framework)",
    },
  };
};

export const createMSTeamsTestPlugin = (params?: {
  aliases?: string[];
  outbound?: ChannelOutboundAdapter;
}): ChannelPlugin => {
  const base = createMSTeamsTestPluginBase();
  return {
    ...base,
    meta: {
      ...base.meta,
      ...(params?.aliases ? { aliases: params.aliases } : {}),
    },
    ...(params?.outbound ? { outbound: params.outbound } : {}),
  };
};

export const createOutboundTestPlugin = (params: {
  id: ChannelId;
  outbound: ChannelOutboundAdapter;
  messaging?: ChannelMessagingAdapter;
  label?: string;
  docsPath?: string;
  capabilities?: ChannelCapabilities;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    capabilities: params.capabilities,
    config: { listAccountIds: () => [] },
    docsPath: params.docsPath,
    id: params.id,
    label: params.label,
  }),
  outbound: params.outbound,
  ...(params.messaging ? { messaging: params.messaging } : {}),
});

export type BindingResolverTestPlugin = Pick<
  ChannelPlugin,
  "id" | "meta" | "capabilities" | "config"
> & {
  setup?: Pick<NonNullable<ChannelPlugin["setup"]>, "resolveBindingAccountId">;
};

export const createBindingResolverTestPlugin = (params: {
  id: ChannelId;
  label?: string;
  docsPath?: string;
  capabilities?: ChannelCapabilities;
  config?: Partial<ChannelPlugin["config"]>;
  resolveBindingAccountId?: NonNullable<ChannelPlugin["setup"]>["resolveBindingAccountId"];
}): BindingResolverTestPlugin => ({
  ...createChannelTestPluginBase({
    capabilities: params.capabilities,
    config: params.config,
    docsPath: params.docsPath,
    id: params.id,
    label: params.label,
  }),
  ...(params.resolveBindingAccountId
    ? {
        setup: {
          resolveBindingAccountId: params.resolveBindingAccountId,
        },
      }
    : {}),
});
