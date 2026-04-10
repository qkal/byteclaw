import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadModelCatalogMock,
  getModelRefStatusMock,
  normalizeProviderIdMock,
  normalizeModelSelectionMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveHooksGmailModelMock,
} = vi.hoisted(() => ({
  getModelRefStatusMock: vi.fn(),
  loadModelCatalogMock: vi.fn(),
  normalizeModelSelectionMock: vi.fn((value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { primary?: unknown }).primary === "string" &&
      (value as { primary: string }).primary.trim()
    ) {
      return (value as { primary: string }).primary.trim();
    }
    return undefined;
  }),
  normalizeProviderIdMock: vi.fn((value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "",
  ),
  resolveAllowedModelRefMock: vi.fn(),
  resolveConfiguredModelRefMock: vi.fn(),
  resolveHooksGmailModelMock: vi.fn(),
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: loadModelCatalogMock,
}));

vi.mock("../agents/model-selection.js", () => ({
  getModelRefStatus: getModelRefStatusMock,
  normalizeModelSelection: normalizeModelSelectionMock,
  normalizeProviderId: normalizeProviderIdMock,
  resolveAllowedModelRef: resolveAllowedModelRefMock,
  resolveConfiguredModelRef: resolveConfiguredModelRefMock,
  resolveHooksGmailModel: resolveHooksGmailModelMock,
}));

import { resolveCronModelSelection } from "./isolated-agent/model-selection.js";

const DEFAULT_MESSAGE = "do it";
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-opus-4-6";

interface AgentTurnPayload {
  kind: "agentTurn";
  message: string;
  model?: string;
}

interface SelectModelOptions {
  cfg?: Record<string, unknown>;
  agentConfigOverride?: {
    model?: unknown;
    subagents?: {
      model?: unknown;
    };
  };
  payload?: AgentTurnPayload;
  sessionEntry?: {
    modelOverride?: string;
    providerOverride?: string;
  };
  isGmailHook?: boolean;
}

function parseModelRef(raw: string): { provider: string; model: string } | { error: string } {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { error: "invalid model" };
  }

  const providerRaw = trimmed.slice(0, slash).trim().toLowerCase();
  const modelRaw = trimmed.slice(slash + 1).trim();
  if (!providerRaw || !modelRaw) {
    return { error: "invalid model" };
  }

  const provider = providerRaw === "bedrock" ? "amazon-bedrock" : providerRaw;
  const model = provider === "anthropic" && modelRaw === "opus-4.5" ? "claude-opus-4-6" : modelRaw;
  return { model, provider };
}

function resolveConfiguredModelForTest(cfg: Record<string, unknown>): {
  provider: string;
  model: string;
} {
  const modelValue = (cfg.agents as { defaults?: { model?: unknown } } | undefined)?.defaults
    ?.model;
  const rawModel =
    typeof modelValue === "string"
      ? modelValue
      : typeof modelValue === "object" &&
          modelValue &&
          typeof (modelValue as { primary?: unknown }).primary === "string"
        ? (modelValue as { primary: string }).primary
        : undefined;

  if (typeof rawModel === "string") {
    const parsed = parseModelRef(rawModel);
    if (!("error" in parsed)) {
      return parsed;
    }
  }

  return { model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER };
}

function defaultPayload(): AgentTurnPayload {
  return {
    kind: "agentTurn",
    message: DEFAULT_MESSAGE,
  };
}

async function selectModel(options: SelectModelOptions = {}) {
  const cfg = options.cfg ?? {};
  return resolveCronModelSelection({
    agentConfigOverride: options.agentConfigOverride,
    cfg: cfg as never,
    cfgWithAgentDefaults: cfg as never,
    isGmailHook: options.isGmailHook ?? false,
    payload: options.payload ?? defaultPayload(),
    sessionEntry: options.sessionEntry ?? {},
  });
}

async function expectSelectedModel(
  options: SelectModelOptions,
  expected: { provider: string; model: string },
) {
  const result = await selectModel(options);
  expect(result).toEqual({ ok: true, ...expected });
}

async function expectDefaultSelectedModel(options: SelectModelOptions = {}) {
  await expectSelectedModel(options, { model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER });
}

