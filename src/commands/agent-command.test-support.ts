import path from "node:path";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config/config.js";

type AgentDefaultConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
interface LoadConfigMock {
  mockReturnValue(value: OpenClawConfig): unknown;
}

export async function withAgentCommandTempHome<T>(
  prefix: string,
  fn: (home: string) => Promise<T>,
): Promise<T> {
  return withTempHomeBase(fn, { prefix });
}

export function mockAgentCommandConfig(
  configSpy: LoadConfigMock,
  home: string,
  storePath: string,
  agentOverrides?: Partial<AgentDefaultConfig>,
): OpenClawConfig {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace: path.join(home, "openclaw"),
        ...agentOverrides,
      },
    },
    session: { mainKey: "main", store: storePath },
  } as OpenClawConfig;
  configSpy.mockReturnValue(cfg);
  return cfg;
}

export function createDefaultAgentCommandResult() {
  return {
    meta: {
      agentMeta: { model: "m", provider: "p", sessionId: "s" },
      durationMs: 5,
    },
    payloads: [{ text: "ok" }],
  };
}
