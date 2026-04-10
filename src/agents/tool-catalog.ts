import {
  CRON_TOOL_DISPLAY_SUMMARY,
  EXEC_TOOL_DISPLAY_SUMMARY,
  PROCESS_TOOL_DISPLAY_SUMMARY,
  SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
  SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
  SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
  UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
} from "./tool-description-presets.js";

export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

interface ToolProfilePolicy {
  allow?: string[];
  deny?: string[];
}

export interface CoreToolSection {
  id: string;
  label: string;
  tools: {
    id: string;
    label: string;
    description: string;
  }[];
}

interface CoreToolDefinition {
  id: string;
  label: string;
  description: string;
  sectionId: string;
  profiles: ToolProfileId[];
  includeInOpenClawGroup?: boolean;
}

const CORE_TOOL_SECTION_ORDER: { id: string; label: string }[] = [
  { id: "fs", label: "Files" },
  { id: "runtime", label: "Runtime" },
  { id: "web", label: "Web" },
  { id: "memory", label: "Memory" },
  { id: "sessions", label: "Sessions" },
  { id: "ui", label: "UI" },
  { id: "messaging", label: "Messaging" },
  { id: "automation", label: "Automation" },
  { id: "nodes", label: "Nodes" },
  { id: "agents", label: "Agents" },
  { id: "media", label: "Media" },
];

const CORE_TOOL_DEFINITIONS: CoreToolDefinition[] = [
  {
    description: "Read file contents",
    id: "read",
    label: "read",
    profiles: ["coding"],
    sectionId: "fs",
  },
  {
    description: "Create or overwrite files",
    id: "write",
    label: "write",
    profiles: ["coding"],
    sectionId: "fs",
  },
  {
    description: "Make precise edits",
    id: "edit",
    label: "edit",
    profiles: ["coding"],
    sectionId: "fs",
  },
  {
    description: "Patch files",
    id: "apply_patch",
    label: "apply_patch",
    profiles: ["coding"],
    sectionId: "fs",
  },
  {
    description: EXEC_TOOL_DISPLAY_SUMMARY,
    id: "exec",
    label: "exec",
    profiles: ["coding"],
    sectionId: "runtime",
  },
  {
    description: PROCESS_TOOL_DISPLAY_SUMMARY,
    id: "process",
    label: "process",
    profiles: ["coding"],
    sectionId: "runtime",
  },
  {
    description: "Run sandboxed remote analysis",
    id: "code_execution",
    includeInOpenClawGroup: true,
    label: "code_execution",
    profiles: ["coding"],
    sectionId: "runtime",
  },
  {
    description: "Search the web",
    id: "web_search",
    includeInOpenClawGroup: true,
    label: "web_search",
    profiles: ["coding"],
    sectionId: "web",
  },
  {
    description: "Fetch web content",
    id: "web_fetch",
    includeInOpenClawGroup: true,
    label: "web_fetch",
    profiles: ["coding"],
    sectionId: "web",
  },
  {
    description: "Search X posts",
    id: "x_search",
    includeInOpenClawGroup: true,
    label: "x_search",
    profiles: ["coding"],
    sectionId: "web",
  },
  {
    description: "Semantic search",
    id: "memory_search",
    includeInOpenClawGroup: true,
    label: "memory_search",
    profiles: ["coding"],
    sectionId: "memory",
  },
  {
    description: "Read memory files",
    id: "memory_get",
    includeInOpenClawGroup: true,
    label: "memory_get",
    profiles: ["coding"],
    sectionId: "memory",
  },
  {
    description: SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
    id: "sessions_list",
    includeInOpenClawGroup: true,
    label: "sessions_list",
    profiles: ["coding", "messaging"],
    sectionId: "sessions",
  },
  {
    description: SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
    id: "sessions_history",
    includeInOpenClawGroup: true,
    label: "sessions_history",
    profiles: ["coding", "messaging"],
    sectionId: "sessions",
  },
  {
    description: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    id: "sessions_send",
    includeInOpenClawGroup: true,
    label: "sessions_send",
    profiles: ["coding", "messaging"],
    sectionId: "sessions",
  },
  {
    description: SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
    id: "sessions_spawn",
    includeInOpenClawGroup: true,
    label: "sessions_spawn",
    profiles: ["coding"],
    sectionId: "sessions",
  },
  {
    description: "End turn to receive sub-agent results",
    id: "sessions_yield",
    includeInOpenClawGroup: true,
    label: "sessions_yield",
    profiles: ["coding"],
    sectionId: "sessions",
  },
  {
    description: "Manage sub-agents",
    id: "subagents",
    includeInOpenClawGroup: true,
    label: "subagents",
    profiles: ["coding"],
    sectionId: "sessions",
  },
  {
    description: SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
    id: "session_status",
    includeInOpenClawGroup: true,
    label: "session_status",
    profiles: ["minimal", "coding", "messaging"],
    sectionId: "sessions",
  },
  {
    description: "Control web browser",
    id: "browser",
    includeInOpenClawGroup: true,
    label: "browser",
    profiles: [],
    sectionId: "ui",
  },
  {
    description: "Control canvases",
    id: "canvas",
    includeInOpenClawGroup: true,
    label: "canvas",
    profiles: [],
    sectionId: "ui",
  },
  {
    description: "Send messages",
    id: "message",
    includeInOpenClawGroup: true,
    label: "message",
    profiles: ["messaging"],
    sectionId: "messaging",
  },
  {
    description: CRON_TOOL_DISPLAY_SUMMARY,
    id: "cron",
    includeInOpenClawGroup: true,
    label: "cron",
    profiles: ["coding"],
    sectionId: "automation",
  },
  {
    description: "Gateway control",
    id: "gateway",
    includeInOpenClawGroup: true,
    label: "gateway",
    profiles: [],
    sectionId: "automation",
  },
  {
    description: "Nodes + devices",
    id: "nodes",
    includeInOpenClawGroup: true,
    label: "nodes",
    profiles: [],
    sectionId: "nodes",
  },
  {
    description: "List agents",
    id: "agents_list",
    includeInOpenClawGroup: true,
    label: "agents_list",
    profiles: [],
    sectionId: "agents",
  },
  {
    description: UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
    id: "update_plan",
    includeInOpenClawGroup: true,
    label: "update_plan",
    profiles: ["coding"],
    sectionId: "agents",
  },
  {
    description: "Image understanding",
    id: "image",
    includeInOpenClawGroup: true,
    label: "image",
    profiles: ["coding"],
    sectionId: "media",
  },
  {
    description: "Image generation",
    id: "image_generate",
    includeInOpenClawGroup: true,
    label: "image_generate",
    profiles: ["coding"],
    sectionId: "media",
  },
  {
    description: "Music generation",
    id: "music_generate",
    includeInOpenClawGroup: true,
    label: "music_generate",
    profiles: ["coding"],
    sectionId: "media",
  },
  {
    description: "Video generation",
    id: "video_generate",
    includeInOpenClawGroup: true,
    label: "video_generate",
    profiles: ["coding"],
    sectionId: "media",
  },
  {
    description: "Text-to-speech conversion",
    id: "tts",
    includeInOpenClawGroup: true,
    label: "tts",
    profiles: [],
    sectionId: "media",
  },
];

