import { createHash } from "node:crypto";
import type { ChannelId } from "../channels/plugins/types.js";
import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { sanitizeAgentId } from "../routing/session-key.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { normalizeText } from "./normalize-text.js";
import type { AcpRuntimeSessionMode } from "./runtime/types.js";

export { normalizeText } from "./normalize-text.js";

export type ConfiguredAcpBindingChannel = ChannelId;

export interface ConfiguredAcpBindingSpec {
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  /** Owning OpenClaw agent id (used for session identity/storage). */
  agentId: string;
  /** ACP harness agent id override (falls back to agentId when omitted). */
  acpAgentId?: string;
  mode: AcpRuntimeSessionMode;
  cwd?: string;
  backend?: string;
  label?: string;
}

export interface ResolvedConfiguredAcpBinding {
  spec: ConfiguredAcpBindingSpec;
  record: SessionBindingRecord;
}

export interface AcpBindingConfigShape {
  mode?: string;
  cwd?: string;
  backend?: string;
  label?: string;
}

export function normalizeMode(value: unknown): AcpRuntimeSessionMode {
  const raw = normalizeOptionalLowercaseString(value);
  return raw === "oneshot" ? "oneshot" : "persistent";
}

export function normalizeBindingConfig(raw: unknown): AcpBindingConfigShape {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const shape = raw as AcpBindingConfigShape;
  const mode = normalizeText(shape.mode);
  return {
    backend: normalizeText(shape.backend),
    cwd: normalizeText(shape.cwd),
    label: normalizeText(shape.label),
    mode: mode ? normalizeMode(mode) : undefined,
  };
}

function buildBindingHash(params: {
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
}): string {
  return createHash("sha256")
    .update(`${params.channel}:${params.accountId}:${params.conversationId}`)
    .digest("hex")
    .slice(0, 16);
}

export function buildConfiguredAcpSessionKey(spec: ConfiguredAcpBindingSpec): string {
  const hash = buildBindingHash({
    accountId: spec.accountId,
    channel: spec.channel,
    conversationId: spec.conversationId,
  });
  return `agent:${sanitizeAgentId(spec.agentId)}:acp:binding:${spec.channel}:${spec.accountId}:${hash}`;
}

export function toConfiguredAcpBindingRecord(spec: ConfiguredAcpBindingSpec): SessionBindingRecord {
  return {
    bindingId: `config:acp:${spec.channel}:${spec.accountId}:${spec.conversationId}`,
    boundAt: 0,
    conversation: {
      accountId: spec.accountId,
      channel: spec.channel,
      conversationId: spec.conversationId,
      parentConversationId: spec.parentConversationId,
    },
    metadata: {
      source: "config",
      mode: spec.mode,
      agentId: spec.agentId,
      ...(spec.acpAgentId ? { acpAgentId: spec.acpAgentId } : {}),
      label: spec.label,
      ...(spec.backend ? { backend: spec.backend } : {}),
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    },
    status: "active",
    targetKind: "session",
    targetSessionKey: buildConfiguredAcpSessionKey(spec),
  };
}

export function parseConfiguredAcpSessionKey(
  sessionKey: string,
): { channel: ConfiguredAcpBindingChannel; accountId: string } | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("agent:")) {
    return null;
  }
  const rest = trimmed.slice(trimmed.indexOf(":") + 1);
  const nextSeparator = rest.indexOf(":");
  if (nextSeparator === -1) {
    return null;
  }
  const tokens = rest.slice(nextSeparator + 1).split(":");
  if (tokens.length !== 5 || tokens[0] !== "acp" || tokens[1] !== "binding") {
    return null;
  }
  const channel = normalizeOptionalLowercaseString(tokens[2]);
  if (!channel) {
    return null;
  }
  return {
    accountId: normalizeAccountId(tokens[3] ?? "default"),
    channel: channel as ConfiguredAcpBindingChannel,
  };
}

export function resolveConfiguredAcpBindingSpecFromRecord(
  record: SessionBindingRecord,
): ConfiguredAcpBindingSpec | null {
  if (record.targetKind !== "session") {
    return null;
  }
  const conversationId = record.conversation.conversationId.trim();
  if (!conversationId) {
    return null;
  }
  const agentId =
    normalizeText(record.metadata?.agentId) ??
    resolveAgentIdFromSessionKey(record.targetSessionKey);
  if (!agentId) {
    return null;
  }
  return {
    accountId: normalizeAccountId(record.conversation.accountId),
    acpAgentId: normalizeText(record.metadata?.acpAgentId),
    agentId,
    backend: normalizeText(record.metadata?.backend),
    channel: record.conversation.channel as ConfiguredAcpBindingChannel,
    conversationId,
    cwd: normalizeText(record.metadata?.cwd),
    label: normalizeText(record.metadata?.label),
    mode: normalizeMode(record.metadata?.mode),
    parentConversationId: normalizeText(record.conversation.parentConversationId),
  };
}

export function toResolvedConfiguredAcpBinding(
  record: SessionBindingRecord,
): ResolvedConfiguredAcpBinding | null {
  const spec = resolveConfiguredAcpBindingSpecFromRecord(record);
  if (!spec) {
    return null;
  }
  return {
    record,
    spec,
  };
}
