import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import {
  type ThreadBindingTargetKind,
  autoBindSpawnedDiscordSubagent,
  listThreadBindingsBySessionKey,
  unbindThreadBindingsBySessionKey,
} from "./monitor/thread-bindings.js";

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

interface DiscordSubagentSpawningEvent {
  threadRequested?: boolean;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  agentId: string;
  label?: string;
}

interface DiscordSubagentEndedEvent {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
  reason?: string;
  sendFarewell?: boolean;
}

interface DiscordSubagentDeliveryTargetEvent {
  expectsCompletionMessage?: boolean;
  childSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    threadId?: string | number;
  };
}

function normalizeThreadBindingTargetKind(raw?: string): ThreadBindingTargetKind | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "subagent" || normalized === "acp") {
    return normalized;
  }
  return undefined;
}

function resolveThreadBindingFlags(api: OpenClawPluginApi, accountId?: string) {
  const account = resolveDiscordAccount({
    accountId,
    cfg: api.config,
  });
  const baseThreadBindings = api.config.channels?.discord?.threadBindings;
  const accountThreadBindings =
    api.config.channels?.discord?.accounts?.[account.accountId]?.threadBindings;
  return {
    enabled:
      accountThreadBindings?.enabled ??
      baseThreadBindings?.enabled ??
      api.config.session?.threadBindings?.enabled ??
      true,
    spawnSubagentSessions:
      accountThreadBindings?.spawnSubagentSessions ??
      baseThreadBindings?.spawnSubagentSessions ??
      false,
  };
}

export async function handleDiscordSubagentSpawning(
  api: OpenClawPluginApi,
  event: DiscordSubagentSpawningEvent,
) {
  if (!event.threadRequested) {
    return;
  }
  const channel = normalizeOptionalLowercaseString(event.requester?.channel);
  if (channel !== "discord") {
    return;
  }
  const threadBindingFlags = resolveThreadBindingFlags(api, event.requester?.accountId);
  if (!threadBindingFlags.enabled) {
    return {
      error:
        "Discord thread bindings are disabled (set channels.discord.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).",
      status: "error" as const,
    };
  }
  if (!threadBindingFlags.spawnSubagentSessions) {
    return {
      error:
        "Discord thread-bound subagent spawns are disabled for this account (set channels.discord.threadBindings.spawnSubagentSessions=true to enable).",
      status: "error" as const,
    };
  }
  try {
    const agentId = event.agentId?.trim() || "subagent";
    const binding = await autoBindSpawnedDiscordSubagent({
      accountId: event.requester?.accountId,
      agentId,
      boundBy: "system",
      channel: event.requester?.channel,
      childSessionKey: event.childSessionKey,
      label: event.label,
      threadId: event.requester?.threadId,
      to: event.requester?.to,
    });
    if (!binding) {
      return {
        error:
          "Unable to create or bind a Discord thread for this subagent session. Session mode is unavailable for this target.",
        status: "error" as const,
      };
    }
    return { status: "ok" as const, threadBindingReady: true };
  } catch (error) {
    return {
      error: `Discord thread bind failed: ${summarizeError(error)}`,
      status: "error" as const,
    };
  }
}

export function handleDiscordSubagentEnded(event: DiscordSubagentEndedEvent) {
  unbindThreadBindingsBySessionKey({
    accountId: event.accountId,
    reason: event.reason,
    sendFarewell: event.sendFarewell,
    targetKind: normalizeThreadBindingTargetKind(event.targetKind),
    targetSessionKey: event.targetSessionKey,
  });
}

export function handleDiscordSubagentDeliveryTarget(event: DiscordSubagentDeliveryTargetEvent) {
  if (!event.expectsCompletionMessage) {
    return;
  }
  const requesterChannel = normalizeOptionalLowercaseString(event.requesterOrigin?.channel);
  if (requesterChannel !== "discord") {
    return;
  }
  const requesterAccountId = event.requesterOrigin?.accountId?.trim();
  const requesterThreadId =
    event.requesterOrigin?.threadId != null && event.requesterOrigin.threadId !== ""
      ? (normalizeOptionalStringifiedId(event.requesterOrigin.threadId) ?? "")
      : "";
  const bindings = listThreadBindingsBySessionKey({
    targetSessionKey: event.childSessionKey,
    ...(requesterAccountId ? { accountId: requesterAccountId } : {}),
    targetKind: "subagent",
  });
  if (bindings.length === 0) {
    return;
  }

  let binding: (typeof bindings)[number] | undefined;
  if (requesterThreadId) {
    binding = bindings.find((entry) => {
      if (entry.threadId !== requesterThreadId) {
        return false;
      }
      if (requesterAccountId && entry.accountId !== requesterAccountId) {
        return false;
      }
      return true;
    });
  }
  if (!binding && bindings.length === 1) {
    binding = bindings[0];
  }
  if (!binding) {
    return;
  }
  return {
    origin: {
      accountId: binding.accountId,
      channel: "discord" as const,
      threadId: binding.threadId,
      to: `channel:${binding.threadId}`,
    },
  };
}

export function registerDiscordSubagentHooks(api: OpenClawPluginApi) {
  api.on("subagent_spawning", (event) => handleDiscordSubagentSpawning(api, event));
  api.on("subagent_ended", (event) => handleDiscordSubagentEnded(event));
  api.on("subagent_delivery_target", (event) => handleDiscordSubagentDeliveryTarget(event));
}
