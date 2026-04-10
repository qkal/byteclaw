export interface AgentTraceBase {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
}

export function buildAgentTraceBase(params: AgentTraceBase): AgentTraceBase {
  return {
    modelApi: params.modelApi,
    modelId: params.modelId,
    provider: params.provider,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
  };
}
