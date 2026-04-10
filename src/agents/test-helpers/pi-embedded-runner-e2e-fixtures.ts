import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { buildAttemptReplayMetadata } from "../pi-embedded-runner/run/incomplete-turn.js";
import type { EmbeddedRunAttemptResult } from "../pi-embedded-runner/run/types.js";

export interface EmbeddedPiRunnerTestWorkspace {
  tempRoot: string;
  agentDir: string;
  workspaceDir: string;
}

export async function createEmbeddedPiRunnerTestWorkspace(
  prefix: string,
): Promise<EmbeddedPiRunnerTestWorkspace> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const agentDir = path.join(tempRoot, "agent");
  const workspaceDir = path.join(tempRoot, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  return { agentDir, tempRoot, workspaceDir };
}

export async function cleanupEmbeddedPiRunnerTestWorkspace(
  workspace: EmbeddedPiRunnerTestWorkspace | undefined,
): Promise<void> {
  if (!workspace) {
    return;
  }
  await fs.rm(workspace.tempRoot, { force: true, recursive: true });
}

export function createEmbeddedPiRunnerOpenAiConfig(modelIds: string[]): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: "sk-test",
          baseUrl: "https://example.com",
          models: modelIds.map((id) => ({
            contextWindow: 16_000,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
            id,
            input: ["text"],
            maxTokens: 2048,
            name: `Mock ${id}`,
            reasoning: false,
          })),
        },
      },
    },
  };
}

export async function immediateEnqueue<T>(task: () => Promise<T>): Promise<T> {
  return await task();
}

export function createMockUsage(input: number, output: number) {
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

const baseUsage = createMockUsage(0, 0);

export function buildEmbeddedRunnerAssistant(
  overrides: Partial<AssistantMessage>,
): AssistantMessage {
  return {
    api: "openai-responses",
    content: [],
    model: "mock-1",
    provider: "openai",
    role: "assistant",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: baseUsage,
    ...overrides,
  };
}

export function makeEmbeddedRunnerAttempt(
  overrides: Partial<EmbeddedRunAttemptResult>,
): EmbeddedRunAttemptResult {
  const toolMetas = overrides.toolMetas ?? [];
  const didSendViaMessagingTool = overrides.didSendViaMessagingTool ?? false;
  const { successfulCronAdds } = overrides;
  return {
    aborted: false,
    assistantTexts: [],
    cloudCodeAssistFormatError: false,
    didSendViaMessagingTool,
    idleTimedOut: false,
    itemLifecycle: { activeCount: 0, completedCount: 0, startedCount: 0 },
    lastAssistant: undefined,
    messagesSnapshot: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSentTexts: [],
    promptError: null,
    promptErrorSource: null,
    replayMetadata:
      overrides.replayMetadata ??
      buildAttemptReplayMetadata({
        didSendViaMessagingTool,
        successfulCronAdds,
        toolMetas,
      }),
    sessionIdUsed: "session:test",
    systemPromptReport: undefined,
    timedOut: false,
    timedOutDuringCompaction: false,
    toolMetas,
    ...overrides,
  };
}

export function createResolvedEmbeddedRunnerModel(
  provider: string,
  modelId: string,
  options?: { baseUrl?: string },
) {
  return {
    authStorage: {
      setRuntimeApiKey: () => undefined,
    },
    error: undefined,
    model: {
      api: "openai-responses",
      baseUrl: options?.baseUrl ?? `https://example.com/${provider}`,
      contextWindow: 16_000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: modelId,
      input: ["text"],
      maxTokens: 2048,
      name: modelId,
      provider,
      reasoning: false,
    },
    modelRegistry: {},
  };
}
