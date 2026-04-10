import fs from "node:fs/promises";
import path from "node:path";
import "./test-helpers/fast-coding-tools.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type EmbeddedPiRunnerTestWorkspace,
  cleanupEmbeddedPiRunnerTestWorkspace,
  createEmbeddedPiRunnerOpenAiConfig,
  createEmbeddedPiRunnerTestWorkspace,
  immediateEnqueue,
} from "./test-helpers/pi-embedded-runner-e2e-fixtures.js";

const E2E_TIMEOUT_MS = 40_000;

function createMockUsage(input: number, output: number) {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cost: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
      total: 0,
    },
    input,
    output,
    totalTokens: input + output,
  };
}

let streamCallCount = 0;
let observedContexts: { role?: string; content?: unknown }[][] = [];

vi.mock("./pi-bundle-mcp-tools.js", () => ({
  getOrCreateSessionMcpRuntime: async () => ({
    callTool: async () => ({
      content: [{ text: "FROM-BUNDLE", type: "text" }],
    }),
    configFingerprint: "test",
    createdAt: Date.now(),
    dispose: async () => {},
    getCatalog: async () => ({
      generatedAt: Date.now(),
      servers: {},
      tools: [],
      version: 1,
    }),
    lastUsedAt: Date.now(),
    markUsed: () => {},
    sessionId: "bundle-mcp-runtime",
    sessionKey: "agent:test:bundle-mcp-e2e",
    workspaceDir: "/tmp",
  }),
  materializeBundleMcpToolsForRun: async () => ({
    dispose: async () => {},
    tools: [
      {
        description: "Bundle MCP probe",
        execute: async () => ({
          content: [{ type: "text", text: "FROM-BUNDLE" }],
          details: {
            mcpServer: "bundleProbe",
            mcpTool: "bundle_probe",
          },
        }),
        label: "bundle_probe",
        name: "bundleProbe__bundle_probe",
        parameters: { properties: {}, type: "object" },
      },
    ],
  }),
}));

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");

  const buildToolUseMessage = (model: { api: string; provider: string; id: string }) => ({
    api: model.api,
    content: [
      {
        arguments: {},
        id: "tc-bundle-mcp-1",
        name: "bundleProbe__bundle_probe",
        type: "toolCall" as const,
      },
    ],
    model: model.id,
    provider: model.provider,
    role: "assistant" as const,
    stopReason: "toolUse" as const,
    timestamp: Date.now(),
    usage: createMockUsage(1, 1),
  });

  const buildStopMessage = (
    model: { api: string; provider: string; id: string },
    text: string,
  ) => ({
    api: model.api,
    content: [{ text, type: "text" as const }],
    model: model.id,
    provider: model.provider,
    role: "assistant" as const,
    stopReason: "stop" as const,
    timestamp: Date.now(),
    usage: createMockUsage(1, 1),
  });

  return {
    ...actual,
    complete: async (model: { api: string; provider: string; id: string }) => {
      streamCallCount += 1;
      return streamCallCount === 1
        ? buildToolUseMessage(model)
        : buildStopMessage(model, "BUNDLE MCP OK FROM-BUNDLE");
    },
    completeSimple: async (model: { api: string; provider: string; id: string }) => {
      streamCallCount += 1;
      return streamCallCount === 1
        ? buildToolUseMessage(model)
        : buildStopMessage(model, "BUNDLE MCP OK FROM-BUNDLE");
    },
    streamSimple: (
      model: { api: string; provider: string; id: string },
      context: { messages?: { role?: string; content?: unknown }[] },
    ) => {
      streamCallCount += 1;
      const messages = (context.messages ?? []).map((message) => ({ ...message }));
      observedContexts.push(messages);
      const stream = actual.createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (streamCallCount === 1) {
          stream.push({
            message: buildToolUseMessage(model),
            reason: "toolUse",
            type: "done",
          });
          stream.end();
          return;
        }

        const toolResultText = messages.flatMap((message) =>
          Array.isArray(message.content)
            ? (message.content as { type?: string; text?: string }[])
                .filter((entry) => entry.type === "text" && typeof entry.text === "string")
                .map((entry) => entry.text ?? "")
            : [],
        );
        const sawBundleResult = toolResultText.some((text) => text.includes("FROM-BUNDLE"));
        if (!sawBundleResult) {
          stream.push({
            message: buildStopMessage(model, "bundle MCP tool result missing from context"),
            reason: "stop",
            type: "done",
          });
          stream.end();
          return;
        }

        stream.push({
          message: buildStopMessage(model, "BUNDLE MCP OK FROM-BUNDLE"),
          reason: "stop",
          type: "done",
        });
        stream.end();
      });
      return stream;
    },
  };
});

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let e2eWorkspace: EmbeddedPiRunnerTestWorkspace | undefined;
let agentDir: string;
let workspaceDir: string;

beforeAll(async () => {
  vi.useRealTimers();
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
  e2eWorkspace = await createEmbeddedPiRunnerTestWorkspace("openclaw-bundle-mcp-pi-");
  ({ agentDir, workspaceDir } = e2eWorkspace);
}, 180_000);

afterAll(async () => {
  await cleanupEmbeddedPiRunnerTestWorkspace(e2eWorkspace);
  e2eWorkspace = undefined;
});

const readSessionMessages = async (sessionFile: string) => {
  const raw = await fs.readFile(sessionFile, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } },
    )
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message) as { role?: string; content?: unknown }[];
};

describe("runEmbeddedPiAgent bundle MCP e2e", () => {
  it.skip(
    "loads bundle MCP into Pi, executes the MCP tool, and includes the result in the follow-up turn",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      streamCallCount = 0;
      observedContexts = [];

      const sessionFile = path.join(workspaceDir, "session-bundle-mcp-e2e.jsonl");
      const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-bundle-mcp"]);

      const result = await runEmbeddedPiAgent({
        agentDir,
        config: cfg,
        enqueue: immediateEnqueue,
        model: "mock-bundle-mcp",
        prompt: "Use the bundle MCP tool and report its result.",
        provider: "openai",
        runId: "run-bundle-mcp-e2e",
        sessionFile,
        sessionId: "bundle-mcp-e2e",
        sessionKey: "agent:test:bundle-mcp-e2e",
        timeoutMs: 30_000,
        workspaceDir,
      });

      expect(result.payloads?.[0]?.text).toContain("BUNDLE MCP OK FROM-BUNDLE");
      expect(streamCallCount).toBe(2);

      const followUpContext = observedContexts[1] ?? [];
      const followUpTexts = followUpContext.flatMap((message) =>
        Array.isArray(message.content)
          ? (message.content as { type?: string; text?: string }[])
              .filter((entry) => entry.type === "text" && typeof entry.text === "string")
              .map((entry) => entry.text ?? "")
          : [],
      );
      expect(followUpTexts.some((text) => text.includes("FROM-BUNDLE"))).toBe(true);

      const messages = await readSessionMessages(sessionFile);
      const toolResults = messages.filter((message) => message?.role === "toolResult");
      const toolResultText = toolResults.flatMap((message) =>
        Array.isArray(message.content)
          ? (message.content as { type?: string; text?: string }[])
              .filter((entry) => entry.type === "text" && typeof entry.text === "string")
              .map((entry) => entry.text ?? "")
          : [],
      );
      expect(toolResultText.some((text) => text.includes("FROM-BUNDLE"))).toBe(true);
    },
  );
});
