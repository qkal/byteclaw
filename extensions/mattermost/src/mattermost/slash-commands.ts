/**
 * Mattermost native slash command support.
 *
 * Registers custom slash commands via the Mattermost REST API and handles
 * incoming command callbacks via an HTTP endpoint on the gateway.
 *
 * Architecture:
 * - On startup, registers commands with MM via POST /api/v4/commands
 * - MM sends HTTP POST to callbackUrl when a user invokes a command
 * - The callback handler reconstructs the text as `/<command> <args>` and
 *   routes it through the standard inbound reply pipeline
 * - On shutdown, cleans up registered commands via DELETE /api/v4/commands/{id}
 */

import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { MattermostClient } from "./client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MattermostSlashCommandConfig {
  /** Enable native slash commands. "auto" resolves to false for now (opt-in). */
  native: boolean | "auto";
  /** Also register skill-based commands. */
  nativeSkills: boolean | "auto";
  /** Path for the callback endpoint on the gateway HTTP server. */
  callbackPath: string;
  /**
   * Explicit callback URL override (e.g. behind a reverse proxy).
   * If not set, auto-derived from baseUrl + gateway port + callbackPath.
   */
  callbackUrl?: string;
}

export interface MattermostCommandSpec {
  trigger: string;
  description: string;
  autoComplete: boolean;
  autoCompleteHint?: string;
  /** Original command name (for skill commands that start with oc_) */
  originalName?: string;
}

export interface MattermostRegisteredCommand {
  id: string;
  trigger: string;
  teamId: string;
  token: string;
  /** True when this process created the command and should delete it on shutdown. */
  managed: boolean;
}

/**
 * Payload sent by Mattermost when a slash command is invoked.
 * Can arrive as application/x-www-form-urlencoded or application/json.
 */
export interface MattermostSlashCommandPayload {
  token: string;
  team_id: string;
  team_domain?: string;
  channel_id: string;
  channel_name?: string;
  user_id: string;
  user_name?: string;
  command: string; // E.g. "/status"
  text: string; // Args after the trigger word
  trigger_id?: string;
  response_url?: string;
}

/**
 * Response format for Mattermost slash command callbacks.
 */
export interface MattermostSlashCommandResponse {
  response_type?: "ephemeral" | "in_channel";
  text: string;
  username?: string;
  icon_url?: string;
  goto_location?: string;
  attachments?: unknown[];
}

// ─── MM API types ────────────────────────────────────────────────────────────

interface MattermostCommandCreate {
  team_id: string;
  trigger: string;
  method: "P" | "G";
  url: string;
  description?: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
  token?: string;
  creator_id?: string;
}

interface MattermostCommandUpdate {
  id: string;
  team_id: string;
  trigger: string;
  method: "P" | "G";
  url: string;
  description?: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
}

interface MattermostCommandResponse {
  id: string;
  token: string;
  team_id: string;
  trigger: string;
  method: string;
  url: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
  creator_id?: string;
  create_at?: number;
  update_at?: number;
  delete_at?: number;
}

// ─── Default commands ────────────────────────────────────────────────────────

/**
 * Built-in OpenClaw commands to register as native slash commands.
 * These mirror the text-based commands already handled by the gateway.
 */
export const DEFAULT_COMMAND_SPECS: MattermostCommandSpec[] = [
  {
    autoComplete: true,
    description: "Show session status (model, usage, uptime)",
    originalName: "status",
    trigger: "oc_status",
  },
  {
    autoComplete: true,
    autoCompleteHint: "[model-name]",
    description: "View or change the current model",
    originalName: "model",
    trigger: "oc_model",
  },
  {
    autoComplete: true,
    autoCompleteHint: "[provider]",
    description: "Browse available models",
    originalName: "models",
    trigger: "oc_models",
  },
  {
    autoComplete: true,
    description: "Start a new conversation session",
    originalName: "new",
    trigger: "oc_new",
  },
  {
    autoComplete: true,
    description: "Show available commands",
    originalName: "help",
    trigger: "oc_help",
  },
  {
    autoComplete: true,
    autoCompleteHint: "[off|low|medium|high]",
    description: "Set thinking/reasoning level",
    originalName: "think",
    trigger: "oc_think",
  },
  {
    autoComplete: true,
    autoCompleteHint: "[on|off]",
    description: "Toggle reasoning mode",
    originalName: "reasoning",
    trigger: "oc_reasoning",
  },
  {
    autoComplete: true,
    autoCompleteHint: "[on|off]",
    description: "Toggle verbose mode",
    originalName: "verbose",
    trigger: "oc_verbose",
  },
];

