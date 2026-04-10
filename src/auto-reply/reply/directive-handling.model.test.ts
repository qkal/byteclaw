import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const authProfilesStoreMock = vi.hoisted(() => ({
  profiles: {} as Record<string, { type: "api_key"; provider: string; key: string }>,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  clearRuntimeAuthProfileStoreSnapshots: () => {
    authProfilesStoreMock.profiles = {};
  },
  ensureAuthProfileStore: () => ({
    profiles: authProfilesStoreMock.profiles,
    version: 1,
  }),
  replaceRuntimeAuthProfileStoreSnapshots: (
    snapshots: {
      store?: { profiles?: Record<string, { type: "api_key"; provider: string; key: string }> };
    }[],
  ) => {
    authProfilesStoreMock.profiles = snapshots[0]?.store?.profiles ?? {};
  },
  resolveAuthStorePathForDisplay: () => "/tmp/auth-profiles.json",
}));

import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { ElevatedLevel } from "../thinking.js";
import { handleDirectiveOnly } from "./directive-handling.impl.js";
import { parseInlineDirectives } from "./directive-handling.js";
import {
  maybeHandleModelDirectiveInfo,
  resolveModelSelectionFromDirective,
} from "./directive-handling.model.js";
import { persistInlineDirectives } from "./directive-handling.persist.js";

const liveModelSwitchMocks = vi.hoisted(() => ({
  requestLiveSessionModelSwitch: vi.fn(),
}));
const queueMocks = vi.hoisted(() => ({
  refreshQueuedFollowupSession: vi.fn(),
}));

// Mock dependencies for directive handling persistence.
vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveSessionAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../../agents/live-model-switch.js", () => ({
  requestLiveSessionModelSwitch: (...args: unknown[]) =>
    liveModelSwitchMocks.requestLiveSessionModelSwitch(...args),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: (...args: unknown[]) =>
    queueMocks.refreshQueuedFollowupSession(...args),
}));

const TEST_AGENT_DIR = "/tmp/agent";
const OPENAI_DATE_PROFILE_ID = "20251001";

interface ApiKeyProfile {
  type: "api_key";
  provider: string;
  key: string;
}

function baseAliasIndex(): ModelAliasIndex {
  return { byAlias: new Map(), byKey: new Map() };
}

function baseConfig(): OpenClawConfig {
  return {
    agents: { defaults: {} },
    commands: { text: true },
  } as unknown as OpenClawConfig;
}

function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "s1",
    updatedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir: TEST_AGENT_DIR,
      store: { profiles: {}, version: 1 },
    },
  ]);
  liveModelSwitchMocks.requestLiveSessionModelSwitch.mockReset().mockReturnValue(false);
  queueMocks.refreshQueuedFollowupSession.mockReset();
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
});

function setAuthProfiles(profiles: Record<string, ApiKeyProfile>) {
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir: TEST_AGENT_DIR,
      store: { profiles, version: 1 },
    },
  ]);
}

function createDateAuthProfiles(provider: string, id = OPENAI_DATE_PROFILE_ID) {
  return {
    [id]: {
      key: "sk-test",
      provider,
      type: "api_key",
    },
  } satisfies Record<string, ApiKeyProfile>;
}

function createGptAliasIndex(): ModelAliasIndex {
  return {
    byAlias: new Map([["gpt", { alias: "gpt", ref: { model: "gpt-4o", provider: "openai" } }]]),
    byKey: new Map([["openai/gpt-4o", ["gpt"]]]),
  };
}

function resolveModelSelectionForCommand(params: {
  command: string;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: { provider: string; id: string }[];
}) {
  return resolveModelSelectionFromDirective({
    agentDir: TEST_AGENT_DIR,
    aliasIndex: baseAliasIndex(),
    allowedModelCatalog: params.allowedModelCatalog,
    allowedModelKeys: params.allowedModelKeys,
    cfg: { commands: { text: true } } as unknown as OpenClawConfig,
    defaultModel: "claude-opus-4-6",
    defaultProvider: "anthropic",
    directives: parseInlineDirectives(params.command),
    provider: "anthropic",
  });
}

