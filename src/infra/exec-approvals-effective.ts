import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import {
  DEFAULT_EXEC_APPROVAL_ASK_FALLBACK,
  type ExecApprovalDecision,
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
  type ExecTarget,
  maxAsk,
  minSecurity,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalsFromFile,
} from "./exec-approvals.js";

const DEFAULT_REQUESTED_SECURITY: ExecSecurity = "full";
const DEFAULT_REQUESTED_ASK: ExecAsk = "off";
const DEFAULT_HOST_PATH = "~/.openclaw/exec-approvals.json";
const REQUESTED_DEFAULT_LABEL = {
  ask: DEFAULT_REQUESTED_ASK,
  security: DEFAULT_REQUESTED_SECURITY,
} as const;
interface ExecPolicyConfig {
  host?: ExecTarget;
  security?: ExecSecurity;
  ask?: ExecAsk;
}

export interface ExecPolicyHostSummary {
  requested: ExecTarget;
  requestedSource: string;
}

export interface ExecPolicyFieldSummary<TValue extends ExecSecurity | ExecAsk> {
  requested: TValue;
  requestedSource: string;
  host: TValue;
  hostSource: string;
  effective: TValue;
  note: string;
}

export interface ExecPolicyScopeSnapshot {
  scopeLabel: string;
  configPath: string;
  agentId?: string;
  host: ExecPolicyHostSummary;
  security: ExecPolicyFieldSummary<ExecSecurity>;
  ask: ExecPolicyFieldSummary<ExecAsk>;
  askFallback: {
    effective: ExecSecurity;
    source: string;
  };
  allowedDecisions: readonly ExecApprovalDecision[];
}

export type ExecPolicyScopeSummary = Omit<ExecPolicyScopeSnapshot, "allowedDecisions">;

type ExecPolicyRequestedField = "security" | "ask";

function resolveRequestedHost(params: {
  scopeExecConfig?: ExecPolicyConfig;
  globalExecConfig?: ExecPolicyConfig;
}): { value: ExecTarget; sourcePath: string } {
  const scopeValue = params.scopeExecConfig?.host;
  if (scopeValue !== undefined) {
    return {
      sourcePath: "scope",
      value: scopeValue,
    };
  }
  const globalValue = params.globalExecConfig?.host;
  if (globalValue !== undefined) {
    return {
      sourcePath: "tools.exec",
      value: globalValue,
    };
  }
  return {
    sourcePath: "__default__",
    value: "auto",
  };
}

function formatRequestedSource(params: {
  sourcePath: string;
  field: "security" | "ask";
  defaultValue: ExecSecurity | ExecAsk;
}): string {
  return params.sourcePath === "__default__"
    ? `OpenClaw default (${params.defaultValue})`
    : `${params.sourcePath}.${params.field}`;
}

type ExecPolicyField = "security" | "ask" | "askFallback";

function resolveRequestedField<TValue extends ExecSecurity | ExecAsk>(params: {
  field: ExecPolicyRequestedField;
  scopeExecConfig?: ExecPolicyConfig;
  globalExecConfig?: ExecPolicyConfig;
}): { value: TValue; sourcePath: string } {
  const scopeValue = params.scopeExecConfig?.[params.field];
  if (scopeValue !== undefined) {
    return {
      sourcePath: "scope",
      value: scopeValue as TValue,
    };
  }
  const globalValue = params.globalExecConfig?.[params.field];
  if (globalValue !== undefined) {
    return {
      sourcePath: "tools.exec",
      value: globalValue as TValue,
    };
  }
  const defaultValue = REQUESTED_DEFAULT_LABEL[params.field] as TValue;
  return {
    sourcePath: "__default__",
    value: defaultValue,
  };
}

function formatHostFieldSource(params: {
  hostPath: string;
  field: ExecPolicyField;
  sourceSuffix: string | null;
}): string {
  if (params.sourceSuffix) {
    return `${params.hostPath} ${params.sourceSuffix}`;
  }
  if (params.field === "askFallback") {
    return `OpenClaw default (${DEFAULT_EXEC_APPROVAL_ASK_FALLBACK})`;
  }
  return "inherits requested tool policy";
}

function resolveAskNote(params: {
  requestedAsk: ExecAsk;
  hostAsk: ExecAsk;
  effectiveAsk: ExecAsk;
}): string {
  if (params.effectiveAsk === params.requestedAsk) {
    return "requested ask applies";
  }
  return "more aggressive ask wins";
}