// ─── Command registration ────────────────────────────────────────────────────

/**
 * List existing custom slash commands for a team.
 */
export async function listMattermostCommands(
  client: MattermostClient,
  teamId: string,
): Promise<MattermostCommandResponse[]> {
  return await client.request<MattermostCommandResponse[]>(
    `/commands?team_id=${encodeURIComponent(teamId)}&custom_only=true`,
  );
}

/**
 * Create a custom slash command on a Mattermost team.
 */
export async function createMattermostCommand(
  client: MattermostClient,
  params: MattermostCommandCreate,
): Promise<MattermostCommandResponse> {
  return await client.request<MattermostCommandResponse>("/commands", {
    body: JSON.stringify(params),
    method: "POST",
  });
}

/**
 * Delete a custom slash command.
 */
export async function deleteMattermostCommand(
  client: MattermostClient,
  commandId: string,
): Promise<void> {
  await client.request<Record<string, unknown>>(`/commands/${encodeURIComponent(commandId)}`, {
    method: "DELETE",
  });
}

/**
 * Update an existing custom slash command.
 */
export async function updateMattermostCommand(
  client: MattermostClient,
  params: MattermostCommandUpdate,
): Promise<MattermostCommandResponse> {
  return await client.request<MattermostCommandResponse>(
    `/commands/${encodeURIComponent(params.id)}`,
    {
      body: JSON.stringify(params),
      method: "PUT",
    },
  );
}

/**
 * Register all OpenClaw slash commands for a given team.
 * Skips commands that are already registered with the same trigger + callback URL.
 * Returns the list of newly created command IDs.
 */
export async function registerSlashCommands(params: {
  client: MattermostClient;
  teamId: string;
  creatorUserId: string;
  callbackUrl: string;
  commands: MattermostCommandSpec[];
  log?: (msg: string) => void;
}): Promise<MattermostRegisteredCommand[]> {
  const { client, teamId, creatorUserId, callbackUrl, commands, log } = params;
  const normalizedCreatorUserId = creatorUserId.trim();
  if (!normalizedCreatorUserId) {
    throw new Error("creatorUserId is required for slash command reconciliation");
  }

  // Fetch existing commands to avoid duplicates
  let existing: MattermostCommandResponse[] = [];
  try {
    existing = await listMattermostCommands(client, teamId);
  } catch (error) {
    log?.(`mattermost: failed to list existing commands: ${String(error)}`);
    // Fail closed: if we can't list existing commands, we should not attempt to
    // Create/update anything because we may create duplicates and end up with an
    // Empty/partial token set (causing callbacks to be rejected until restart).
    throw error;
  }

  const existingByTrigger = new Map<string, MattermostCommandResponse[]>();
  for (const cmd of existing) {
    const list = existingByTrigger.get(cmd.trigger) ?? [];
    list.push(cmd);
    existingByTrigger.set(cmd.trigger, list);
  }

  const registered: MattermostRegisteredCommand[] = [];

  for (const spec of commands) {
    const existingForTrigger = existingByTrigger.get(spec.trigger) ?? [];
    const ownedCommands = existingForTrigger.filter(
      (cmd) => cmd.creator_id?.trim() === normalizedCreatorUserId,
    );
    const foreignCommands = existingForTrigger.filter(
      (cmd) => cmd.creator_id?.trim() !== normalizedCreatorUserId,
    );

    if (ownedCommands.length === 0 && foreignCommands.length > 0) {
      log?.(
        `mattermost: trigger /${spec.trigger} already used by non-OpenClaw command(s); skipping to avoid mutating external integrations`,
      );
      continue;
    }

    if (ownedCommands.length > 1) {
      log?.(
        `mattermost: multiple owned commands found for /${spec.trigger}; using the first and leaving extras untouched`,
      );
    }

    const existingCmd = ownedCommands[0];

    // Already registered with the correct callback URL
    if (existingCmd && existingCmd.url === callbackUrl) {
      log?.(`mattermost: command /${spec.trigger} already registered (id=${existingCmd.id})`);
      registered.push({
        id: existingCmd.id,
        managed: false,
        teamId,
        token: existingCmd.token,
        trigger: spec.trigger,
      });
      continue;
    }

    // Exists but points to a different URL: attempt to reconcile by updating
    // (useful during callback URL migrations).
    if (existingCmd && existingCmd.url !== callbackUrl) {
      log?.(
        `mattermost: command /${spec.trigger} exists with different callback URL; updating (id=${existingCmd.id})`,
      );
      try {
        const updated = await updateMattermostCommand(client, {
          auto_complete: spec.autoComplete,
          auto_complete_desc: spec.description,
          auto_complete_hint: spec.autoCompleteHint,
          description: spec.description,
          id: existingCmd.id,
          method: "P",
          team_id: teamId,
          trigger: spec.trigger,
          url: callbackUrl,
        });
        registered.push({
          id: updated.id,
          managed: false,
          teamId,
          token: updated.token,
          trigger: spec.trigger,
        });
        continue;
      } catch (error) {
        log?.(
          `mattermost: failed to update command /${spec.trigger} (id=${existingCmd.id}): ${String(error)}`,
        );
        // Fallback: try delete+recreate for commands owned by this bot user.
        try {
          await deleteMattermostCommand(client, existingCmd.id);
          log?.(`mattermost: deleted stale command /${spec.trigger} (id=${existingCmd.id})`);
        } catch (error) {
          log?.(
            `mattermost: failed to delete stale command /${spec.trigger} (id=${existingCmd.id}): ${String(error)}`,
          );
          // Can't reconcile; skip this command.
          continue;
        }
        // Continue on to create below.
      }
    }

    try {
      const created = await createMattermostCommand(client, {
        auto_complete: spec.autoComplete,
        auto_complete_desc: spec.description,
        auto_complete_hint: spec.autoCompleteHint,
        description: spec.description,
        method: "P",
        team_id: teamId,
        trigger: spec.trigger,
        url: callbackUrl,
      });
      log?.(`mattermost: registered command /${spec.trigger} (id=${created.id})`);
      registered.push({
        id: created.id,
        managed: true,
        teamId,
        token: created.token,
        trigger: spec.trigger,
      });
    } catch (error) {
      log?.(`mattermost: failed to register command /${spec.trigger}: ${String(error)}`);
    }
  }

  return registered;
}

