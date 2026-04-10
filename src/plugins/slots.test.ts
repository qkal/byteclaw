import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyExclusiveSlotSelection,
  hasKind,
  kindsEqual,
  normalizeKinds,
  slotKeysForPluginKind,
} from "./slots.js";
import type { PluginKind } from "./types.js";

describe("applyExclusiveSlotSelection", () => {
  const createMemoryConfig = (plugins?: OpenClawConfig["plugins"]): OpenClawConfig => ({
    plugins: {
      ...plugins,
      entries: {
        ...plugins?.entries,
        memory: {
          enabled: true,
          ...plugins?.entries?.memory,
        },
      },
    },
  });

  const runMemorySelection = (config: OpenClawConfig, selectedId = "memory") =>
    applyExclusiveSlotSelection({
      config,
      registry: {
        plugins: [
          { id: "memory-core", kind: "memory" },
          { id: "memory", kind: "memory" },
        ],
      },
      selectedId,
      selectedKind: "memory",
    });

  function expectMemorySelectionState(
    result: ReturnType<typeof applyExclusiveSlotSelection>,
    params: {
      changed: boolean;
      selectedId?: string;
      disabledCompetingPlugin?: boolean;
    },
  ) {
    expect(result.changed).toBe(params.changed);
    if (params.selectedId) {
      expect(result.config.plugins?.slots?.memory).toBe(params.selectedId);
    }
    if (params.disabledCompetingPlugin != null) {
      expect(result.config.plugins?.entries?.["memory-core"]?.enabled).toBe(
        params.disabledCompetingPlugin,
      );
    }
  }

  function expectSelectionWarnings(
    warnings: string[],
    params: {
      contains?: readonly string[];
      excludes?: readonly string[];
    },
  ) {
    if (params.contains?.length) {
      expect(warnings).toEqual(expect.arrayContaining([...params.contains]));
    }
    for (const warning of params.excludes ?? []) {
      expect(warnings).not.toEqual(expect.arrayContaining([warning]));
    }
  }

  function expectUnchangedSelection(result: ReturnType<typeof applyExclusiveSlotSelection>) {
    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(0);
  }

  function buildSelectionRegistry(
    plugins: readonly { id: string; kind?: PluginKind | PluginKind[] }[],
  ) {
    return {
      plugins: [...plugins],
    };
  }

  function expectUnchangedSelectionCase(params: {
    config: OpenClawConfig;
    selectedId: string;
    selectedKind?: PluginKind | PluginKind[];
    registry?: { plugins: readonly { id: string; kind?: PluginKind | PluginKind[] }[] };
  }) {
    const result = applyExclusiveSlotSelection({
      config: params.config,
      selectedId: params.selectedId,
      ...(params.selectedKind ? { selectedKind: params.selectedKind } : {}),
      ...(params.registry
        ? {
            registry: buildSelectionRegistry(params.registry.plugins),
          }
        : {}),
    });

    expectUnchangedSelection(result);
    expect(result.config).toBe(params.config);
  }

  function expectChangedSelectionCase(params: {
    config: OpenClawConfig;
    selectedId?: string;
    expectedDisabled?: boolean;
    warningChecks: {
      contains?: readonly string[];
      excludes?: readonly string[];
    };
  }) {
    const result = runMemorySelection(params.config, params.selectedId);

    expectMemorySelectionState(result, {
      changed: true,
      selectedId: params.selectedId ?? "memory",
      ...(params.expectedDisabled != null
        ? { disabledCompetingPlugin: params.expectedDisabled }
        : {}),
    });
    expectSelectionWarnings(result.warnings, params.warningChecks);
  }

  it.each([
    {
      config: createMemoryConfig({
        entries: { "memory-core": { enabled: true } },
        slots: { memory: "memory-core" },
      }),
      expectedDisabled: false,
      name: "selects the slot and disables other entries for the same kind",
      warningChecks: {
        contains: [
          'Exclusive slot "memory" switched from "memory-core" to "memory".',
          'Disabled other "memory" slot plugins: memory-core.',
        ],
      },
    },
    {
      config: createMemoryConfig(),
      name: "warns when the slot falls back to a default",
      warningChecks: {
        contains: ['Exclusive slot "memory" switched from "memory-core" to "memory".'],
      },
    },
    {
      config: createMemoryConfig({
        entries: {
          "memory-core": { enabled: false },
        },
      }),
      expectedDisabled: false,
      name: "keeps disabled competing plugins disabled without adding disable warnings",
      warningChecks: {
        contains: ['Exclusive slot "memory" switched from "memory-core" to "memory".'],
        excludes: ['Disabled other "memory" slot plugins: memory-core.'],
      },
    },
  ] as const)("$name", ({ config, expectedDisabled, warningChecks }) => {
    expectChangedSelectionCase({
      config,
      ...(expectedDisabled != null ? { expectedDisabled } : {}),
      warningChecks,
    });
  });

  it.each([
    {
      config: createMemoryConfig({
        slots: { memory: "memory" },
      }),
      name: "does nothing when the slot already matches",
      registry: { plugins: [{ id: "memory", kind: "memory" }] },
      selectedId: "memory",
      selectedKind: "memory",
    },
    {
      config: {} as OpenClawConfig,
      name: "skips changes when no exclusive slot applies",
      selectedId: "custom",
    },
  ] as const)("$name", ({ config, selectedId, selectedKind, registry }) => {
    expectUnchangedSelectionCase({
      config,
      selectedId,
      ...(selectedKind ? { selectedKind } : {}),
      ...(registry ? { registry: buildSelectionRegistry(registry.plugins) } : {}),
    });
  });

  it("applies slot selection for each kind in a multi-kind array", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          legacy: { enabled: true },
          "memory-core": { enabled: true },
        },
        slots: { contextEngine: "legacy", memory: "memory-core" },
      },
    };
    const result = applyExclusiveSlotSelection({
      config,
      registry: buildSelectionRegistry([
        { id: "memory-core", kind: "memory" },
        { id: "legacy", kind: "context-engine" },
        { id: "dual-plugin", kind: ["memory", "context-engine"] },
      ]),
      selectedId: "dual-plugin",
      selectedKind: ["memory", "context-engine"],
    });
    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.memory).toBe("dual-plugin");
    expect(result.config.plugins?.slots?.contextEngine).toBe("dual-plugin");
    expect(result.config.plugins?.entries?.["memory-core"]?.enabled).toBe(false);
    expect(result.config.plugins?.entries?.legacy?.enabled).toBe(false);
  });

  it("does not disable a dual-kind plugin that still owns another slot", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "dual-plugin": { enabled: true },
        },
        slots: { contextEngine: "dual-plugin", memory: "dual-plugin" },
      },
    };
    const result = applyExclusiveSlotSelection({
      config,
      registry: buildSelectionRegistry([
        { id: "dual-plugin", kind: ["memory", "context-engine"] },
        { id: "new-memory", kind: "memory" },
      ]),
      selectedId: "new-memory",
      selectedKind: "memory",
    });
    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.memory).toBe("new-memory");
    // Dual-plugin still owns contextEngine — must NOT be disabled
    expect(result.config.plugins?.entries?.["dual-plugin"]?.enabled).not.toBe(false);
  });

  it("does not disable a dual-kind plugin that owns another slot via default", () => {
    // ContextEngine is NOT explicitly set — defaults to "legacy"
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          legacy: { enabled: true },
        },
        slots: { memory: "legacy" },
      },
    };
    const result = applyExclusiveSlotSelection({
      config,
      registry: buildSelectionRegistry([
        { id: "legacy", kind: ["memory", "context-engine"] },
        { id: "new-memory", kind: "memory" },
      ]),
      selectedId: "new-memory",
      selectedKind: "memory",
    });
    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.memory).toBe("new-memory");
    // Legacy still owns contextEngine via default — must NOT be disabled
    expect(result.config.plugins?.entries?.legacy?.enabled).not.toBe(false);
  });
});

