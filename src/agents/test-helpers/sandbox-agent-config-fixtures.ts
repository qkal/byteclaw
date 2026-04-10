import type { OpenClawConfig } from "../../config/config.js";

type AgentToolsConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number]["tools"];
interface SandboxToolsConfig {
  allow?: string[];
  deny?: string[];
}

export function createRestrictedAgentSandboxConfig(params: {
  agentTools?: AgentToolsConfig;
  globalSandboxTools?: SandboxToolsConfig;
  workspace?: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope: "agent",
        },
      },
      list: [
        {
          id: "restricted",
          sandbox: {
            mode: "all",
            scope: "agent",
          },
          workspace: params.workspace ?? "~/openclaw-restricted",
          ...(params.agentTools ? { tools: params.agentTools } : {}),
        },
      ],
    },
    ...(params.globalSandboxTools
      ? {
          tools: {
            sandbox: {
              tools: params.globalSandboxTools,
            },
          },
        }
      : {}),
  } as OpenClawConfig;
}
