import { vi } from "vitest";
import { createMockTypingController } from "./reply.test-helpers.js";

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveAgentDir: vi.fn(() => "/tmp/agent"),
    resolveAgentSkillsFilter: vi.fn(() => undefined),
    resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
    resolveSessionAgentId: vi.fn(() => "main"),
  };
});

vi.mock("../../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-selection.js")>(
    "../../agents/model-selection.js",
  );
  return {
    ...actual,
    resolveModelRefFromString: vi.fn(() => null),
  };
});

vi.mock("../../agents/timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn(() => 60_000),
}));

vi.mock("../../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/workspace",
  ensureAgentWorkspace: vi.fn(async () => ({ dir: "/tmp/workspace" })),
}));

vi.mock("../../channels/model-overrides.js", () => ({
  resolveChannelModelOverride: vi.fn(() => undefined),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn() },
}));

vi.mock("../command-auth.js", () => ({
  resolveCommandAuthorization: vi.fn(() => ({ isAuthorizedSender: true })),
}));

vi.mock("./directive-handling.defaults.js", () => ({
  resolveDefaultModel: vi.fn(() => ({
    aliasIndex: new Map(),
    defaultModel: "gpt-4o-mini",
    defaultProvider: "openai",
  })),
}));

vi.mock("./get-reply-run.js", () => ({
  runPreparedReply: vi.fn(async () => undefined),
}));

vi.mock("./inbound-context.js", () => ({
  finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
}));

vi.mock("./session-reset-model.runtime.js", () => ({
  applyResetModelOverride: vi.fn(async () => undefined),
}));

vi.mock("./stage-sandbox-media.runtime.js", () => ({
  stageSandboxMedia: vi.fn(async () => undefined),
}));

vi.mock("./typing.js", () => ({
  createTypingController: vi.fn(() => createMockTypingController()),
}));

export function registerGetReplyCommonMocks(): void {}
