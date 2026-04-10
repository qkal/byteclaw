import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { createOpenClawCodingTools } from "./pi-tools.js";
import type { AnyAgentTool } from "./tools/common.js";

function mockTool(params: {
  name: string;
  label: string;
  description: string;
  displaySummary?: string;
}): AnyAgentTool {
  return {
    ...params,
    execute: async () => ({ text: params.description }),
    parameters: { properties: {}, type: "object" },
  } as unknown as AnyAgentTool;
}

const effectiveInventoryState = vi.hoisted(() => ({
  channelMeta: {} as Record<string, { channelId: string } | undefined>,
  createToolsMock: vi.fn<typeof createOpenClawCodingTools>(
    (_options) =>
      [
        mockTool({ description: "Run shell commands", label: "Exec", name: "exec" }),
        mockTool({ description: "Search docs", label: "Docs Lookup", name: "docs_lookup" }),
      ] as AnyAgentTool[],
  ),
  effectivePolicy: {} as { profile?: string; providerProfile?: string },
  pluginMeta: {} as Record<string, { pluginId: string } | undefined>,
  resolvedModelCompat: undefined as Record<string, unknown> | undefined,
  tools: [
    mockTool({ description: "Run shell commands", label: "Exec", name: "exec" }),
    mockTool({ description: "Search docs", label: "Docs Lookup", name: "docs_lookup" }),
  ] as AnyAgentTool[],
}));

vi.mock("./agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
  return {
    ...actual,
    resolveAgentDir: () => "/tmp/agents/main/agent",
    resolveAgentWorkspaceDir: () => "/tmp/workspace-main",
    resolveSessionAgentId: () => "main",
  };
});

vi.mock("./pi-tools.js", () => ({
  createOpenClawCodingTools: (options?: Parameters<typeof createOpenClawCodingTools>[0]) =>
    effectiveInventoryState.createToolsMock(options),
}));

vi.mock("./pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn(() => ({
    authStorage: {} as never,
    model: effectiveInventoryState.resolvedModelCompat
      ? { compat: effectiveInventoryState.resolvedModelCompat }
      : undefined,
    modelRegistry: {} as never,
  })),
}));

vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: (tool: { name: string }) => effectiveInventoryState.pluginMeta[tool.name],
}));

vi.mock("./channel-tools.js", () => ({
  getChannelAgentToolMeta: (tool: { name: string }) =>
    effectiveInventoryState.channelMeta[tool.name],
}));

vi.mock("./pi-tools.policy.js", () => ({
  resolveEffectiveToolPolicy: () => effectiveInventoryState.effectivePolicy,
}));

let resolveEffectiveToolInventory: typeof import("./tools-effective-inventory.js").resolveEffectiveToolInventory;

async function loadHarness(options?: {
  tools?: AnyAgentTool[];
  createToolsMock?: typeof effectiveInventoryState.createToolsMock;
  pluginMeta?: Record<string, { pluginId: string } | undefined>;
  channelMeta?: Record<string, { channelId: string } | undefined>;
  effectivePolicy?: { profile?: string; providerProfile?: string };
  resolvedModelCompat?: Record<string, unknown>;
}) {
  effectiveInventoryState.tools = options?.tools ?? [
    mockTool({ description: "Run shell commands", label: "Exec", name: "exec" }),
    mockTool({ description: "Search docs", label: "Docs Lookup", name: "docs_lookup" }),
  ];
  effectiveInventoryState.pluginMeta = options?.pluginMeta ?? {};
  effectiveInventoryState.channelMeta = options?.channelMeta ?? {};
  effectiveInventoryState.effectivePolicy = options?.effectivePolicy ?? {};
  effectiveInventoryState.resolvedModelCompat = options?.resolvedModelCompat;
  effectiveInventoryState.createToolsMock =
    options?.createToolsMock ??
    vi.fn<typeof createOpenClawCodingTools>((_options) => effectiveInventoryState.tools);
  return {
    createToolsMock: effectiveInventoryState.createToolsMock,
    resolveEffectiveToolInventory,
  };
}

