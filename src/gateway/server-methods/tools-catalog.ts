import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  PROFILE_OPTIONS,
  listCoreToolSections,
  resolveCoreToolProfiles,
} from "../../agents/tool-catalog.js";
import { summarizeToolDescriptionText } from "../../agents/tool-description-summary.js";
import { loadConfig } from "../../config/config.js";
import { getPluginToolMeta, resolvePluginTools } from "../../plugins/tools.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  ErrorCodes,
  type ToolsCatalogResult,
  errorShape,
  formatValidationErrors,
  validateToolsCatalogParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

interface ToolCatalogEntry {
  id: string;
  label: string;
  description: string;
  source: "core" | "plugin";
  pluginId?: string;
  optional?: boolean;
  defaultProfiles: ("minimal" | "coding" | "messaging" | "full")[];
}

interface ToolCatalogGroup {
  id: string;
  label: string;
  source: "core" | "plugin";
  pluginId?: string;
  tools: ToolCatalogEntry[];
}

function resolveAgentIdOrRespondError(rawAgentId: unknown, respond: RespondFn) {
  const cfg = loadConfig();
  const knownAgents = listAgentIds(cfg);
  const requestedAgentId = normalizeOptionalString(rawAgentId) ?? "";
  const agentId = requestedAgentId || resolveDefaultAgentId(cfg);
  if (requestedAgentId && !knownAgents.includes(agentId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return { agentId, cfg };
}

function buildCoreGroups(): ToolCatalogGroup[] {
  return listCoreToolSections().map((section) => ({
    id: section.id,
    label: section.label,
    source: "core",
    tools: section.tools.map((tool) => ({
      defaultProfiles: resolveCoreToolProfiles(tool.id),
      description: tool.description,
      id: tool.id,
      label: tool.label,
      source: "core",
    })),
  }));
}

function buildPluginGroups(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  existingToolNames: Set<string>;
}): ToolCatalogGroup[] {
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  const pluginTools = resolvePluginTools({
    allowGatewaySubagentBinding: true,
    context: {
      agentDir,
      agentId: params.agentId,
      config: params.cfg,
      workspaceDir,
    },
    existingToolNames: params.existingToolNames,
    suppressNameConflicts: true,
    toolAllowlist: ["group:plugins"],
  });
  const groups = new Map<string, ToolCatalogGroup>();
  for (const tool of pluginTools) {
    const meta = getPluginToolMeta(tool);
    const pluginId = meta?.pluginId ?? "plugin";
    const groupId = `plugin:${pluginId}`;
    const existing =
      groups.get(groupId) ??
      ({
        id: groupId,
        label: pluginId,
        pluginId,
        source: "plugin",
        tools: [],
      } as ToolCatalogGroup);
    existing.tools.push({
      defaultProfiles: [],
      description: summarizeToolDescriptionText({
        displaySummary: tool.displaySummary,
        rawDescription: typeof tool.description === "string" ? tool.description : undefined,
      }),
      id: tool.name,
      label: normalizeOptionalString(tool.label) ?? tool.name,
      optional: meta?.optional,
      pluginId,
      source: "plugin",
    });
    groups.set(groupId, existing);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      tools: group.tools.toSorted((a, b) => a.id.localeCompare(b.id)),
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

export function buildToolsCatalogResult(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId?: string;
  includePlugins?: boolean;
}): ToolsCatalogResult {
  const agentId = normalizeOptionalString(params.agentId) || resolveDefaultAgentId(params.cfg);
  const includePlugins = params.includePlugins !== false;
  const groups = buildCoreGroups();
  if (includePlugins) {
    const existingToolNames = new Set(
      groups.flatMap((group) => group.tools.map((tool) => tool.id)),
    );
    groups.push(
      ...buildPluginGroups({
        agentId,
        cfg: params.cfg,
        existingToolNames,
      }),
    );
  }
  return {
    agentId,
    groups,
    profiles: PROFILE_OPTIONS.map((profile) => ({ id: profile.id, label: profile.label })),
  };
}

export const toolsCatalogHandlers: GatewayRequestHandlers = {
  "tools.catalog": ({ params, respond }) => {
    if (!validateToolsCatalogParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tools.catalog params: ${formatValidationErrors(validateToolsCatalogParams.errors)}`,
        ),
      );
      return;
    }
    const resolved = resolveAgentIdOrRespondError(params.agentId, respond);
    if (!resolved) {
      return;
    }
    respond(
      true,
      buildToolsCatalogResult({
        agentId: resolved.agentId,
        cfg: resolved.cfg,
        includePlugins: params.includePlugins,
      }),
      undefined,
    );
  },
};
