import type { OpenClawConfig } from "../../config/config.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../glob-pattern.js";
import { expandToolGroups, normalizeToolName } from "../tool-policy.js";
import { DEFAULT_TOOL_ALLOW, DEFAULT_TOOL_DENY } from "./constants.js";
import type {
  SandboxToolPolicy,
  SandboxToolPolicyResolved,
  SandboxToolPolicySource,
} from "./types.js";

interface SandboxToolPolicyConfig {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
}

function buildSource(params: {
  scope: "agent" | "global" | "default";
  key: string;
}): SandboxToolPolicySource {
  return {
    key: params.key,
    source: params.scope,
  } satisfies SandboxToolPolicySource;
}

function pickConfiguredList(params: { agent?: string[]; global?: string[] }): {
  values?: string[];
  source: SandboxToolPolicySource;
} {
  if (Array.isArray(params.agent)) {
    return {
      source: buildSource({ key: "agents.list[].tools.sandbox.tools.allow", scope: "agent" }),
      values: params.agent,
    };
  }
  if (Array.isArray(params.global)) {
    return {
      source: buildSource({ key: "tools.sandbox.tools.allow", scope: "global" }),
      values: params.global,
    };
  }
  return {
    source: buildSource({ key: "tools.sandbox.tools.allow", scope: "default" }),
    values: undefined,
  };
}

function pickConfiguredDeny(params: { agent?: string[]; global?: string[] }): {
  values?: string[];
  source: SandboxToolPolicySource;
} {
  if (Array.isArray(params.agent)) {
    return {
      source: buildSource({ key: "agents.list[].tools.sandbox.tools.deny", scope: "agent" }),
      values: params.agent,
    };
  }
  if (Array.isArray(params.global)) {
    return {
      source: buildSource({ key: "tools.sandbox.tools.deny", scope: "global" }),
      values: params.global,
    };
  }
  return {
    source: buildSource({ key: "tools.sandbox.tools.deny", scope: "default" }),
    values: undefined,
  };
}

function pickConfiguredAlsoAllow(params: { agent?: string[]; global?: string[] }): {
  values?: string[];
  source?: SandboxToolPolicySource;
} {
  if (Array.isArray(params.agent)) {
    return {
      source: buildSource({
        key: "agents.list[].tools.sandbox.tools.alsoAllow",
        scope: "agent",
      }),
      values: params.agent,
    };
  }
  if (Array.isArray(params.global)) {
    return {
      source: buildSource({ key: "tools.sandbox.tools.alsoAllow", scope: "global" }),
      values: params.global,
    };
  }
  return { source: undefined, values: undefined };
}

function mergeAllowlist(base: string[] | undefined, extra: string[] | undefined): string[] {
  if (Array.isArray(base)) {
    // Preserve the existing sandbox meaning of `allow: []` => allow all.
    if (base.length === 0) {
      return [];
    }
    if (!Array.isArray(extra) || extra.length === 0) {
      return [...base];
    }
    return [...new Set([...base, ...extra])];
  }
  if (Array.isArray(extra) && extra.length > 0) {
    return [...new Set([...DEFAULT_TOOL_ALLOW, ...extra])];
  }
  return [...DEFAULT_TOOL_ALLOW];
}

function pickAllowSource(params: {
  allow: SandboxToolPolicySource;
  allowDefined: boolean;
  alsoAllow?: SandboxToolPolicySource;
}): SandboxToolPolicySource {
  if (params.allowDefined && params.allow.source === "agent") {
    return params.allow;
  }
  if (params.alsoAllow?.source === "agent") {
    return params.alsoAllow;
  }
  if (params.allowDefined && params.allow.source === "global") {
    return params.allow;
  }
  if (params.alsoAllow?.source === "global") {
    return params.alsoAllow;
  }
  return params.allow;
}

function resolveExplicitSandboxReAllowPatterns(params: {
  allow?: string[];
  alsoAllow?: string[];
}): string[] {
  return [...new Set([...params.allow ?? [], ...params.alsoAllow ?? []])];
}

