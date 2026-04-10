import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { applyInlineDirectivesFastLane } from "./directive-handling.fast-lane.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import { persistInlineDirectives } from "./directive-handling.persist.js";

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveSessionAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../config/sessions/store.js", () => ({
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: vi.fn(),
}));

function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createConfig(): OpenClawConfig {
  return {
    agents: { defaults: {} },
    commands: { text: true },
  } as unknown as OpenClawConfig;
}

describe("mixed inline directives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits directive ack while persisting inline reasoning in mixed messages", async () => {
    const directives = parseInlineDirectives("please reply\n/reasoning on");
    const cfg = createConfig();
    const sessionEntry = createSessionEntry();
    const sessionStore = { "agent:main:dm:1": sessionEntry };

    const fastLane = await applyInlineDirectivesFastLane({
      agentCfg: cfg.agents?.defaults,
      agentId: "main",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      allowedModelCatalog: [],
      allowedModelKeys: new Set(),
      cfg,
      commandAuthorized: true,
      ctx: { Surface: "whatsapp" } as never,
      defaultModel: "claude-opus-4-6",
      defaultProvider: "anthropic",
      directives,
      elevatedAllowed: false,
      elevatedEnabled: false,
      elevatedFailures: [],
      formatModelSwitchEvent: (label) => label,
      initialModelLabel: "anthropic/claude-opus-4-6",
      isGroup: false,
      messageProviderKey: "whatsapp",
      model: "claude-opus-4-6",
      modelState: {
        allowedModelCatalog: [],
        allowedModelKeys: new Set(),
        resetModelOverride: false,
        resolveDefaultThinkingLevel: async () => "off",
      },
      provider: "anthropic",
      resetModelOverride: false,
      sessionEntry,
      sessionKey: "agent:main:dm:1",
      sessionStore,
      storePath: undefined,
    });

    expect(fastLane.directiveAck).toEqual({
      text: "⚙️ Reasoning visibility enabled.",
    });

    const persisted = await persistInlineDirectives({
      agentCfg: cfg.agents?.defaults,
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      allowedModelKeys: new Set(),
      cfg,
      defaultModel: "claude-opus-4-6",
      defaultProvider: "anthropic",
      directives,
      elevatedAllowed: false,
      elevatedEnabled: false,
      formatModelSwitchEvent: (label) => label,
      gatewayClientScopes: [],
      initialModelLabel: "anthropic/claude-opus-4-6",
      messageProvider: "whatsapp",
      model: "claude-opus-4-6",
      provider: "anthropic",
      sessionEntry,
      sessionKey: "agent:main:dm:1",
      sessionStore,
      storePath: undefined,
      surface: "whatsapp",
    });

    expect(sessionEntry.reasoningLevel).toBe("on");
    expect(persisted.provider).toBe("anthropic");
    expect(persisted.model).toBe("claude-opus-4-6");
  });
});