describe("resolveEffectiveToolInventory", () => {
  beforeAll(async () => {
    ({ resolveEffectiveToolInventory } = await import("./tools-effective-inventory.js"));
  });

  beforeEach(() => {
    effectiveInventoryState.tools = [
      mockTool({ description: "Run shell commands", label: "Exec", name: "exec" }),
      mockTool({ description: "Search docs", label: "Docs Lookup", name: "docs_lookup" }),
    ];
    effectiveInventoryState.pluginMeta = {};
    effectiveInventoryState.channelMeta = {};
    effectiveInventoryState.effectivePolicy = {};
    effectiveInventoryState.resolvedModelCompat = undefined;
    effectiveInventoryState.createToolsMock = vi.fn<typeof createOpenClawCodingTools>(
      (_options) => effectiveInventoryState.tools,
    );
  });

  it("groups core, plugin, and channel tools from the effective runtime set", async () => {
    const { resolveEffectiveToolInventory } = await loadHarness({
      channelMeta: { message_actions: { channelId: "telegram" } },
      pluginMeta: { docs_lookup: { pluginId: "docs" } },
      tools: [
        mockTool({ description: "Run shell commands", label: "Exec", name: "exec" }),
        mockTool({ description: "Search docs", label: "Docs Lookup", name: "docs_lookup" }),
        mockTool({
          description: "Act on messages",
          label: "Message Actions",
          name: "message_actions",
        }),
      ],
    });

    const result = resolveEffectiveToolInventory({ cfg: {} });

    expect(result).toEqual({
      agentId: "main",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              description: "Run shell commands",
              id: "exec",
              label: "Exec",
              rawDescription: "Run shell commands",
              source: "core",
            },
          ],
        },
        {
          id: "plugin",
          label: "Connected tools",
          source: "plugin",
          tools: [
            {
              description: "Search docs",
              id: "docs_lookup",
              label: "Docs Lookup",
              pluginId: "docs",
              rawDescription: "Search docs",
              source: "plugin",
            },
          ],
        },
        {
          id: "channel",
          label: "Channel tools",
          source: "channel",
          tools: [
            {
              channelId: "telegram",
              description: "Act on messages",
              id: "message_actions",
              label: "Message Actions",
              rawDescription: "Act on messages",
              source: "channel",
            },
          ],
        },
      ],
      profile: "full",
    });
  });

  it("disambiguates duplicate labels with source ids", async () => {
    const { resolveEffectiveToolInventory } = await loadHarness({
      pluginMeta: {
        docs_lookup: { pluginId: "docs" },
        jira_lookup: { pluginId: "jira" },
      },
      tools: [
        mockTool({ description: "Search docs", label: "Lookup", name: "docs_lookup" }),
        mockTool({ description: "Search Jira", label: "Lookup", name: "jira_lookup" }),
      ],
    });

    const result = resolveEffectiveToolInventory({ cfg: {} });
    const labels = result.groups.flatMap((group) => group.tools.map((tool) => tool.label));

    expect(labels).toEqual(["Lookup (docs)", "Lookup (jira)"]);
  });

  it("prefers displaySummary over raw description", async () => {
    const { resolveEffectiveToolInventory } = await loadHarness({
      tools: [
        mockTool({
          description: "Long raw description\n\nACTIONS:\n- status",
          displaySummary: "Schedule and manage cron jobs.",
          label: "Cron",
          name: "cron",
        }),
      ],
    });

    const result = resolveEffectiveToolInventory({ cfg: {} });

    expect(result.groups[0]?.tools[0]).toEqual({
      description: "Schedule and manage cron jobs.",
      id: "cron",
      label: "Cron",
      rawDescription: "Long raw description\n\nACTIONS:\n- status",
      source: "core",
    });
  });

  it("falls back to a sanitized summary for multi-line raw descriptions", async () => {
    const { resolveEffectiveToolInventory } = await loadHarness({
      tools: [
        mockTool({
          description:
            'Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and send wake events. Use this for reminders, "check back later" requests, delayed follow-ups, and recurring tasks. Do not emulate scheduling with exec sleep or process polling.\n\nACTIONS:\n- status: Check cron scheduler status\nJOB SCHEMA:\n{ ... }',
          label: "Cron",
          name: "cron",
        }),
      ],
    });

    const result = resolveEffectiveToolInventory({ cfg: {} });

    const description = result.groups[0]?.tools[0]?.description ?? "";
    expect(description).toContain(
      "Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and send wake events.",
    );
    expect(description).toContain("Use this for reminders");
    expect(description.endsWith("...")).toBe(true);
    expect(description.length).toBeLessThanOrEqual(120);
    expect(result.groups[0]?.tools[0]?.rawDescription).toContain("ACTIONS:");
  });

  it("includes the resolved tool profile", async () => {
    const { resolveEffectiveToolInventory } = await loadHarness({
      effectivePolicy: { profile: "minimal", providerProfile: "coding" },
      tools: [mockTool({ description: "Run shell commands", label: "Exec", name: "exec" })],
    });

    const result = resolveEffectiveToolInventory({ cfg: {} });

    expect(result.profile).toBe("coding");
  });

  it("passes resolved model compat into effective tool creation", async () => {
    const createToolsMock = vi.fn<typeof createOpenClawCodingTools>(() => [
      mockTool({ description: "Run shell commands", label: "Exec", name: "exec" }),
    ]);
    const { resolveEffectiveToolInventory } = await loadHarness({
      createToolsMock,
      resolvedModelCompat: { supportsNativeWebSearch: true, supportsTools: true },
    });

    resolveEffectiveToolInventory({
      agentDir: "/tmp/agents/main/agent",
      cfg: {},
      modelId: "grok-test",
      modelProvider: "xai",
    });

    expect(createToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewaySubagentBinding: true,
        modelCompat: { supportsNativeWebSearch: true, supportsTools: true },
      }),
    );
  });
});
