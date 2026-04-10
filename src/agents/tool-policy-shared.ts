import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  CORE_TOOL_GROUPS,
  type ToolProfileId,
  resolveCoreToolProfilePolicy,
} from "./tool-catalog.js";

interface ToolProfilePolicy {
  allow?: string[];
  deny?: string[];
}

const TOOL_NAME_ALIASES: Record<string, string> = {
  "apply-patch": "apply_patch",
  bash: "exec",
};

export const TOOL_GROUPS: Record<string, string[]> = { ...CORE_TOOL_GROUPS };

export function normalizeToolName(name: string) {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  return TOOL_NAME_ALIASES[normalized] ?? normalized;
}

export function normalizeToolList(list?: string[]) {
  if (!list) {
    return [];
  }
  return list.map(normalizeToolName).filter(Boolean);
}

export function expandToolGroups(list?: string[]) {
  const normalized = normalizeToolList(list);
  const expanded: string[] = [];
  for (const value of normalized) {
    const group = TOOL_GROUPS[value];
    if (group) {
      expanded.push(...group);
      continue;
    }
    expanded.push(value);
  }
  return [...new Set(expanded)];
}

export function resolveToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  return resolveCoreToolProfilePolicy(profile);
}

export type { ToolProfileId };