async function persistModelDirectiveForTest(params: {
  command: string;
  profiles?: Record<string, ApiKeyProfile>;
  aliasIndex?: ModelAliasIndex;
  allowedModelKeys: string[];
  sessionEntry?: SessionEntry;
  provider?: string;
  model?: string;
  initialModelLabel?: string;
}) {
  if (params.profiles) {
    setAuthProfiles(params.profiles);
  }
  const directives = parseInlineDirectives(params.command);
  const cfg = baseConfig();
  const sessionEntry = params.sessionEntry ?? createSessionEntry();
  const persisted = await persistInlineDirectives({
    agentCfg: cfg.agents?.defaults,
    agentDir: TEST_AGENT_DIR,
    aliasIndex: params.aliasIndex ?? baseAliasIndex(),
    allowedModelKeys: new Set(params.allowedModelKeys),
    cfg,
    defaultModel: "claude-opus-4-6",
    defaultProvider: "anthropic",
    directives,
    effectiveModelDirective: directives.rawModelDirective,
    elevatedAllowed: false,
    elevatedEnabled: false,
    formatModelSwitchEvent: (label) => label,
    initialModelLabel:
      params.initialModelLabel ??
      `${params.provider ?? "anthropic"}/${params.model ?? "claude-opus-4-6"}`,
    model: params.model ?? "claude-opus-4-6",
    provider: params.provider ?? "anthropic",
    sessionEntry,
    sessionKey: "agent:main:dm:1",
    sessionStore: { "agent:main:dm:1": sessionEntry },
    storePath: undefined,
  });
  return { persisted, sessionEntry };
}

type PersistInlineDirectivesParams = Parameters<typeof persistInlineDirectives>[0];

async function persistInternalOperatorWriteDirective(
  command: string,
  overrides: Partial<PersistInlineDirectivesParams> = {},
) {
  const sessionEntry = overrides.sessionEntry ?? createSessionEntry();
  const sessionStore = overrides.sessionStore ?? { "agent:main:main": sessionEntry };
  await persistInlineDirectives({
    agentCfg: undefined,
    aliasIndex: baseAliasIndex(),
    allowedModelKeys: new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]),
    cfg: baseConfig(),
    defaultModel: "claude-opus-4-6",
    defaultProvider: "anthropic",
    directives: parseInlineDirectives(command),
    elevatedAllowed: true,
    elevatedEnabled: true,
    formatModelSwitchEvent: (label) => `Switched to ${label}`,
    gatewayClientScopes: ["operator.write"],
    initialModelLabel: "anthropic/claude-opus-4-6",
    model: "claude-opus-4-6",
    provider: "anthropic",
    sessionEntry,
    sessionKey: "agent:main:main",
    sessionStore,
    storePath: "/tmp/sessions.json",
    surface: "webchat",
    ...overrides,
  });
  return sessionEntry;
}

async function resolveModelInfoReply(
  overrides: Partial<Parameters<typeof maybeHandleModelDirectiveInfo>[0]> = {},
) {
  return maybeHandleModelDirectiveInfo({
    activeAgentId: "main",
    agentDir: TEST_AGENT_DIR,
    aliasIndex: baseAliasIndex(),
    allowedModelCatalog: [],
    cfg: baseConfig(),
    defaultModel: "claude-opus-4-6",
    defaultProvider: "anthropic",
    directives: parseInlineDirectives("/model"),
    model: "claude-opus-4-6",
    provider: "anthropic",
    resetModelOverride: false,
    ...overrides,
  });
}

