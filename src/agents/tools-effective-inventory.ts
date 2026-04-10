import type { OpenClawConfig } from "../config/config.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import { getChannelAgentToolMeta } from "./channel-tools.js";
import { resolveModel } from "./pi-embedded-runner/model.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import { resolveEffectiveToolPolicy } from "./pi-tools.policy.js";
import { summarizeToolDescriptionText } from "./tool-description-summary.js";
import { resolveToolDisplay } from "./tool-display.js";
import type { AnyAgentTool } from "./tools/common.js";

export type EffectiveToolSource = "core" | "plugin" | "channel";

export interface EffectiveToolInventoryEntry {
  id: string;
  label: string;
  description: string;
  rawDescription: string;
  source: EffectiveToolSource;
  pluginId?: string;
  channelId?: string;
}

export interface EffectiveToolInventoryGroup {
  id: EffectiveToolSource;
  label: string;
  source: EffectiveToolSource;
  tools: EffectiveToolInventoryEntry[];
}

export interface EffectiveToolInventoryResult {
  agentId: string;
  profile: string;
  groups: EffectiveToolInventoryGroup[];
}

export interface ResolveEffectiveToolInventoryParams {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  agentDir?: string;
  messageProvider?: string;
  senderIsOwner?: boolean;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  accountId?: string | null;
  modelProvider?: string;
  modelId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  replyToMode?: "off" | "first" | "all" | "batched";
  modelHasVision?: boolean;
  requireExplicitMessageTarget?: boolean;
  disableMessageTool?: boolean;
}

function resolveEffectiveToolLabel(tool: AnyAgentTool): string {
  const rawLabel = normalizeOptionalString(tool.label) ?? "";
  if (
    rawLabel &&
    normalizeLowercaseStringOrEmpty(rawLabel) !== normalizeLowercaseStringOrEmpty(tool.name)
  ) {
    return rawLabel;
  }
  return resolveToolDisplay({ name: tool.name }).title;
}

function resolveRawToolDescription(tool: AnyAgentTool): string {
  return normalizeOptionalString(tool.description) ?? "";
}

function summarizeToolDescription(tool: AnyAgentTool): string {
  return summarizeToolDescriptionText({
    displaySummary: tool.displaySummary,
    rawDescription: resolveRawToolDescription(tool),
  });
}

function resolveEffectiveToolSource(tool: AnyAgentTool): {
  source: EffectiveToolSource;
  pluginId?: string;
  channelId?: string;
} {
  const pluginMeta = getPluginToolMeta(tool);
  if (pluginMeta) {
    return { pluginId: pluginMeta.pluginId, source: "plugin" };
  }
  const channelMeta = getChannelAgentToolMeta(tool as never);
  if (channelMeta) {
    return { channelId: channelMeta.channelId, source: "channel" };
  }
  return { source: "core" };
}

function groupLabel(source: EffectiveToolSource): string {
  switch (source) {
    case "plugin": {
      return "Connected tools";
    }
    case "channel": {
      return "Channel tools";
    }
    default: {
      return "Built-in tools";
    }
  }
}

function disambiguateLabels(entries: EffectiveToolInventoryEntry[]): EffectiveToolInventoryEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  }
  return entries.map((entry) => {
    if ((counts.get(entry.label) ?? 0) < 2) {
      return entry;
    }
    const suffix = entry.pluginId ?? entry.channelId ?? entry.id;
    return { ...entry, label: `${entry.label} (${suffix})` };
  });
}

function resolveEffectiveModelCompat(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  modelProvider?: string;
  modelId?: string;
}) {
  const provider = params.modelProvider?.trim();
  const modelId = params.modelId?.trim();
  if (!provider || !modelId) {
    return undefined;
  }
  try {
    return resolveModel(provider, modelId, params.agentDir, params.cfg).model?.compat;
  } catch {
    return undefined;
  }
}

export function resolveEffectiveToolInventory(
  params: ResolveEffectiveToolInventoryParams,
): EffectiveToolInventoryResult {
  const agentId =
    params.agentId?.trim() ||
    resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey });
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const agentDir = params.agentDir ?? resolveAgentDir(params.cfg, agentId);
  const modelCompat = resolveEffectiveModelCompat({
    agentDir,
    cfg: params.cfg,
    modelId: params.modelId,
    modelProvider: params.modelProvider,
  });

  const effectiveTools = createOpenClawCodingTools({
    agentAccountId: params.accountId ?? undefined,
    agentDir,
    agentId,
    allowGatewaySubagentBinding: true,
    config: params.cfg,
    currentChannelId: params.currentChannelId,
    currentMessageId: params.currentMessageId,
    currentThreadTs: params.currentThreadTs,
    disableMessageTool: params.disableMessageTool,
    groupChannel: params.groupChannel ?? undefined,
    groupId: params.groupId ?? undefined,
    groupSpace: params.groupSpace ?? undefined,
    messageProvider: params.messageProvider,
    modelCompat,
    modelHasVision: params.modelHasVision,
    modelId: params.modelId,
    modelProvider: params.modelProvider,
    replyToMode: params.replyToMode,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    senderE164: params.senderE164 ?? undefined,
    senderId: params.senderId,
    senderIsOwner: params.senderIsOwner,
    senderName: params.senderName ?? undefined,
    senderUsername: params.senderUsername ?? undefined,
    sessionKey: params.sessionKey,
    workspaceDir,
  });
  const effectivePolicy = resolveEffectiveToolPolicy({
    agentId,
    config: params.cfg,
    modelId: params.modelId,
    modelProvider: params.modelProvider,
    sessionKey: params.sessionKey,
  });
  const profile = effectivePolicy.providerProfile ?? effectivePolicy.profile ?? "full";

  const entries = disambiguateLabels(
    effectiveTools
      .map((tool) => {
        const source = resolveEffectiveToolSource(tool);
        return (Object.assign({id:tool.name,label:resolveEffectiveToolLabel(tool),description:summarizeToolDescription(tool),rawDescription:resolveRawToolDescription(tool)||summarizeToolDescription(tool)}, source)) satisfies EffectiveToolInventoryEntry;
      })
      .toSorted((a, b) => a.label.localeCompare(b.label)),
  );
  const groupsBySource = new Map<EffectiveToolSource, EffectiveToolInventoryEntry[]>();
  for (const entry of entries) {
    const tools = groupsBySource.get(entry.source) ?? [];
    tools.push(entry);
    groupsBySource.set(entry.source, tools);
  }

  const groups = (["core", "plugin", "channel"] as const)
    .map((source) => {
      const tools = groupsBySource.get(source);
      if (!tools || tools.length === 0) {
        return null;
      }
      return {
        id: source,
        label: groupLabel(source),
        source,
        tools,
      } satisfies EffectiveToolInventoryGroup;
    })
    .filter((group): group is EffectiveToolInventoryGroup => group !== null);

  return { agentId, groups, profile };
}