const CORE_TOOL_BY_ID = new Map<string, CoreToolDefinition>(
  CORE_TOOL_DEFINITIONS.map((tool) => [tool.id, tool]),
);

function listCoreToolIdsForProfile(profile: ToolProfileId): string[] {
  return CORE_TOOL_DEFINITIONS.filter((tool) => tool.profiles.includes(profile)).map(
    (tool) => tool.id,
  );
}

const CORE_TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  coding: {
    allow: listCoreToolIdsForProfile("coding"),
  },
  full: {},
  messaging: {
    allow: listCoreToolIdsForProfile("messaging"),
  },
  minimal: {
    allow: listCoreToolIdsForProfile("minimal"),
  },
};

function buildCoreToolGroupMap() {
  const sectionToolMap = new Map<string, string[]>();
  for (const tool of CORE_TOOL_DEFINITIONS) {
    const groupId = `group:${tool.sectionId}`;
    const list = sectionToolMap.get(groupId) ?? [];
    list.push(tool.id);
    sectionToolMap.set(groupId, list);
  }
  const openclawTools = CORE_TOOL_DEFINITIONS.filter((tool) => tool.includeInOpenClawGroup).map(
    (tool) => tool.id,
  );
  return {
    "group:openclaw": openclawTools,
    ...Object.fromEntries(sectionToolMap.entries()),
  };
}

export const CORE_TOOL_GROUPS = buildCoreToolGroupMap();

export const PROFILE_OPTIONS = [
  { id: "minimal", label: "Minimal" },
  { id: "coding", label: "Coding" },
  { id: "messaging", label: "Messaging" },
  { id: "full", label: "Full" },
] as const;

export function resolveCoreToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  if (!profile) {
    return undefined;
  }
  const resolved = CORE_TOOL_PROFILES[profile as ToolProfileId];
  if (!resolved) {
    return undefined;
  }
  if (!resolved.allow && !resolved.deny) {
    return undefined;
  }
  return {
    allow: resolved.allow ? [...resolved.allow] : undefined,
    deny: resolved.deny ? [...resolved.deny] : undefined,
  };
}

export function listCoreToolSections(): CoreToolSection[] {
  return CORE_TOOL_SECTION_ORDER.map((section) => ({
    id: section.id,
    label: section.label,
    tools: CORE_TOOL_DEFINITIONS.filter((tool) => tool.sectionId === section.id).map((tool) => ({
      description: tool.description,
      id: tool.id,
      label: tool.label,
    })),
  })).filter((section) => section.tools.length > 0);
}

export function resolveCoreToolProfiles(toolId: string): ToolProfileId[] {
  const tool = CORE_TOOL_BY_ID.get(toolId);
  if (!tool) {
    return [];
  }
  return [...tool.profiles];
}

export function isKnownCoreToolId(toolId: string): boolean {
  return CORE_TOOL_BY_ID.has(toolId);
}