describe("/model chat UX", () => {
  it("shows summary for /model with no args", async () => {
    const reply = await resolveModelInfoReply();

    expect(reply?.text).toContain("Current:");
    expect(reply?.text).toContain("Browse: /models");
    expect(reply?.text).toContain("Switch: /model <provider/model>");
  });

  it("shows active runtime model when different from selected model", async () => {
    const reply = await resolveModelInfoReply({
      defaultModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
      defaultProvider: "fireworks",
      model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
      provider: "fireworks",
      sessionEntry: {
        model: "moonshotai/Kimi-K2.5",
        modelProvider: "deepinfra",
      },
    });

    expect(reply?.text).toContain(
      "Current: fireworks/accounts/fireworks/routers/kimi-k2p5-turbo (selected)",
    );
    expect(reply?.text).toContain("Active: deepinfra/moonshotai/Kimi-K2.5 (runtime)");
  });

  it("auto-applies closest match for typos", () => {
    const directives = parseInlineDirectives("/model anthropic/claud-opus-4-5");
    const cfg = { commands: { text: true } } as unknown as OpenClawConfig;

    const resolved = resolveModelSelectionFromDirective({
      agentDir: "/tmp/agent",
      aliasIndex: baseAliasIndex(),
      allowedModelCatalog: [{ id: "claude-opus-4-6", provider: "anthropic" }],
      allowedModelKeys: new Set(["anthropic/claude-opus-4-6"]),
      cfg,
      defaultModel: "claude-opus-4-6",
      defaultProvider: "anthropic",
      directives,
      provider: "anthropic",
    });

    expect(resolved.modelSelection).toEqual({
      isDefault: true,
      model: "claude-opus-4-6",
      provider: "anthropic",
    });
    expect(resolved.errorText).toBeUndefined();
  });

  it("rejects numeric /model selections with a guided error", () => {
    const resolved = resolveModelSelectionForCommand({
      allowedModelCatalog: [],
      allowedModelKeys: new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]),
      command: "/model 99",
    });

    expect(resolved.modelSelection).toBeUndefined();
    expect(resolved.errorText).toContain("Numeric model selection is not supported in chat.");
    expect(resolved.errorText).toContain("Browse: /models or /models <provider>");
  });

  it("treats explicit default /model selection as resettable default", () => {
    const resolved = resolveModelSelectionForCommand({
      allowedModelCatalog: [],
      allowedModelKeys: new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]),
      command: "/model anthropic/claude-opus-4-6",
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      isDefault: true,
      model: "claude-opus-4-6",
      provider: "anthropic",
    });
  });

  it("keeps openrouter provider/model split for exact selections", () => {
    const resolved = resolveModelSelectionForCommand({
      allowedModelCatalog: [],
      allowedModelKeys: new Set(["openrouter/anthropic/claude-opus-4-6"]),
      command: "/model openrouter/anthropic/claude-opus-4-6",
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      isDefault: false,
      model: "anthropic/claude-opus-4-6",
      provider: "openrouter",
    });
  });

  it("keeps cloudflare @cf model segments for exact selections", () => {
    const resolved = resolveModelSelectionForCommand({
      allowedModelCatalog: [],
      allowedModelKeys: new Set(["openai/@cf/openai/gpt-oss-20b"]),
      command: "/model openai/@cf/openai/gpt-oss-20b",
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      isDefault: false,
      model: "@cf/openai/gpt-oss-20b",
      provider: "openai",
    });
  });

  it("treats @YYYYMMDD as a profile override when that profile exists for the resolved provider", () => {
    setAuthProfiles(createDateAuthProfiles("openai"));

    const resolved = resolveModelSelectionForCommand({
      allowedModelCatalog: [],
      allowedModelKeys: new Set(["openai/gpt-4o"]),
      command: `/model openai/gpt-4o@${OPENAI_DATE_PROFILE_ID}`,
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      isDefault: false,
      model: "gpt-4o",
      provider: "openai",
    });
    expect(resolved.profileOverride).toBe(OPENAI_DATE_PROFILE_ID);
  });

  it("supports alias selections with numeric auth-profile overrides", () => {
    setAuthProfiles(createDateAuthProfiles("openai"));

    const resolved = resolveModelSelectionFromDirective({
      agentDir: TEST_AGENT_DIR,
      aliasIndex: createGptAliasIndex(),
      allowedModelCatalog: [],
      allowedModelKeys: new Set(["openai/gpt-4o"]),
      cfg: { commands: { text: true } } as unknown as OpenClawConfig,
      defaultModel: "claude-opus-4-6",
      defaultProvider: "anthropic",
      directives: parseInlineDirectives(`/model gpt@${OPENAI_DATE_PROFILE_ID}`),
      provider: "anthropic",
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      alias: "gpt",
      isDefault: false,
      model: "gpt-4o",
      provider: "openai",
    });
    expect(resolved.profileOverride).toBe(OPENAI_DATE_PROFILE_ID);
  });

  it("supports providerless allowlist selections with numeric auth-profile overrides", () => {
    setAuthProfiles(createDateAuthProfiles("openai"));

    const resolved = resolveModelSelectionForCommand({
      allowedModelCatalog: [],
      allowedModelKeys: new Set(["openai/gpt-4o"]),
      command: `/model gpt-4o@${OPENAI_DATE_PROFILE_ID}`,
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      isDefault: false,
      model: "gpt-4o",
      provider: "openai",
    });
    expect(resolved.profileOverride).toBe(OPENAI_DATE_PROFILE_ID);
  });

  it("keeps @YYYYMMDD as part of the model when the stored numeric profile is for another provider", () => {
    setAuthProfiles(createDateAuthProfiles("anthropic"));

    const resolved = resolveModelSelectionForCommand({
      allowedModelCatalog: [],
      allowedModelKeys: new Set([`custom/vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}`]),
      command: `/model custom/vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}`,
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      isDefault: false,
      model: `vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}`,
      provider: "custom",
    });
    expect(resolved.profileOverride).toBeUndefined();
  });

  it("persists inferred numeric auth-profile overrides for mixed-content messages", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      allowedModelKeys: ["openai/gpt-4o", `openai/gpt-4o@${OPENAI_DATE_PROFILE_ID}`],
      command: `/model openai/gpt-4o@${OPENAI_DATE_PROFILE_ID} hello`,
      profiles: createDateAuthProfiles("openai"),
    });

    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.authProfileOverride).toBe(OPENAI_DATE_PROFILE_ID);
  });

  it("persists alias-based numeric auth-profile overrides for mixed-content messages", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      aliasIndex: createGptAliasIndex(),
      allowedModelKeys: ["openai/gpt-4o"],
      command: `/model gpt@${OPENAI_DATE_PROFILE_ID} hello`,
      profiles: createDateAuthProfiles("openai"),
    });

    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.authProfileOverride).toBe(OPENAI_DATE_PROFILE_ID);
  });

  it("persists providerless numeric auth-profile overrides for mixed-content messages", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      allowedModelKeys: ["openai/gpt-4o"],
      command: `/model gpt-4o@${OPENAI_DATE_PROFILE_ID} hello`,
      profiles: createDateAuthProfiles("openai"),
    });

    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.authProfileOverride).toBe(OPENAI_DATE_PROFILE_ID);
  });

  it("persists explicit auth profiles after @YYYYMMDD version suffixes in mixed-content messages", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      allowedModelKeys: [`custom/vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}`],
      command: `/model custom/vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}@work hello`,
      profiles: {
        work: {
          key: "sk-test",
          provider: "custom",
          type: "api_key",
        },
      },
    });

    expect(sessionEntry.providerOverride).toBe("custom");
    expect(sessionEntry.modelOverride).toBe(`vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}`);
    expect(sessionEntry.authProfileOverride).toBe("work");
  });

  it("ignores invalid mixed-content model directives during persistence", async () => {
    const { persisted, sessionEntry } = await persistModelDirectiveForTest({
      allowedModelKeys: ["openai/gpt-4o"],
      command: "/model 99 hello",
      initialModelLabel: "openai/gpt-4o",
      model: "gpt-4o",
      profiles: createDateAuthProfiles("openai"),
      provider: "openai",
      sessionEntry: createSessionEntry({
        authProfileOverride: OPENAI_DATE_PROFILE_ID,
        authProfileOverrideSource: "user",
        modelOverride: "gpt-4o",
        providerOverride: "openai",
      }),
    });

    expect(persisted.provider).toBe("openai");
    expect(persisted.model).toBe("gpt-4o");
    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.authProfileOverride).toBe(OPENAI_DATE_PROFILE_ID);
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
  });
});