export function collectExecPolicyScopeSnapshots(params: {
  cfg: OpenClawConfig;
  approvals: ExecApprovalsFile;
  hostPath?: string;
}): ExecPolicyScopeSnapshot[] {
  const snapshots = [
    resolveExecPolicyScopeSnapshot({
      approvals: params.approvals,
      configPath: "tools.exec",
      hostPath: params.hostPath,
      scopeExecConfig: params.cfg.tools?.exec,
      scopeLabel: "tools.exec",
    }),
  ];
  const globalExecConfig = params.cfg.tools?.exec;
  const configAgentIds = new Set(
    (params.cfg.agents?.list ?? [])
      .filter((agent) => agent.id !== DEFAULT_AGENT_ID || agent.tools?.exec !== undefined)
      .map((agent) => agent.id),
  );
  const approvalAgentIds = Object.keys(params.approvals.agents ?? {}).filter(
    (agentId) => agentId !== "*" && agentId !== "default" && agentId !== DEFAULT_AGENT_ID,
  );
  const agentIds = [...new Set([...configAgentIds, ...approvalAgentIds])].toSorted();
  for (const agentId of agentIds) {
    const agentConfig = params.cfg.agents?.list?.find((agent) => agent.id === agentId);
    snapshots.push(
      resolveExecPolicyScopeSnapshot({
        agentId,
        approvals: params.approvals,
        configPath: `agents.list.${agentId}.tools.exec`,
        globalExecConfig,
        hostPath: params.hostPath,
        scopeExecConfig: agentConfig?.tools?.exec,
        scopeLabel: `agent:${agentId}`,
      }),
    );
  }
  return snapshots;
}

export function resolveExecPolicyScopeSummary(params: {
  approvals: ExecApprovalsFile;
  scopeExecConfig?: ExecPolicyConfig | undefined;
  globalExecConfig?: ExecPolicyConfig | undefined;
  configPath: string;
  scopeLabel: string;
  agentId?: string;
  hostPath?: string;
}): ExecPolicyScopeSummary {
  const snapshot = resolveExecPolicyScopeSnapshot(params);
  const { allowedDecisions: _allowedDecisions, ...summary } = snapshot;
  return summary;
}

export function resolveExecPolicyScopeSnapshot(params: {
  approvals: ExecApprovalsFile;
  scopeExecConfig?: ExecPolicyConfig | undefined;
  globalExecConfig?: ExecPolicyConfig | undefined;
  configPath: string;
  scopeLabel: string;
  agentId?: string;
  hostPath?: string;
}): ExecPolicyScopeSnapshot {
  const requestedSecurity = resolveRequestedField<ExecSecurity>({
    field: "security",
    globalExecConfig: params.globalExecConfig,
    scopeExecConfig: params.scopeExecConfig,
  });
  const requestedHost = resolveRequestedHost({
    globalExecConfig: params.globalExecConfig,
    scopeExecConfig: params.scopeExecConfig,
  });
  const requestedAsk = resolveRequestedField<ExecAsk>({
    field: "ask",
    globalExecConfig: params.globalExecConfig,
    scopeExecConfig: params.scopeExecConfig,
  });
  const resolved = resolveExecApprovalsFromFile({
    agentId: params.agentId,
    file: params.approvals,
    overrides: {
      ask: requestedAsk.value,
      security: requestedSecurity.value,
    },
  });
  const hostPath = params.hostPath ?? DEFAULT_HOST_PATH;
  const effectiveSecurity = minSecurity(requestedSecurity.value, resolved.agent.security);
  const effectiveAsk = maxAsk(requestedAsk.value, resolved.agent.ask);
  const effectiveAskFallback = minSecurity(effectiveSecurity, resolved.agent.askFallback);
  return {
    scopeLabel: params.scopeLabel,
    configPath: params.configPath,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    host: {
      requested: requestedHost.value,
      requestedSource:
        requestedHost.sourcePath === "__default__"
          ? "OpenClaw default (auto)"
          : `${requestedHost.sourcePath === "scope" ? params.configPath : requestedHost.sourcePath}.host`,
    },
    security: {
      effective: effectiveSecurity,
      host: resolved.agent.security,
      hostSource: formatHostFieldSource({
        field: "security",
        hostPath,
        sourceSuffix: resolved.agentSources.security,
      }),
      note:
        effectiveSecurity === requestedSecurity.value
          ? "requested security applies"
          : "stricter host security wins",
      requested: requestedSecurity.value,
      requestedSource: formatRequestedSource({
        defaultValue: DEFAULT_REQUESTED_SECURITY,
        field: "security",
        sourcePath:
          requestedSecurity.sourcePath === "scope"
            ? params.configPath
            : requestedSecurity.sourcePath,
      }),
    },
    ask: {
      effective: effectiveAsk,
      host: resolved.agent.ask,
      hostSource: formatHostFieldSource({
        field: "ask",
        hostPath,
        sourceSuffix: resolved.agentSources.ask,
      }),
      note: resolveAskNote({
        effectiveAsk,
        hostAsk: resolved.agent.ask,
        requestedAsk: requestedAsk.value,
      }),
      requested: requestedAsk.value,
      requestedSource: formatRequestedSource({
        defaultValue: DEFAULT_REQUESTED_ASK,
        field: "ask",
        sourcePath:
          requestedAsk.sourcePath === "scope" ? params.configPath : requestedAsk.sourcePath,
      }),
    },
    askFallback: {
      effective: effectiveAskFallback,
      source: formatHostFieldSource({
        field: "askFallback",
        hostPath,
        sourceSuffix: resolved.agentSources.askFallback,
      }),
    },
    allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: effectiveAsk }),
  };
}
