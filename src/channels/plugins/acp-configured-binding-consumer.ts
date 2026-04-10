import {
  type ConfiguredAcpBindingSpec,
  buildConfiguredAcpSessionKey,
  normalizeBindingConfig,
  normalizeMode,
  normalizeText,
  parseConfiguredAcpSessionKey,
  toConfiguredAcpBindingRecord,
} from "../../acp/persistent-bindings.types.js";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";
import type {
  ConfiguredBindingRuleConfig,
  ConfiguredBindingTargetFactory,
} from "./binding-types.js";
import type { ConfiguredBindingConsumer } from "./configured-binding-consumers.js";
import type { ChannelConfiguredBindingConversationRef } from "./types.adapters.js";

function resolveAgentRuntimeAcpDefaults(params: { cfg: OpenClawConfig; ownerAgentId: string }): {
  acpAgentId?: string;
  mode?: string;
  cwd?: string;
  backend?: string;
} {
  const ownerAgentId = normalizeLowercaseStringOrEmpty(params.ownerAgentId);
  const agent = params.cfg.agents?.list?.find(
    (entry) => normalizeOptionalLowercaseString(entry.id) === ownerAgentId,
  );
  if (!agent || agent.runtime?.type !== "acp") {
    return {};
  }
  return {
    acpAgentId: normalizeText(agent.runtime.acp?.agent),
    backend: normalizeText(agent.runtime.acp?.backend),
    cwd: normalizeText(agent.runtime.acp?.cwd),
    mode: normalizeText(agent.runtime.acp?.mode),
  };
}

function resolveConfiguredBindingWorkspaceCwd(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string | undefined {
  const explicitAgentWorkspace = normalizeText(
    resolveAgentConfig(params.cfg, params.agentId)?.workspace,
  );
  if (explicitAgentWorkspace) {
    return resolveAgentWorkspaceDir(params.cfg, params.agentId);
  }
  if (params.agentId === resolveDefaultAgentId(params.cfg)) {
    const defaultWorkspace = normalizeText(params.cfg.agents?.defaults?.workspace);
    if (defaultWorkspace) {
      return resolveAgentWorkspaceDir(params.cfg, params.agentId);
    }
  }
  return undefined;
}

function buildConfiguredAcpSpec(params: {
  channel: string;
  accountId: string;
  conversation: ChannelConfiguredBindingConversationRef;
  agentId: string;
  acpAgentId?: string;
  mode: "persistent" | "oneshot";
  cwd?: string;
  backend?: string;
  label?: string;
}): ConfiguredAcpBindingSpec {
  return {
    accountId: params.accountId,
    acpAgentId: params.acpAgentId,
    agentId: params.agentId,
    backend: params.backend,
    channel: params.channel as ConfiguredAcpBindingSpec["channel"],
    conversationId: params.conversation.conversationId,
    cwd: params.cwd,
    label: params.label,
    mode: params.mode,
    parentConversationId: params.conversation.parentConversationId,
  };
}

function buildAcpTargetFactory(params: {
  cfg: OpenClawConfig;
  binding: ConfiguredBindingRuleConfig;
  channel: string;
  agentId: string;
}): ConfiguredBindingTargetFactory | null {
  if (params.binding.type !== "acp") {
    return null;
  }
  const runtimeDefaults = resolveAgentRuntimeAcpDefaults({
    cfg: params.cfg,
    ownerAgentId: params.agentId,
  });
  const bindingOverrides = normalizeBindingConfig(params.binding.acp);
  const mode = normalizeMode(bindingOverrides.mode ?? runtimeDefaults.mode);
  const cwd =
    bindingOverrides.cwd ??
    runtimeDefaults.cwd ??
    resolveConfiguredBindingWorkspaceCwd({
      agentId: params.agentId,
      cfg: params.cfg,
    });
  const backend = bindingOverrides.backend ?? runtimeDefaults.backend;
  const {label} = bindingOverrides;
  const acpAgentId = normalizeText(runtimeDefaults.acpAgentId);

  return {
    driverId: "acp",
    materialize: ({ accountId, conversation }) => {
      const spec = buildConfiguredAcpSpec({
        accountId,
        acpAgentId,
        agentId: params.agentId,
        backend,
        channel: params.channel,
        conversation,
        cwd,
        label,
        mode,
      });
      const record = toConfiguredAcpBindingRecord(spec);
      return {
        record,
        statefulTarget: {
          agentId: params.agentId,
          driverId: "acp",
          kind: "stateful",
          sessionKey: buildConfiguredAcpSessionKey(spec),
          ...(label ? { label } : {}),
        },
      };
    },
  };
}

export const acpConfiguredBindingConsumer: ConfiguredBindingConsumer = {
  buildTargetFactory: (params) =>
    buildAcpTargetFactory({
      agentId: params.agentId,
      binding: params.binding,
      cfg: params.cfg,
      channel: params.channel,
    }),
  id: "acp",
  matchesSessionKey: ({ sessionKey, materializedTarget }) =>
    materializedTarget.record.targetSessionKey === sessionKey,
  parseSessionKey: ({ sessionKey }) => parseConfiguredAcpSessionKey(sessionKey),
  supports: (binding) => binding.type === "acp",
};
