import { describe, expect, it } from "vitest";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveEffectivePluginActivationState,
  resolveEnableState,
  resolveMemorySlotDecision,
} from "./config-state.js";

function normalizeVoiceCallEntry(entry: Record<string, unknown>) {
  return normalizePluginsConfig({
    entries: {
      "voice-call": entry,
    },
  }).entries["voice-call"];
}

function expectResolvedEnableState(
  params: Parameters<typeof resolveEnableState>,
  expected: ReturnType<typeof resolveEnableState>,
) {
  expect(resolveEnableState(...params)).toEqual(expected);
}

function expectNormalizedEnableState(params: {
  id: string;
  origin: "bundled" | "workspace";
  config: Record<string, unknown>;
  manifestEnabledByDefault?: boolean;
  expected: ReturnType<typeof resolveEnableState>;
}) {
  expectResolvedEnableState(
    [
      params.id,
      params.origin,
      normalizePluginsConfig(params.config),
      params.manifestEnabledByDefault,
    ],
    params.expected,
  );
}

describe("normalizePluginsConfig", () => {
  it.each([
    [{}, "memory-core"],
    [{ slots: { memory: "custom-memory" } }, "custom-memory"],
    [{ slots: { memory: "none" } }, null],
    [{ slots: { memory: "None" } }, null],
    [{ slots: { memory: "  custom-memory  " } }, "custom-memory"],
    [{ slots: { memory: "" } }, "memory-core"],
    [{ slots: { memory: "   " } }, "memory-core"],
  ] as const)("normalizes memory slot for %o", (config, expected) => {
    expect(normalizePluginsConfig(config).slots.memory).toBe(expected);
  });

  it.each([
    {
      entry: {
        hooks: {
          allowPromptInjection: false,
        },
      },
      expectedHooks: {
        allowPromptInjection: false,
      },
      name: "normalizes plugin hook policy flags",
    },
    {
      entry: {
        hooks: {
          allowPromptInjection: "nope",
        } as unknown as { allowPromptInjection: boolean },
      },
      expectedHooks: undefined,
      name: "drops invalid plugin hook policy values",
    },
  ] as const)("$name", ({ entry, expectedHooks }) => {
    expect(normalizeVoiceCallEntry(entry)?.hooks).toEqual(expectedHooks);
  });

  it.each([
    {
      expected: {
        allowModelOverride: true,
        allowedModels: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"],
        hasAllowedModelsConfig: true,
      },
      name: "normalizes plugin subagent override policy settings",
      subagent: {
        allowModelOverride: true,
        allowedModels: [" anthropic/claude-sonnet-4-6 ", "", "openai/gpt-5.4"],
      },
    },
    {
      expected: {
        allowModelOverride: true,
        allowedModels: ["anthropic"],
        hasAllowedModelsConfig: true,
      },
      name: "preserves explicit subagent allowlist intent even when all entries are invalid",
      subagent: {
        allowModelOverride: true,
        allowedModels: [42, null, "anthropic"],
      } as unknown as { allowModelOverride: boolean; allowedModels: string[] },
    },
    {
      expected: {
        hasAllowedModelsConfig: true,
      },
      name: "keeps explicit invalid subagent allowlist config visible to callers",
      subagent: {
        allowModelOverride: "nope",
        allowedModels: [42, null],
      } as unknown as { allowModelOverride: boolean; allowedModels: string[] },
    },
  ] as const)("$name", ({ subagent, expected }) => {
    expect(normalizeVoiceCallEntry({ subagent })?.subagent).toEqual(expected);
  });

  it("normalizes legacy plugin ids to their merged bundled plugin id", () => {
    const result = normalizePluginsConfig({
      allow: ["openai-codex", "google-gemini-cli", "minimax-portal-auth"],
      deny: ["openai-codex", "google-gemini-cli", "minimax-portal-auth"],
      entries: {
        "google-gemini-cli": {
          enabled: true,
        },
        "minimax-portal-auth": {
          enabled: false,
        },
        "openai-codex": {
          enabled: true,
        },
      },
    });

    expect(result.allow).toEqual(["openai", "google", "minimax"]);
    expect(result.deny).toEqual(["openai", "google", "minimax"]);
    expect(result.entries.openai?.enabled).toBe(true);
    expect(result.entries.google?.enabled).toBe(true);
    expect(result.entries.minimax?.enabled).toBe(false);
  });
});