describe("cron model formatting and precedence edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadModelCatalogMock.mockResolvedValue([]);
    getModelRefStatusMock.mockReturnValue({ allowed: false });
    resolveHooksGmailModelMock.mockReturnValue(null);
    resolveConfiguredModelRefMock.mockImplementation(({ cfg }: { cfg?: Record<string, unknown> }) =>
      resolveConfiguredModelForTest(cfg ?? {}),
    );
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const parsed = parseModelRef(raw);
      return "error" in parsed ? parsed : { ref: parsed };
    });
  });

  describe("parseModelRef formatting", () => {
    it("splits standard provider/model", async () => {
      await expectSelectedModel(
        {
          payload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "openai/gpt-4.1-mini" },
        },
        { model: "gpt-4.1-mini", provider: "openai" },
      );
    });

    it("handles leading/trailing whitespace in model string", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "  openai/gpt-4.1-mini  ",
          },
        },
        { model: "gpt-4.1-mini", provider: "openai" },
      );
    });

    it("handles openrouter nested provider paths", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openrouter/meta-llama/llama-3.3-70b:free",
          },
        },
        { model: "meta-llama/llama-3.3-70b:free", provider: "openrouter" },
      );
    });

    it("rejects model with trailing slash (empty model name)", async () => {
      await expect(
        selectModel({
          payload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "openai/" },
        }),
      ).resolves.toEqual({ error: "invalid model", ok: false });
    });

    it("rejects model with leading slash (empty provider)", async () => {
      await expect(
        selectModel({
          payload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "/gpt-4.1-mini" },
        }),
      ).resolves.toEqual({ error: "invalid model", ok: false });
    });

    it("normalizes provider casing", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "OpenAI/gpt-4.1-mini",
          },
        },
        { model: "gpt-4.1-mini", provider: "openai" },
      );
    });

    it("normalizes anthropic model aliases", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "anthropic/opus-4.5",
          },
        },
        { model: "claude-opus-4-6", provider: "anthropic" },
      );
    });

    it("normalizes bedrock provider alias", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "bedrock/claude-sonnet-4-6",
          },
        },
        { model: "claude-sonnet-4-6", provider: "amazon-bedrock" },
      );
    });
  });

  describe("model precedence isolation", () => {
    it("job payload model overrides default (anthropic -> openai)", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openai/gpt-4.1-mini",
          },
        },
        { model: "gpt-4.1-mini", provider: "openai" },
      );
    });

    it("session override applies when no job payload model is present", async () => {
      await expectSelectedModel(
        {
          sessionEntry: {
            modelOverride: "gpt-4.1-mini",
            providerOverride: "openai",
          },
        },
        { model: "gpt-4.1-mini", provider: "openai" },
      );
    });

    it("job payload model wins over conflicting session override", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "anthropic/claude-sonnet-4-6",
          },
          sessionEntry: {
            modelOverride: "gpt-4.1-mini",
            providerOverride: "openai",
          },
        },
        { model: "claude-sonnet-4-6", provider: "anthropic" },
      );
    });

    it("falls through to default when no override is present", async () => {
      await expectDefaultSelectedModel();
    });
  });

  describe("sequential model switches (CI failure regression)", () => {
    it("openai override -> session openai -> job anthropic: each step resolves correctly", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openai/gpt-4.1-mini",
          },
        },
        { model: "gpt-4.1-mini", provider: "openai" },
      );

      await expectSelectedModel(
        {
          sessionEntry: {
            modelOverride: "gpt-4.1-mini",
            providerOverride: "openai",
          },
        },
        { model: "gpt-4.1-mini", provider: "openai" },
      );

      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "anthropic/claude-opus-4-6",
          },
          sessionEntry: {
            modelOverride: "gpt-4.1-mini",
            providerOverride: "openai",
          },
        },
        { model: "claude-opus-4-6", provider: "anthropic" },
      );
    });

    it("provider does not leak between isolated sequential runs", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openai/gpt-4.1-mini",
          },
        },
        { model: "gpt-4.1-mini", provider: "openai" },
      );

      await expectDefaultSelectedModel();
    });
  });

  describe("stored session overrides", () => {
    it("stored modelOverride/providerOverride are applied", async () => {
      await expectSelectedModel(
        {
          sessionEntry: {
            modelOverride: "gpt-4.1-mini",
            providerOverride: "openai",
          },
        },
        { model: "gpt-4.1-mini", provider: "openai" },
      );
    });

    it("default remains when store has no override", async () => {
      await expectDefaultSelectedModel({ sessionEntry: {} });
    });
  });

  describe("whitespace and empty model strings", () => {
    it("whitespace-only model treated as unset (falls to default)", async () => {
      await expectDefaultSelectedModel({
        payload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "   " },
      });
    });

    it("empty string model treated as unset", async () => {
      await expectDefaultSelectedModel({
        payload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "" },
      });
    });

    it("whitespace-only session modelOverride is ignored", async () => {
      await expectDefaultSelectedModel({
        sessionEntry: {
          modelOverride: "   ",
          providerOverride: "openai",
        },
      });
    });
  });

  describe("config model format variations", () => {
    it("default model as string 'provider/model'", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: "openai/gpt-4.1",
              },
            },
          },
        },
        { model: "gpt-4.1", provider: "openai" },
      );
    });

    it("default model as object with primary field", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: { primary: "openai/gpt-4.1" },
              },
            },
          },
        },
        { model: "gpt-4.1", provider: "openai" },
      );
    });

    it("job override switches away from object default", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: { primary: "openai/gpt-4.1" },
              },
            },
          },
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "anthropic/claude-sonnet-4-6",
          },
        },
        { model: "claude-sonnet-4-6", provider: "anthropic" },
      );
    });

    it("uses agents.defaults.subagents.model when set", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: "anthropic/claude-sonnet-4-6",
                subagents: { model: "ollama/llama3.2:3b" },
              },
            },
          },
        },
        { model: "llama3.2:3b", provider: "ollama" },
      );
    });

    it("supports subagents.model with {primary} object format", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: "anthropic/claude-sonnet-4-6",
                subagents: { model: { primary: "google/gemini-2.5-flash" } },
              },
            },
          },
        },
        { model: "gemini-2.5-flash", provider: "google" },
      );
    });

    it("job payload model override takes precedence over subagents.model", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: "anthropic/claude-sonnet-4-6",
                subagents: { model: "ollama/llama3.2:3b" },
              },
            },
          },
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openai/gpt-4o",
          },
        },
        { model: "gpt-4o", provider: "openai" },
      );
    });

    it("prefers the agent model over agents.defaults.subagents.model", async () => {
      await expectSelectedModel(
        {
          agentConfigOverride: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
          cfg: {
            agents: {
              defaults: {
                model: "anthropic/claude-sonnet-4-6",
                subagents: { model: "ollama/llama3.2:3b" },
              },
            },
          },
        },
        { model: "claude-opus-4-6", provider: "anthropic" },
      );
    });
  });
});