describe("normalizeKinds", () => {
  it("returns empty array for undefined", () => {
    expect(normalizeKinds(undefined)).toEqual([]);
  });

  it("wraps a single kind in an array", () => {
    expect(normalizeKinds("memory")).toEqual(["memory"]);
  });

  it("returns an array kind as-is", () => {
    expect(normalizeKinds(["memory", "context-engine"])).toEqual(["memory", "context-engine"]);
  });
});

describe("hasKind", () => {
  it("returns false for undefined kind", () => {
    expect(hasKind(undefined, "memory")).toBe(false);
  });

  it("matches a single kind string", () => {
    expect(hasKind("memory", "memory")).toBe(true);
    expect(hasKind("memory", "context-engine")).toBe(false);
  });

  it("matches within a kind array", () => {
    expect(hasKind(["memory", "context-engine"], "memory")).toBe(true);
    expect(hasKind(["memory", "context-engine"], "context-engine")).toBe(true);
  });
});

describe("slotKeysForPluginKind", () => {
  it("returns empty for undefined", () => {
    expect(slotKeysForPluginKind(undefined)).toEqual([]);
  });

  it("returns single slot key for single kind", () => {
    expect(slotKeysForPluginKind("memory")).toEqual(["memory"]);
  });

  it("returns multiple slot keys for multi-kind", () => {
    expect(slotKeysForPluginKind(["memory", "context-engine"])).toEqual([
      "memory",
      "contextEngine",
    ]);
  });
});

describe("kindsEqual", () => {
  it("treats undefined as equal to undefined", () => {
    expect(kindsEqual(undefined, undefined)).toBe(true);
  });

  it("matches identical strings", () => {
    expect(kindsEqual("memory", "memory")).toBe(true);
  });

  it("rejects different strings", () => {
    expect(kindsEqual("memory", "context-engine")).toBe(false);
  });

  it("matches arrays in different order", () => {
    expect(kindsEqual(["memory", "context-engine"], ["context-engine", "memory"])).toBe(true);
  });

  it("matches string against single-element array", () => {
    expect(kindsEqual("memory", ["memory"])).toBe(true);
  });

  it("rejects mismatched lengths", () => {
    expect(kindsEqual("memory", ["memory", "context-engine"])).toBe(false);
  });
});