describe("resolveEffectiveEnableState", () => {
  function resolveBundledTelegramState(config: Parameters<typeof normalizePluginsConfig>[0]) {
    const normalized = normalizePluginsConfig(config);
    return resolveEffectiveEnableState({
      config: normalized,
      id: "telegram",
      origin: "bundled",
      rootConfig: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
    });
  }

  function resolveConfigOriginTelegramState(config: Parameters<typeof normalizePluginsConfig>[0]) {
    const normalized = normalizePluginsConfig(config);
    return resolveEffectiveEnableState({
      config: normalized,
      id: "telegram",
      origin: "config",
      rootConfig: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
    });
  }

  it.each([
    [{ enabled: true }, { enabled: true }],
    [{ allow: ["browser"] as string[], enabled: true }, { enabled: true }],
    [
      {
        enabled: true,
        entries: {
          telegram: {
            enabled: false,
          },
        },
      },
      { enabled: false, reason: "disabled in config" },
    ],
  ] as const)("resolves bundled telegram state for %o", (config, expected) => {
    expect(resolveBundledTelegramState(config)).toEqual(expected);
  });

  it("does not bypass allowlists for non-bundled plugins that reuse a channel id", () => {
    expect(
      resolveConfigOriginTelegramState({
        allow: ["browser"] as string[],
        enabled: true,
      }),
    ).toEqual({ enabled: false, reason: "not in allowlist" });
  });
});

describe("resolveEffectivePluginActivationState", () => {
  it("distinguishes explicit enablement from auto activation", () => {
    const rawConfig: NonNullable<
      Parameters<typeof resolveEffectivePluginActivationState>[0]["rootConfig"]
    > = {
      channels: {
        telegram: {
          botToken: "x",
        },
      },
    };
    const effectiveConfig: NonNullable<
      Parameters<typeof resolveEffectivePluginActivationState>[0]["rootConfig"]
    > = {
      channels: {
        telegram: {
          botToken: "x",
          enabled: true,
        },
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        activationSource: createPluginActivationSource({ config: rawConfig }),
        autoEnabledReason: "telegram configured",
        config: normalizePluginsConfig(effectiveConfig.plugins),
        id: "telegram",
        origin: "bundled",
        rootConfig: effectiveConfig,
      }),
    ).toEqual({
      activated: true,
      enabled: true,
      explicitlyEnabled: false,
      reason: "telegram configured",
      source: "auto",
    });
  });

  it("preserves explicit selection even when plugins are globally disabled", () => {
    const rawConfig = {
      plugins: {
        enabled: false,
        entries: {
          browser: {
            enabled: true,
          },
        },
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        activationSource: createPluginActivationSource({ config: rawConfig }),
        config: normalizePluginsConfig(rawConfig.plugins),
        id: "browser",
        origin: "bundled",
        rootConfig: rawConfig,
      }),
    ).toEqual({
      activated: false,
      enabled: false,
      explicitlyEnabled: true,
      reason: "plugins disabled",
      source: "disabled",
    });
  });

  it("marks bundled default-enabled plugins as default activation", () => {
    expect(
      resolveEffectivePluginActivationState({
        config: normalizePluginsConfig({}),
        enabledByDefault: true,
        id: "openai",
        origin: "bundled",
      }),
    ).toEqual({
      activated: true,
      enabled: true,
      explicitlyEnabled: false,
      reason: "bundled default enablement",
      source: "default",
    });
  });

  it("keeps allowlists authoritative over explicit bundled plugin enablement", () => {
    const rawConfig = {
      plugins: {
        allow: ["browser"],
        entries: {
          telegram: {
            enabled: true,
          },
        },
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        activationSource: createPluginActivationSource({ config: rawConfig }),
        config: normalizePluginsConfig(rawConfig.plugins),
        id: "telegram",
        origin: "bundled",
        rootConfig: rawConfig,
      }),
    ).toEqual({
      activated: false,
      enabled: false,
      explicitlyEnabled: true,
      reason: "not in allowlist",
      source: "disabled",
    });
  });

  it("lets explicit bundled channel activation bypass the allowlist", () => {
    const rawConfig = {
      channels: {
        telegram: {
          enabled: true,
        },
      },
      plugins: {
        allow: ["browser"],
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        activationSource: createPluginActivationSource({ config: rawConfig }),
        config: normalizePluginsConfig(rawConfig.plugins),
        id: "telegram",
        origin: "bundled",
        rootConfig: rawConfig,
      }),
    ).toEqual({
      activated: true,
      enabled: true,
      explicitlyEnabled: true,
      reason: "channel enabled in config",
      source: "explicit",
    });
  });

  it("keeps denylist authoritative over explicit bundled channel activation", () => {
    const rawConfig = {
      channels: {
        telegram: {
          enabled: true,
        },
      },
      plugins: {
        deny: ["telegram"],
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        activationSource: createPluginActivationSource({ config: rawConfig }),
        config: normalizePluginsConfig(rawConfig.plugins),
        id: "telegram",
        origin: "bundled",
        rootConfig: rawConfig,
      }),
    ).toEqual({
      activated: false,
      enabled: false,
      explicitlyEnabled: true,
      reason: "blocked by denylist",
      source: "disabled",
    });
  });

  it("does not let auto-enable reasons bypass the allowlist", () => {
    const rawConfig = {
      plugins: {
        allow: ["browser"],
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        activationSource: createPluginActivationSource({ config: rawConfig }),
        autoEnabledReason: "telegram configured",
        config: normalizePluginsConfig(rawConfig.plugins),
        id: "telegram",
        origin: "bundled",
        rootConfig: rawConfig,
      }),
    ).toEqual({
      activated: false,
      enabled: false,
      explicitlyEnabled: false,
      reason: "not in allowlist",
      source: "disabled",
    });
  });

  it("preserves activation when only the effective config enables a bundled plugin", () => {
    const sourceConfig = {
      plugins: {},
    };
    const effectiveConfig = {
      plugins: {
        entries: {
          openai: {
            enabled: true,
          },
        },
      },
    };

    expect(
      resolveEffectivePluginActivationState({
        activationSource: createPluginActivationSource({ config: sourceConfig }),
        config: normalizePluginsConfig(effectiveConfig.plugins),
        id: "openai",
        origin: "bundled",
        rootConfig: effectiveConfig,
      }),
    ).toEqual({
      activated: true,
      enabled: true,
      explicitlyEnabled: false,
      reason: "enabled by effective config",
      source: "auto",
    });
  });
});

