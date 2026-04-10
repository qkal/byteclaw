import type { TSchema } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeAnyChannelId } from "../registry.js";
import { getChannelPlugin, listChannelPlugins } from "./index.js";
import type { ChannelMessageCapability } from "./message-capabilities.js";
import type {
  ChannelMessageActionDiscoveryContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "./types.js";

export interface ChannelMessageActionDiscoveryInput {
  cfg?: OpenClawConfig;
  channel?: string | null;
  currentChannelProvider?: string | null;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
}

type ChannelActions = NonNullable<NonNullable<ReturnType<typeof getChannelPlugin>>["actions"]>;

const loggedMessageActionErrors = new Set<string>();

export function resolveMessageActionDiscoveryChannelId(raw?: string | null): string | undefined {
  return normalizeAnyChannelId(raw) ?? normalizeOptionalString(raw);
}

export function createMessageActionDiscoveryContext(
  params: ChannelMessageActionDiscoveryInput,
): ChannelMessageActionDiscoveryContext {
  const currentChannelProvider = resolveMessageActionDiscoveryChannelId(
    params.channel ?? params.currentChannelProvider,
  );
  return {
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg ?? ({} as OpenClawConfig),
    currentChannelId: params.currentChannelId,
    currentChannelProvider,
    currentMessageId: params.currentMessageId,
    currentThreadTs: params.currentThreadTs,
    requesterSenderId: params.requesterSenderId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  };
}

function logMessageActionError(params: {
  pluginId: string;
  operation: "describeMessageTool";
  error: unknown;
}) {
  const message = formatErrorMessage(params.error);
  const key = `${params.pluginId}:${params.operation}:${message}`;
  if (loggedMessageActionErrors.has(key)) {
    return;
  }
  loggedMessageActionErrors.add(key);
  const stack = params.error instanceof Error && params.error.stack ? params.error.stack : null;
  defaultRuntime.error?.(
    `[message-action-discovery] ${params.pluginId}.actions.${params.operation} failed: ${stack ?? message}`,
  );
}

function describeMessageToolSafely(params: {
  pluginId: string;
  context: ChannelMessageActionDiscoveryContext;
  describeMessageTool: NonNullable<ChannelActions["describeMessageTool"]>;
}): ChannelMessageToolDiscovery | null {
  try {
    return params.describeMessageTool(params.context) ?? null;
  } catch (error) {
    logMessageActionError({
      error,
      operation: "describeMessageTool",
      pluginId: params.pluginId,
    });
    return null;
  }
}

function normalizeToolSchemaContributions(
  value:
    | ChannelMessageToolSchemaContribution
    | ChannelMessageToolSchemaContribution[]
    | null
    | undefined,
): ChannelMessageToolSchemaContribution[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

interface ResolvedChannelMessageActionDiscovery {
  actions: ChannelMessageActionName[];
  capabilities: readonly ChannelMessageCapability[];
  schemaContributions: ChannelMessageToolSchemaContribution[];
}

export function resolveMessageActionDiscoveryForPlugin(params: {
  pluginId: string;
  actions?: ChannelActions;
  context: ChannelMessageActionDiscoveryContext;
  includeActions?: boolean;
  includeCapabilities?: boolean;
  includeSchema?: boolean;
}): ResolvedChannelMessageActionDiscovery {
  const adapter = params.actions;
  if (!adapter) {
    return {
      actions: [],
      capabilities: [],
      schemaContributions: [],
    };
  }

  const described = describeMessageToolSafely({
    context: params.context,
    describeMessageTool: adapter.describeMessageTool,
    pluginId: params.pluginId,
  });
  return {
    actions:
      params.includeActions && Array.isArray(described?.actions) ? [...described.actions] : [],
    capabilities:
      params.includeCapabilities && Array.isArray(described?.capabilities)
        ? described.capabilities
        : [],
    schemaContributions: params.includeSchema
      ? normalizeToolSchemaContributions(described?.schema)
      : [],
  };
}

export function listChannelMessageActions(cfg: OpenClawConfig): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>(["send", "broadcast"]);
  for (const plugin of listChannelPlugins()) {
    for (const action of resolveMessageActionDiscoveryForPlugin({
      actions: plugin.actions,
      context: { cfg },
      includeActions: true,
      pluginId: plugin.id,
    }).actions) {
      actions.add(action);
    }
  }
  return [...actions];
}

export function listChannelMessageCapabilities(cfg: OpenClawConfig): ChannelMessageCapability[] {
  const capabilities = new Set<ChannelMessageCapability>();
  for (const plugin of listChannelPlugins()) {
    for (const capability of resolveMessageActionDiscoveryForPlugin({
      actions: plugin.actions,
      context: { cfg },
      includeCapabilities: true,
      pluginId: plugin.id,
    }).capabilities) {
      capabilities.add(capability);
    }
  }
  return [...capabilities];
}

export function listChannelMessageCapabilitiesForChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
}): ChannelMessageCapability[] {
  const channelId = resolveMessageActionDiscoveryChannelId(params.channel);
  if (!channelId) {
    return [];
  }
  const plugin = getChannelPlugin(channelId as Parameters<typeof getChannelPlugin>[0]);
  return plugin?.actions
    ? [...resolveMessageActionDiscoveryForPlugin({
	actions: plugin.actions,
	context: createMessageActionDiscoveryContext(params),
	includeCapabilities: true,
	pluginId: plugin.id
}).capabilities]
    : [];
}

function mergeToolSchemaProperties(
  target: Record<string, TSchema>,
  source: Record<string, TSchema> | undefined,
) {
  if (!source) {
    return;
  }
  for (const [name, schema] of Object.entries(source)) {
    if (!(name in target)) {
      target[name] = schema;
    }
  }
}

export function resolveChannelMessageToolSchemaProperties(params: {
  cfg: OpenClawConfig;
  channel?: string;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
}): Record<string, TSchema> {
  const properties: Record<string, TSchema> = {};
  const currentChannel = resolveMessageActionDiscoveryChannelId(params.channel);
  const discoveryBase = createMessageActionDiscoveryContext(params);

  for (const plugin of listChannelPlugins()) {
    if (!plugin.actions) {
      continue;
    }
    for (const contribution of resolveMessageActionDiscoveryForPlugin({
      actions: plugin.actions,
      context: discoveryBase,
      includeSchema: true,
      pluginId: plugin.id,
    }).schemaContributions) {
      const visibility = contribution.visibility ?? "current-channel";
      if (currentChannel) {
        if (visibility === "all-configured" || plugin.id === currentChannel) {
          mergeToolSchemaProperties(properties, contribution.properties);
        }
        continue;
      }
      mergeToolSchemaProperties(properties, contribution.properties);
    }
  }

  return properties;
}

export function channelSupportsMessageCapability(
  cfg: OpenClawConfig,
  capability: ChannelMessageCapability,
): boolean {
  return listChannelMessageCapabilities(cfg).includes(capability);
}

export function channelSupportsMessageCapabilityForChannel(
  params: {
    cfg: OpenClawConfig;
    channel?: string;
    currentChannelId?: string | null;
    currentThreadTs?: string | null;
    currentMessageId?: string | number | null;
    accountId?: string | null;
    sessionKey?: string | null;
    sessionId?: string | null;
    agentId?: string | null;
    requesterSenderId?: string | null;
  },
  capability: ChannelMessageCapability,
): boolean {
  return listChannelMessageCapabilitiesForChannel(params).includes(capability);
}

export const __testing = {
  resetLoggedMessageActionErrors() {
    loggedMessageActionErrors.clear();
  },
};