/**
 * Clean up all registered slash commands.
 */
export async function cleanupSlashCommands(params: {
  client: MattermostClient;
  commands: MattermostRegisteredCommand[];
  log?: (msg: string) => void;
}): Promise<void> {
  const { client, commands, log } = params;
  for (const cmd of commands) {
    if (!cmd.managed) {
      continue;
    }
    try {
      await deleteMattermostCommand(client, cmd.id);
      log?.(`mattermost: deleted command /${cmd.trigger} (id=${cmd.id})`);
    } catch (error) {
      log?.(`mattermost: failed to delete command /${cmd.trigger}: ${String(error)}`);
    }
  }
}

// ─── Callback parsing ────────────────────────────────────────────────────────

/**
 * Parse a Mattermost slash command callback payload from a URL-encoded or JSON body.
 */
export function parseSlashCommandPayload(
  body: string,
  contentType?: string,
): MattermostSlashCommandPayload | null {
  if (!body) {
    return null;
  }

  try {
    if (contentType?.includes("application/json")) {
      const parsed = JSON.parse(body) as Record<string, unknown>;

      // Validate required fields (same checks as the form-encoded branch)
      const token = typeof parsed.token === "string" ? parsed.token : "";
      const teamId = typeof parsed.team_id === "string" ? parsed.team_id : "";
      const channelId = typeof parsed.channel_id === "string" ? parsed.channel_id : "";
      const userId = typeof parsed.user_id === "string" ? parsed.user_id : "";
      const command = typeof parsed.command === "string" ? parsed.command : "";

      if (!token || !teamId || !channelId || !userId || !command) {
        return null;
      }

      return {
        channel_id: channelId,
        channel_name: typeof parsed.channel_name === "string" ? parsed.channel_name : undefined,
        command,
        response_url: typeof parsed.response_url === "string" ? parsed.response_url : undefined,
        team_domain: typeof parsed.team_domain === "string" ? parsed.team_domain : undefined,
        team_id: teamId,
        text: typeof parsed.text === "string" ? parsed.text : "",
        token,
        trigger_id: typeof parsed.trigger_id === "string" ? parsed.trigger_id : undefined,
        user_id: userId,
        user_name: typeof parsed.user_name === "string" ? parsed.user_name : undefined,
      };
    }

    // Default: application/x-www-form-urlencoded
    const params = new URLSearchParams(body);
    const token = params.get("token");
    const teamId = params.get("team_id");
    const channelId = params.get("channel_id");
    const userId = params.get("user_id");
    const command = params.get("command");

    if (!token || !teamId || !channelId || !userId || !command) {
      return null;
    }

    return {
      channel_id: channelId,
      channel_name: params.get("channel_name") ?? undefined,
      command,
      response_url: params.get("response_url") ?? undefined,
      team_domain: params.get("team_domain") ?? undefined,
      team_id: teamId,
      text: params.get("text") ?? "",
      token,
      trigger_id: params.get("trigger_id") ?? undefined,
      user_id: userId,
      user_name: params.get("user_name") ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Map the trigger word back to the original OpenClaw command name.
 * e.g. "oc_status" -> "/status", "oc_model" -> "/model"
 */
export function resolveCommandText(
  trigger: string,
  text: string,
  triggerMap?: ReadonlyMap<string, string>,
): string {
  // Use the trigger map if available for accurate name resolution
  const commandName =
    triggerMap?.get(trigger) ?? (trigger.startsWith("oc_") ? trigger.slice(3) : trigger);
  const args = text.trim();
  return args ? `/${commandName} ${args}` : `/${commandName}`;
}

// ─── Config resolution ───────────────────────────────────────────────────────

const DEFAULT_CALLBACK_PATH = "/api/channels/mattermost/command";

/**
 * Ensure the callback path starts with a leading `/` to prevent
 * malformed URLs like `http://host:portapi/...`.
 */
function normalizeCallbackPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return DEFAULT_CALLBACK_PATH;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function resolveSlashCommandConfig(
  raw?: Partial<MattermostSlashCommandConfig>,
): MattermostSlashCommandConfig {
  return {
    callbackPath: normalizeCallbackPath(raw?.callbackPath ?? DEFAULT_CALLBACK_PATH),
    callbackUrl: normalizeOptionalString(raw?.callbackUrl),
    native: raw?.native ?? "auto",
    nativeSkills: raw?.nativeSkills ?? "auto",
  };
}

export function isSlashCommandsEnabled(config: MattermostSlashCommandConfig): boolean {
  if (config.native === true) {
    return true;
  }
  if (config.native === false) {
    return false;
  }
  // "auto" defaults to false for mattermost (opt-in)
  return false;
}

export function collectMattermostSlashCallbackPaths(raw?: Partial<MattermostSlashCommandConfig>) {
  const config = resolveSlashCommandConfig(raw);
  const paths = new Set<string>([config.callbackPath]);
  if (typeof config.callbackUrl === "string" && config.callbackUrl.trim()) {
    try {
      const {pathname} = new URL(config.callbackUrl);
      if (pathname) {
        paths.add(pathname);
      }
    } catch {
      // Ignore invalid callback URLs and keep the normalized callback path only.
    }
  }
  return [...paths];
}

/**
 * Build the callback URL that Mattermost will POST to when a command is invoked.
 */
export function resolveCallbackUrl(params: {
  config: MattermostSlashCommandConfig;
  gatewayPort: number;
  gatewayHost?: string;
}): string {
  if (params.config.callbackUrl) {
    return params.config.callbackUrl;
  }

  const isWildcardBindHost = (rawHost: string): boolean => {
    const trimmed = rawHost.trim();
    if (!trimmed) {
      return false;
    }
    const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;

    // NOTE: Wildcard listen hosts are valid bind addresses but are not routable callback
    // Destinations. Don't emit callback URLs like http://0.0.0.0:3015/... or http://[::]:3015/...
    // When an operator sets gateway.customBindHost.
    return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "::0";
  };

  let host =
    params.gatewayHost && !isWildcardBindHost(params.gatewayHost)
      ? params.gatewayHost
      : "localhost";
  const path = normalizeCallbackPath(params.config.callbackPath);

  // Bracket IPv6 literals so the URL is valid: http://[::1]:3015/...
  if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) {
    host = `[${host}]`;
  }

  return `http://${host}:${params.gatewayPort}${path}`;
}
