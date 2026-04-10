import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { handleSubagentsSendAction } from "./commands-subagents/action-send.js";

export function buildSubagentRun(): SubagentRunRecord {
  return {
    childSessionKey: "agent:main:subagent:abc",
    cleanup: "keep",
    createdAt: 1000,
    requesterDisplayKey: "main",
    requesterSessionKey: "agent:main:main",
    runId: "run-1",
    startedAt: 1000,
    task: "do thing",
  };
}

export function buildSubagentsSendContext(params?: {
  cfg?: OpenClawConfig;
  handledPrefix?: string;
  requesterKey?: string;
  runs?: SubagentRunRecord[];
  restTokens?: string[];
}) {
  return {
    handledPrefix: params?.handledPrefix ?? "/subagents",
    params: {
      cfg:
        params?.cfg ??
        ({
          channels: { whatsapp: { allowFrom: ["*"] } },
          commands: { text: true },
        } as OpenClawConfig),
      command: {
        channel: "whatsapp",
        to: "test-bot",
      },
      ctx: {},
    },
    requesterKey: params?.requesterKey ?? "agent:main:main",
    restTokens: params?.restTokens ?? [],
    runs: params?.runs ?? [buildSubagentRun()],
  } as Parameters<typeof handleSubagentsSendAction>[0];
}