describe("resolveEnableState", () => {
  it.each([
    [
      "openai",
      "bundled",
      normalizePluginsConfig({}),
      undefined,
      { enabled: false, reason: "bundled (disabled by default)" },
    ],
    ["openai", "bundled", normalizePluginsConfig({}), true, { enabled: true }],
    ["google", "bundled", normalizePluginsConfig({}), true, { enabled: true }],
    ["profile-aware", "bundled", normalizePluginsConfig({}), true, { enabled: true }],
  ] as const)(
    "resolves %s enable state for origin=%s manifestEnabledByDefault=%s",
    (id, origin, config, manifestEnabledByDefault, expected) => {
      expectResolvedEnableState([id, origin, config, manifestEnabledByDefault], expected);
    },
  );

  it.each([
    {
      config: {
        allow: ["telegram"],
        slots: { memory: "memory-core" },
      },
      expected: { enabled: true },
      name: "keeps the selected memory slot plugin enabled even when omitted from plugins.allow",
    },
    {
      config: {
        allow: ["telegram"],
        entries: {
          "memory-core": {
            enabled: false,
          },
        },
        slots: { memory: "memory-core" },
      },
      expected: { enabled: false, reason: "disabled in config" },
      name: "keeps explicit disable authoritative for the selected memory slot plugin",
    },
  ] as const)("$name", ({ config, expected }) => {
    expectNormalizedEnableState({
      config,
      expected,
      id: "memory-core",
      origin: "bundled",
    });
  });

  it.each([
    [
      normalizePluginsConfig({}),
      {
        enabled: false,
        reason: "workspace plugin (disabled by default)",
      },
    ],
    [
      normalizePluginsConfig({
        allow: ["workspace-helper"],
      }),
      { enabled: true },
    ],
    [
      normalizePluginsConfig({
        entries: {
          "workspace-helper": {
            enabled: true,
          },
        },
      }),
      { enabled: true },
    ],
  ] as const)("resolves workspace-helper enable state for %o", (config, expected) => {
    expect(resolveEnableState("workspace-helper", "workspace", config)).toEqual(expected);
  });

  it("does not let the default memory slot auto-enable an untrusted workspace plugin", () => {
    expectNormalizedEnableState({
      config: {
        slots: { memory: "memory-core" },
      },
      expected: {
        enabled: false,
        reason: "workspace plugin (disabled by default)",
      },
      id: "memory-core",
      origin: "workspace",
    });
  });
});

describe("resolveMemorySlotDecision", () => {
  it("disables a memory-only plugin when slot points elsewhere", () => {
    const result = resolveMemorySlotDecision({
      id: "old-memory",
      kind: "memory",
      selectedId: null,
      slot: "new-memory",
    });
    expect(result.enabled).toBe(false);
  });

  it("keeps a dual-kind plugin enabled when memory slot points elsewhere", () => {
    const result = resolveMemorySlotDecision({
      id: "dual-plugin",
      kind: ["memory", "context-engine"],
      selectedId: null,
      slot: "new-memory",
    });
    expect(result.enabled).toBe(true);
    expect(result.selected).toBeUndefined();
  });

  it("selects a dual-kind plugin when it owns the memory slot", () => {
    const result = resolveMemorySlotDecision({
      id: "dual-plugin",
      kind: ["memory", "context-engine"],
      selectedId: null,
      slot: "dual-plugin",
    });
    expect(result.enabled).toBe(true);
    expect(result.selected).toBe(true);
  });

  it("keeps a dual-kind plugin enabled when memory slot is null", () => {
    const result = resolveMemorySlotDecision({
      id: "dual-plugin",
      kind: ["memory", "context-engine"],
      selectedId: null,
      slot: null,
    });
    expect(result.enabled).toBe(true);
  });

  it("disables a memory-only plugin when memory slot is null", () => {
    const result = resolveMemorySlotDecision({
      id: "old-memory",
      kind: "memory",
      selectedId: null,
      slot: null,
    });
    expect(result.enabled).toBe(false);
  });
});