function filterDefaultDenyForExplicitAllows(params: {
  deny: string[];
  explicitAllowPatterns: string[];
}): string[] {
  if (params.explicitAllowPatterns.length === 0) {
    return [...params.deny];
  }
  const allowPatterns = compileGlobPatterns({
    normalize: normalizeToolName,
    raw: expandToolGroups(params.explicitAllowPatterns),
  });
  if (allowPatterns.length === 0) {
    return [...params.deny];
  }
  return params.deny.filter(
    (toolName) => !matchesAnyGlobPattern(normalizeToolName(toolName), allowPatterns),
  );
}

function expandResolvedPolicy(policy: SandboxToolPolicy): SandboxToolPolicy {
  const expandedDeny = expandToolGroups(policy.deny ?? []);
  let expandedAllow = expandToolGroups(policy.allow ?? []);
  const expandedDenyLower = expandedDeny.map(normalizeLowercaseStringOrEmpty);
  const expandedAllowLower = expandedAllow.map(normalizeLowercaseStringOrEmpty);

  // `image` is essential for multimodal workflows; keep the existing sandbox
  // Behavior that auto-includes it for explicit allowlists unless it is denied.
  if (
    expandedAllow.length > 0 &&
    !expandedDenyLower.includes("image") &&
    !expandedAllowLower.includes("image")
  ) {
    expandedAllow = [...expandedAllow, "image"];
  }

  return {
    allow: expandedAllow,
    deny: expandedDeny,
  };
}

export function classifyToolAgainstSandboxToolPolicy(name: string, policy?: SandboxToolPolicy) {
  if (!policy) {
    return {
      blockedByAllow: false,
      blockedByDeny: false,
    };
  }

  const normalized = normalizeToolName(name);
  const deny = compileGlobPatterns({
    normalize: normalizeToolName,
    raw: expandToolGroups(policy.deny ?? []),
  });
  const blockedByDeny = matchesAnyGlobPattern(normalized, deny);
  const allow = compileGlobPatterns({
    normalize: normalizeToolName,
    raw: expandToolGroups(policy.allow ?? []),
  });
  const blockedByAllow =
    !blockedByDeny && allow.length > 0 && !matchesAnyGlobPattern(normalized, allow);
  return {
    blockedByAllow,
    blockedByDeny,
  };
}

export function isToolAllowed(policy: SandboxToolPolicy, name: string) {
  const { blockedByDeny, blockedByAllow } = classifyToolAgainstSandboxToolPolicy(name, policy);
  return !blockedByDeny && !blockedByAllow;
}

export function resolveSandboxToolPolicyForAgent(
  cfg?: OpenClawConfig,
  agentId?: string,
): SandboxToolPolicyResolved {
  const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  const agentPolicy = agentConfig?.tools?.sandbox?.tools as SandboxToolPolicyConfig | undefined;
  const globalPolicy = cfg?.tools?.sandbox?.tools as SandboxToolPolicyConfig | undefined;

  const allowConfig = pickConfiguredList({
    agent: agentPolicy?.allow,
    global: globalPolicy?.allow,
  });
  const alsoAllowConfig = pickConfiguredAlsoAllow({
    agent: agentPolicy?.alsoAllow,
    global: globalPolicy?.alsoAllow,
  });
  const denyConfig = pickConfiguredDeny({
    agent: agentPolicy?.deny,
    global: globalPolicy?.deny,
  });

  const explicitAllowPatterns = resolveExplicitSandboxReAllowPatterns({
    allow: allowConfig.values,
    alsoAllow: alsoAllowConfig.values,
  });

  const resolvedAllow = mergeAllowlist(allowConfig.values, alsoAllowConfig.values);
  const resolvedDeny = Array.isArray(denyConfig.values)
    ? [...denyConfig.values]
    : filterDefaultDenyForExplicitAllows({
        deny: [...DEFAULT_TOOL_DENY],
        explicitAllowPatterns,
      });

  const expanded = expandResolvedPolicy({
    allow: resolvedAllow,
    deny: resolvedDeny,
  });

  return {
    allow: expanded.allow ?? [],
    deny: expanded.deny ?? [],
    sources: {
      allow: pickAllowSource({
        allow: allowConfig.source,
        allowDefined: Array.isArray(allowConfig.values),
        alsoAllow: alsoAllowConfig.source,
      }),
      deny: denyConfig.source,
    },
  };
}
