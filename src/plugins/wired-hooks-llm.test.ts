import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";

const hookCtx = {
  agentId: "main",
  sessionId: "session-1",
};

async function expectLlmHookCall(params: {
  hookName: "llm_input" | "llm_output";
  event: Record<string, unknown>;
  expectedEvent: Record<string, unknown>;
}) {
  const handler = vi.fn();
  const { runner } = createHookRunnerWithRegistry([{ handler, hookName: params.hookName }]);

  if (params.hookName === "llm_input") {
    await runner.runLlmInput(
      {
        ...params.event,
        historyMessages: [...((params.event.historyMessages as unknown[] | undefined) ?? [])],
      } as Parameters<typeof runner.runLlmInput>[0],
      hookCtx,
    );
  } else {
    await runner.runLlmOutput(
      {
        ...params.event,
        assistantTexts: [...((params.event.assistantTexts as string[] | undefined) ?? [])],
      } as Parameters<typeof runner.runLlmOutput>[0],
      hookCtx,
    );
  }

  expect(handler).toHaveBeenCalledWith(
    expect.objectContaining(params.expectedEvent),
    expect.objectContaining({ sessionId: "session-1" }),
  );
}

describe("llm hook runner methods", () => {
  it.each([
    {
      event: {
        historyMessages: [],
        imagesCount: 0,
        model: "gpt-5",
        prompt: "hello",
        provider: "openai",
        runId: "run-1",
        sessionId: "session-1",
        systemPrompt: "be helpful",
      },
      expectedEvent: { prompt: "hello", runId: "run-1" },
      hookName: "llm_input" as const,
      methodName: "runLlmInput" as const,
      name: "runLlmInput invokes registered llm_input hooks",
    },
    {
      event: {
        assistantTexts: ["hi"],
        lastAssistant: { content: "hi", role: "assistant" },
        model: "gpt-5",
        provider: "openai",
        runId: "run-1",
        sessionId: "session-1",
        usage: {
          input: 10,
          output: 20,
          total: 30,
        },
      },
      expectedEvent: { assistantTexts: ["hi"], runId: "run-1" },
      hookName: "llm_output" as const,
      methodName: "runLlmOutput" as const,
      name: "runLlmOutput invokes registered llm_output hooks",
    },
  ] as const)("$name", async ({ hookName, expectedEvent, event }) => {
    await expectLlmHookCall({ event, expectedEvent, hookName });
  });

  it("hasHooks returns true for registered llm hooks", () => {
    const { runner } = createHookRunnerWithRegistry([{ handler: vi.fn(), hookName: "llm_input" }]);

    expect(runner.hasHooks("llm_input")).toBe(true);
    expect(runner.hasHooks("llm_output")).toBe(false);
  });
});
