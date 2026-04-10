import { afterEach, describe, expect, it } from "vitest";
import {
  type OpenClawConfig,
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/config.js";
import {
  buildEmbeddedRunBaseParams,
  resolveProviderScopedAuthProfile,
} from "./agent-runner-utils.js";
import type { FollowupRun } from "./queue.js";

function makeRun(config: OpenClawConfig): FollowupRun["run"] {
  return {
    agentDir: "/tmp/agent",
    agentId: "agent-1",
    bashElevated: false,
    config,
    enforceFinalTag: false,
    execOverrides: {},
    model: "gpt-4.1",
    ownerNumbers: ["+15550001"],
    provider: "openai",
    reasoningLevel: "none",
    sessionFile: "/tmp/session.json",
    sessionId: "session-1",
    sessionKey: "agent:test:session",
    skillsSnapshot: [],
    thinkLevel: "medium",
    timeoutMs: 60_000,
    verboseLevel: "off",
    workspaceDir: "/tmp/workspace",
  } as unknown as FollowupRun["run"];
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("buildEmbeddedRunBaseParams runtime config", () => {
  it("keeps an already-resolved run config instead of reverting to a stale runtime snapshot", () => {
    const staleSnapshot: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            apiKey: {
              id: "OPENAI_API_KEY",
              provider: "default",
              source: "env",
            },
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    };
    const resolvedRunConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            apiKey: "resolved-runtime-key",
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(staleSnapshot, staleSnapshot);

    const resolved = buildEmbeddedRunBaseParams({
      authProfile: resolveProviderScopedAuthProfile({
        primaryProvider: "openai",
        provider: "openai",
      }),
      model: "gpt-4.1-mini",
      provider: "openai",
      run: makeRun(resolvedRunConfig),
      runId: "run-1",
    });

    expect(resolved.config).toBe(resolvedRunConfig);
  });
});
