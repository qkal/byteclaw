import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  resolveAgentModelFallbacksOverrideMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — payload.fallbacks", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each([
    {
      expectedFallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5"],
      name: "passes payload.fallbacks as fallbacksOverride when defined",
      payload: {
        fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5"],
        kind: "agentTurn",
        message: "test",
      },
    },
    {
      agentFallbacks: ["openai/gpt-4o"],
      expectedFallbacks: ["openai/gpt-4o"],
      name: "falls back to agent-level fallbacks when payload.fallbacks is undefined",
      payload: { kind: "agentTurn", message: "test" },
    },
    {
      agentFallbacks: ["openai/gpt-4o"],
      expectedFallbacks: [],
      name: "payload.fallbacks=[] disables fallbacks even when agent config has them",
      payload: { fallbacks: [], kind: "agentTurn", message: "test" },
    },
  ])("$name", async ({ payload, agentFallbacks, expectedFallbacks }) => {
    if (agentFallbacks) {
      resolveAgentModelFallbacksOverrideMock.mockReturnValue(agentFallbacks);
    }

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({ payload }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(runWithModelFallbackMock.mock.calls[0][0].fallbacksOverride).toEqual(expectedFallbacks);
  });
});
