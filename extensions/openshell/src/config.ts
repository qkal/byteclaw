import path from "node:path";
import { type OpenClawPluginConfigSchema, buildPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { z } from "openclaw/plugin-sdk/zod";

export interface OpenShellPluginConfig {
  mode?: "mirror" | "remote";
  command?: string;
  gateway?: string;
  gatewayEndpoint?: string;
  from?: string;
  policy?: string;
  providers?: string[];
  gpu?: boolean;
  autoProviders?: boolean;
  remoteWorkspaceDir?: string;
  remoteAgentWorkspaceDir?: string;
  timeoutSeconds?: number;
}

export interface ResolvedOpenShellPluginConfig {
  mode: "mirror" | "remote";
  command: string;
  gateway?: string;
  gatewayEndpoint?: string;
  from: string;
  policy?: string;
  providers: string[];
  gpu: boolean;
  autoProviders: boolean;
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  timeoutMs: number;
}

const DEFAULT_COMMAND = "openshell";
const DEFAULT_MODE = "mirror";
const DEFAULT_SOURCE = "openclaw";
const DEFAULT_REMOTE_WORKSPACE_DIR = "/sandbox";
const DEFAULT_REMOTE_AGENT_WORKSPACE_DIR = "/agent";
const DEFAULT_TIMEOUT_MS = 120_000;
const OPEN_SHELL_MANAGED_REMOTE_ROOTS = [
  DEFAULT_REMOTE_WORKSPACE_DIR,
  DEFAULT_REMOTE_AGENT_WORKSPACE_DIR,
] as const;

function normalizeProviders(value: string[] | undefined): string[] {
  const seen = new Set<string>();
  const providers: string[] = [];
  for (const entry of value ?? []) {
    const normalized = entry.trim();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    providers.push(normalized);
  }
  return providers;
}

const nonEmptyTrimmedString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const OpenShellPluginConfigSchema = z.strictObject({
  autoProviders: z.boolean({ error: "autoProviders must be a boolean" }).optional(),
  command: nonEmptyTrimmedString("command must be a non-empty string").optional(),
  from: nonEmptyTrimmedString("from must be a non-empty string").optional(),
  gateway: nonEmptyTrimmedString("gateway must be a non-empty string").optional(),
  gatewayEndpoint: nonEmptyTrimmedString("gatewayEndpoint must be a non-empty string").optional(),
  gpu: z.boolean({ error: "gpu must be a boolean" }).optional(),
  mode: z.enum(["mirror", "remote"], { error: "mode must be one of mirror, remote" }).optional(),
  policy: nonEmptyTrimmedString("policy must be a non-empty string").optional(),
  providers: z
    .array(
      z.string({ error: "providers must be an array of strings" }).trim().min(1, {
        error: "providers must be an array of strings",
      }),
      {
        error: "providers must be an array of strings",
      },
    )
    .optional(),
  remoteAgentWorkspaceDir: nonEmptyTrimmedString(
    "remoteAgentWorkspaceDir must be a non-empty string",
  ).optional(),
  remoteWorkspaceDir: nonEmptyTrimmedString(
    "remoteWorkspaceDir must be a non-empty string",
  ).optional(),
  timeoutSeconds: z
    .number({ error: "timeoutSeconds must be a number >= 1" })
    .min(1, { error: "timeoutSeconds must be a number >= 1" })
    .optional(),
});

function formatOpenShellConfigIssue(issue: z.ZodIssue | undefined): string {
  if (!issue) {
    return "invalid config";
  }
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
    return `unknown config key: ${issue.keys[0]}`;
  }
  if (issue.code === "invalid_type" && issue.path.length === 0) {
    return "expected config object";
  }
  return issue.message;
}

function isManagedOpenShellRemotePath(value: string): boolean {
  return OPEN_SHELL_MANAGED_REMOTE_ROOTS.some(
    (root) => value === root || value.startsWith(`${root}/`),
  );
}

export function normalizeOpenShellRemotePath(
  value: string | undefined,
  fallback: string,
  fieldName = "remote path",
): string {
  const candidate = value ?? fallback;
  const normalized = path.posix.normalize(candidate.trim() || fallback);
  if (!normalized.startsWith("/")) {
    throw new Error(`OpenShell ${fieldName} must be absolute: ${candidate}`);
  }
  if (!isManagedOpenShellRemotePath(normalized)) {
    throw new Error(
      `OpenShell ${fieldName} must stay under ${OPEN_SHELL_MANAGED_REMOTE_ROOTS.join(" or ")}: ${candidate}`,
    );
  }
  return normalized;
}

export function createOpenShellPluginConfigSchema(): OpenClawPluginConfigSchema {
  return buildPluginConfigSchema(OpenShellPluginConfigSchema, {
    safeParse(value) {
      if (value === undefined) {
        return { data: undefined, success: true };
      }
      const parsed = OpenShellPluginConfigSchema.safeParse(value);
      if (parsed.success) {
        return { data: parsed.data, success: true };
      }
      return {
        error: {
          issues: parsed.error.issues.map((issue) => ({
            message: formatOpenShellConfigIssue(issue),
            path: issue.path.filter((segment): segment is string | number => {
              const kind = typeof segment;
              return kind === "string" || kind === "number";
            }),
          })),
        },
        success: false,
      };
    },
  });
}

export function resolveOpenShellPluginConfig(value: unknown): ResolvedOpenShellPluginConfig {
  if (value === undefined) {
    // The built-in defaults are managed OpenShell roots, so they do not need to
    // Flow back through normalizeOpenShellRemotePath.
    return {
      autoProviders: true,
      command: DEFAULT_COMMAND,
      from: DEFAULT_SOURCE,
      gateway: undefined,
      gatewayEndpoint: undefined,
      gpu: false,
      mode: DEFAULT_MODE,
      policy: undefined,
      providers: [],
      remoteAgentWorkspaceDir: DEFAULT_REMOTE_AGENT_WORKSPACE_DIR,
      remoteWorkspaceDir: DEFAULT_REMOTE_WORKSPACE_DIR,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  const parsed = OpenShellPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    const message = formatOpenShellConfigIssue(parsed.error.issues[0]);
    throw new Error(`Invalid openshell plugin config: ${message}`);
  }
  const cfg = parsed.data as OpenShellPluginConfig;
  const mode = cfg.mode ?? DEFAULT_MODE;
  return {
    autoProviders: cfg.autoProviders ?? true,
    command: cfg.command ?? DEFAULT_COMMAND,
    from: cfg.from ?? DEFAULT_SOURCE,
    gateway: cfg.gateway,
    gatewayEndpoint: cfg.gatewayEndpoint,
    gpu: cfg.gpu ?? false,
    mode,
    policy: cfg.policy,
    providers: normalizeProviders(cfg.providers),
    remoteAgentWorkspaceDir: normalizeOpenShellRemotePath(
      cfg.remoteAgentWorkspaceDir,
      DEFAULT_REMOTE_AGENT_WORKSPACE_DIR,
      "remoteAgentWorkspaceDir",
    ),
    remoteWorkspaceDir: normalizeOpenShellRemotePath(
      cfg.remoteWorkspaceDir,
      DEFAULT_REMOTE_WORKSPACE_DIR,
      "remoteWorkspaceDir",
    ),
    timeoutMs:
      typeof cfg.timeoutSeconds === "number"
        ? Math.floor(cfg.timeoutSeconds * 1000)
        : DEFAULT_TIMEOUT_MS,
  };
}