describe("handleDirectiveOnly model persist behavior (fixes #1435)", () => {
  const allowedModelKeys = new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]);
  const allowedModelCatalog = [
    { id: "claude-opus-4-6", name: "Claude Opus 4.5", provider: "anthropic" },
    { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
  ];
  const sessionKey = "agent:main:dm:1";
  const storePath = "/tmp/sessions.json";

  type HandleParams = Parameters<typeof handleDirectiveOnly>[0];

  function createHandleParams(overrides: Partial<HandleParams>): HandleParams {
    const entryOverride = overrides.sessionEntry;
    const storeOverride = overrides.sessionStore;
    const entry = entryOverride ?? createSessionEntry();
    const store = storeOverride ?? ({ [sessionKey]: entry } as const);
    const { sessionEntry: _ignoredEntry, sessionStore: _ignoredStore, ...rest } = overrides;

    return {
      cfg: baseConfig(),
      directives: rest.directives ?? parseInlineDirectives(""),
      sessionKey,
      storePath,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys,
      allowedModelCatalog,
      resetModelOverride: false,
      provider: "anthropic",
      model: "claude-opus-4-6",
      initialModelLabel: "anthropic/claude-opus-4-6",
      formatModelSwitchEvent: (label) => `Switched to ${label}`,
      ...rest,
      sessionEntry: entry,
      sessionStore: store,
    };
  }

  it("shows success message when session state is available", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o");
    const sessionEntry = createSessionEntry();
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
      }),
    );

    expect(result?.text).toContain("Model set to");
    expect(result?.text).toContain("openai/gpt-4o");
    expect(result?.text).not.toContain("failed");
    expect(sessionEntry.liveModelSwitchPending).toBe(true);
  });

  it("does not request a live restart when /model mutates an active session", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o");
    const sessionEntry = createSessionEntry();

    await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
      }),
    );

    expect(liveModelSwitchMocks.requestLiveSessionModelSwitch).not.toHaveBeenCalled();
  });

  it("retargets queued followups when /model mutates session state", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o");
    const sessionEntry = createSessionEntry();

    await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
      }),
    );

    expect(queueMocks.refreshQueuedFollowupSession).toHaveBeenCalledWith({
      key: sessionKey,
      nextAuthProfileId: undefined,
      nextAuthProfileIdSource: undefined,
      nextModel: "gpt-4o",
      nextProvider: "openai",
    });
  });

  it("shows no model message when no /model directive", async () => {
    const directives = parseInlineDirectives("hello world");
    const sessionEntry = createSessionEntry();
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
      }),
    );

    expect(result?.text ?? "").not.toContain("Model set to");
    expect(result?.text ?? "").not.toContain("failed");
  });

  it("strips inline elevated directives while keeping user text", () => {
    const directives = parseInlineDirectives("hello there /elevated off");

    expect(directives.hasElevatedDirective).toBe(true);
    expect(directives.elevatedLevel).toBe("off");
    expect(directives.cleaned).toBe("hello there");
  });

  it("persists thinkingLevel=off (does not clear)", async () => {
    const directives = parseInlineDirectives("/think off");
    const sessionEntry = createSessionEntry({ thinkingLevel: "low" });
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
        sessionStore,
      }),
    );

    expect(result?.text ?? "").not.toContain("failed");
    expect(sessionEntry.thinkingLevel).toBe("off");
    expect(sessionStore["agent:main:dm:1"]?.thinkingLevel).toBe("off");
  });

  it("persists and reports fast-mode directives", async () => {
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };

    const onReply = await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineDirectives("/fast on"),
        sessionEntry,
        sessionStore,
      }),
    );
    expect(onReply?.text).toContain("Fast mode enabled");
    expect(sessionEntry.fastMode).toBe(true);

    const statusReply = await handleDirectiveOnly(
      createHandleParams({
        currentFastMode: sessionEntry.fastMode,
        directives: parseInlineDirectives("/fast"),
        sessionEntry,
        sessionStore,
      }),
    );
    expect(statusReply?.text).toContain("Current fast mode: on");

    const offReply = await handleDirectiveOnly(
      createHandleParams({
        currentFastMode: sessionEntry.fastMode,
        directives: parseInlineDirectives("/fast off"),
        sessionEntry,
        sessionStore,
      }),
    );
    expect(offReply?.text).toContain("Fast mode disabled");
    expect(sessionEntry.fastMode).toBe(false);
  });

  it("persists and reports elevated-mode directives when allowed", async () => {
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };
    const base = {
      elevatedAllowed: true,
      elevatedEnabled: true,
      sessionEntry,
      sessionStore,
    } satisfies Partial<HandleParams>;

    const onReply = await handleDirectiveOnly(
      createHandleParams({
        ...base,
        directives: parseInlineDirectives("/elevated on"),
      }),
    );
    expect(onReply?.text).toContain("Elevated mode set to ask");
    expect(sessionEntry.elevatedLevel).toBe("on");

    const statusReply = await handleDirectiveOnly(
      createHandleParams({
        ...base,
        currentElevatedLevel: sessionEntry.elevatedLevel as ElevatedLevel | undefined,
        directives: parseInlineDirectives("/elevated"),
      }),
    );
    expect(statusReply?.text).toContain("Current elevated level: on");

    const offReply = await handleDirectiveOnly(
      createHandleParams({
        ...base,
        currentElevatedLevel: sessionEntry.elevatedLevel as ElevatedLevel | undefined,
        directives: parseInlineDirectives("/elevated off"),
      }),
    );
    expect(offReply?.text).toContain("Elevated mode disabled");
    expect(sessionEntry.elevatedLevel).toBe("off");
  });

  it("blocks internal operator.write exec persistence in directive-only handling", async () => {
    const directives = parseInlineDirectives(
      "/exec host=node security=allowlist ask=always node=worker-1",
    );
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        gatewayClientScopes: ["operator.write"],
        sessionEntry,
        sessionStore,
        surface: "webchat",
      }),
    );

    expect(result?.text).toContain("operator.admin");
    expect(sessionEntry.execHost).toBeUndefined();
    expect(sessionEntry.execSecurity).toBeUndefined();
    expect(sessionEntry.execAsk).toBeUndefined();
    expect(sessionEntry.execNode).toBeUndefined();
  });

  it("blocks internal operator.write verbose persistence in directive-only handling", async () => {
    const directives = parseInlineDirectives("/verbose full");
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        gatewayClientScopes: ["operator.write"],
        sessionEntry,
        sessionStore,
        surface: "webchat",
      }),
    );

    expect(result?.text).toContain("Verbose logging set for the current reply only.");
    expect(result?.text).toContain("operator.admin");
    expect(sessionEntry.verboseLevel).toBeUndefined();
  });

  it("allows internal operator.admin verbose persistence in directive-only handling", async () => {
    const directives = parseInlineDirectives("/verbose full");
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        gatewayClientScopes: ["operator.admin"],
        sessionEntry,
        sessionStore,
        surface: "webchat",
      }),
    );

    expect(result?.text).toContain("Verbose logging set to full.");
    expect(sessionEntry.verboseLevel).toBe("full");
  });

  it("allows internal operator.admin exec persistence in directive-only handling", async () => {
    const directives = parseInlineDirectives(
      "/exec host=node security=allowlist ask=always node=worker-1",
    );
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        gatewayClientScopes: ["operator.admin"],
        sessionEntry,
        sessionStore,
        surface: "webchat",
      }),
    );

    expect(result?.text).toContain("Exec defaults set");
    expect(sessionEntry.execHost).toBe("node");
    expect(sessionEntry.execSecurity).toBe("allowlist");
    expect(sessionEntry.execAsk).toBe("always");
    expect(sessionEntry.execNode).toBe("worker-1");
  });
});

describe("persistInlineDirectives internal exec scope gate", () => {
  it("skips exec persistence for internal operator.write callers", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(
      "/exec host=node security=allowlist ask=always node=worker-1",
    );

    expect(sessionEntry.execHost).toBeUndefined();
    expect(sessionEntry.execSecurity).toBeUndefined();
    expect(sessionEntry.execAsk).toBeUndefined();
    expect(sessionEntry.execNode).toBeUndefined();
  });

  it("skips verbose persistence for internal operator.write callers", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective("/verbose full");

    expect(sessionEntry.verboseLevel).toBeUndefined();
  });

  it("treats internal provider context as authoritative over external surface metadata", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective("/verbose full", {
      messageProvider: "webchat",
      surface: "telegram",
    });

    expect(sessionEntry.verboseLevel).toBeUndefined();
  });
});
