import {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
} from "../bootstrap-budget.js";
import {
  makeBootstrapWarn as makeBootstrapWarnImpl,
  resolveBootstrapContextForRun as resolveBootstrapContextForRunImpl,
} from "../bootstrap-files.js";
import { resolveCliAuthEpoch } from "../cli-auth-epoch.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import { hashCliSessionText, resolveCliSessionReuse } from "../cli-session.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../heartbeat-system-prompt.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "../pi-embedded-helpers.js";
import { resolveSkillsPromptForRun } from "../skills.js";
import { resolveSystemPromptOverride } from "../system-prompt-override.js";
import { buildSystemPromptReport } from "../system-prompt-report.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import { buildSystemPrompt, normalizeCliModel } from "./helpers.js";
import { cliBackendLog } from "./log.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const prepareDeps = {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  makeBootstrapWarn: makeBootstrapWarnImpl,
  resolveBootstrapContextForRun: resolveBootstrapContextForRunImpl,
  resolveOpenClawDocsPath: async (
    params: Parameters<typeof import("../docs-path.js").resolveOpenClawDocsPath>[0],
  ) => (await import("../docs-path.js")).resolveOpenClawDocsPath(params),
};

export function setCliRunnerPrepareTestDeps(overrides: Partial<typeof prepareDeps>): void {
  Object.assign(prepareDeps, overrides);
}

export async function prepareCliRunContext(
  params: RunCliAgentParams,
): Promise<PreparedCliRunContext> {
  const started = Date.now();
  const workspaceResolution = resolveRunWorkspaceDir({
    agentId: params.agentId,
    config: params.config,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
  });
  const resolvedWorkspace = workspaceResolution.workspaceDir;
  const redactedSessionId = redactRunIdentifier(params.sessionId);
  const redactedSessionKey = redactRunIdentifier(params.sessionKey);
  const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
  if (workspaceResolution.usedFallback) {
    cliBackendLog.warn(
      `[workspace-fallback] caller=runCliAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
    );
  }
  const workspaceDir = resolvedWorkspace;

  const backendResolved = resolveCliBackendConfig(params.provider, params.config);
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  const authEpoch = await resolveCliAuthEpoch({
    authProfileId: params.authProfileId,
    provider: params.provider,
  });
  const extraSystemPrompt = params.extraSystemPrompt?.trim() ?? "";
  const extraSystemPromptHash = hashCliSessionText(extraSystemPrompt);
  const modelId = (params.model ?? "default").trim() || "default";
  const normalizedModel = normalizeCliModel(modelId, backendResolved.config);
  const modelDisplay = `${params.provider}/${modelId}`;

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { bootstrapFiles, contextFiles } = await prepareDeps.resolveBootstrapContextForRun({
    config: params.config,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    warn: prepareDeps.makeBootstrapWarn({
      sessionLabel,
      warn: (message) => cliBackendLog.warn(message),
    }),
    workspaceDir,
  });
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.config);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config);
  const bootstrapAnalysis = analyzeBootstrapBudget({
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
    files: buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: contextFiles,
    }),
  });
  const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(params.config);
  const bootstrapPromptWarning = buildBootstrapPromptWarning({
    analysis: bootstrapAnalysis,
    mode: bootstrapPromptWarningMode,
    previousSignature: params.bootstrapPromptWarningSignature,
    seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
  });
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    agentId: params.agentId,
    config: params.config,
    sessionKey: params.sessionKey,
  });
  const mcpLoopbackRuntime = backendResolved.bundleMcp
    ? prepareDeps.getActiveMcpLoopbackRuntime()
    : undefined;
  const preparedBackend = await prepareCliBundleMcpConfig({
    additionalConfig: mcpLoopbackRuntime
      ? prepareDeps.createMcpLoopbackServerConfig(mcpLoopbackRuntime.port)
      : undefined,
    backend: backendResolved.config,
    config: params.config,
    enabled: backendResolved.bundleMcp,
    env: mcpLoopbackRuntime
      ? {
          OPENCLAW_MCP_ACCOUNT_ID: params.agentAccountId ?? "",
          OPENCLAW_MCP_AGENT_ID: sessionAgentId ?? "",
          OPENCLAW_MCP_MESSAGE_CHANNEL: params.messageProvider ?? "",
          OPENCLAW_MCP_SESSION_KEY: params.sessionKey ?? "",
          OPENCLAW_MCP_TOKEN: mcpLoopbackRuntime.token,
        }
      : undefined,
    mode: backendResolved.bundleMcpMode,
    warn: (message) => cliBackendLog.warn(message),
    workspaceDir,
  });
  const reusableCliSession = params.cliSessionBinding
    ? resolveCliSessionReuse({
        authEpoch,
        authProfileId: params.authProfileId,
        binding: params.cliSessionBinding,
        extraSystemPromptHash,
        mcpConfigHash: preparedBackend.mcpConfigHash,
      })
    : params.cliSessionId
      ? { sessionId: params.cliSessionId }
      : {};
  if (reusableCliSession.invalidatedReason) {
    cliBackendLog.info(
      `cli session reset: provider=${params.provider} reason=${reusableCliSession.invalidatedReason}`,
    );
  }
  const heartbeatPrompt = resolveHeartbeatPromptForSystemPrompt({
    agentId: sessionAgentId,
    config: params.config,
    defaultAgentId,
  });
  const docsPath = await prepareDeps.resolveOpenClawDocsPath({
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
    workspaceDir,
  });
  const skillsPrompt = resolveSkillsPromptForRun({
    agentId: sessionAgentId,
    config: params.config,
    skillsSnapshot: params.skillsSnapshot,
    workspaceDir,
  });
  const systemPrompt =
    resolveSystemPromptOverride({
      agentId: sessionAgentId,
      config: params.config,
    }) ??
    buildSystemPrompt({
      agentId: sessionAgentId,
      config: params.config,
      contextFiles,
      defaultThinkLevel: params.thinkLevel,
      docsPath: docsPath ?? undefined,
      extraSystemPrompt,
      heartbeatPrompt,
      modelDisplay,
      ownerNumbers: params.ownerNumbers,
      skillsPrompt,
      tools: [],
      workspaceDir,
    });
  const systemPromptReport = buildSystemPromptReport({
    bootstrapFiles,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
    bootstrapTruncation: buildBootstrapTruncationReportMeta({
      analysis: bootstrapAnalysis,
      warning: bootstrapPromptWarning,
      warningMode: bootstrapPromptWarningMode,
    }),
    generatedAt: Date.now(),
    injectedFiles: contextFiles,
    model: modelId,
    provider: params.provider,
    sandbox: { mode: "off", sandboxed: false },
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    skillsPrompt,
    source: "run",
    systemPrompt,
    tools: [],
    workspaceDir,
  });

  return {
    authEpoch,
    backendResolved,
    bootstrapPromptWarningLines: bootstrapPromptWarning.lines,
    extraSystemPromptHash,
    heartbeatPrompt,
    modelId,
    normalizedModel,
    params,
    preparedBackend,
    reusableCliSession,
    started,
    systemPrompt,
    systemPromptReport,
    workspaceDir,
  };
}
