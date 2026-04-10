import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginConfigUiHint } from "../plugins/types.js";
import type { WizardPrompter } from "./prompts.js";
import {
  discoverConfigurablePlugins,
  discoverUnconfiguredPlugins,
  setupPluginConfig,
} from "./setup.plugin-config.js";

const loadPluginManifestRegistry = vi.fn();

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

function makeManifestPlugin(
  id: string,
  uiHints?: Record<string, PluginConfigUiHint>,
  configSchema?: Record<string, unknown>,
) {
  return {
    configSchema,
    configUiHints: uiHints,
    enabled: true,
    enabledByDefault: true,
    id,
    name: id,
  };
}

describe("discoverConfigurablePlugins", () => {
  it("returns plugins with non-advanced uiHints", () => {
    const plugins = [
      makeManifestPlugin("openshell", {
        gateway: { help: "Gateway name", label: "Gateway" },
        gpu: { advanced: true, label: "GPU" },
        mode: { help: "Sandbox mode", label: "Mode" },
      }),
    ];
    const result = discoverConfigurablePlugins({ manifestPlugins: plugins });
    expect(result).toHaveLength(1);
    expect(result[0]).toBeDefined();
    expect(result[0].id).toBe("openshell");
    expect(Object.keys(result[0].uiHints)).toEqual(["mode", "gateway"]);
    // Advanced field excluded
    expect(result[0].uiHints.gpu).toBeUndefined();
  });

  it("excludes plugins with no uiHints", () => {
    const plugins = [makeManifestPlugin("bare-plugin")];
    const result = discoverConfigurablePlugins({ manifestPlugins: plugins });
    expect(result).toHaveLength(0);
  });

  it("excludes sensitive fields from promptable hints", () => {
    const plugins = [
      makeManifestPlugin("secret-plugin", {
        apiKey: { label: "API Key", sensitive: true },
        endpoint: { label: "Endpoint" },
      }),
    ];
    const result = discoverConfigurablePlugins({ manifestPlugins: plugins });
    expect(result).toHaveLength(1);
    // Sensitive fields are still included in uiHints for discovery —
    // They are skipped at prompt time, not at discovery time
    expect(result[0].uiHints.endpoint).toBeDefined();
    expect(result[0].uiHints.apiKey).toBeDefined();
  });

  it("excludes plugins where all fields are advanced", () => {
    const plugins = [
      makeManifestPlugin("all-advanced", {
        gpu: { advanced: true, label: "GPU" },
        timeout: { advanced: true, label: "Timeout" },
      }),
    ];
    const result = discoverConfigurablePlugins({ manifestPlugins: plugins });
    expect(result).toHaveLength(0);
  });

  it("sorts results alphabetically by name", () => {
    const plugins = [
      makeManifestPlugin("zeta", { a: { label: "A" } }),
      makeManifestPlugin("alpha", { b: { label: "B" } }),
    ];
    const result = discoverConfigurablePlugins({ manifestPlugins: plugins });
    expect(result.map((p) => p.id)).toEqual(["alpha", "zeta"]);
  });
});

describe("discoverUnconfiguredPlugins", () => {
  it("returns plugins with at least one unconfigured field", () => {
    const plugins = [
      makeManifestPlugin("openshell", {
        gateway: { label: "Gateway" },
        mode: { label: "Mode" },
      }),
    ];
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          openshell: {
            config: { mode: "mirror" },
          },
        },
      },
    };
    const result = discoverUnconfiguredPlugins({
      config,
      manifestPlugins: plugins,
    });
    // Gateway is unconfigured
    expect(result).toHaveLength(1);
    expect(result[0]).toBeDefined();
    expect(result[0].id).toBe("openshell");
  });

  it("excludes plugins where all fields are configured", () => {
    const plugins = [
      makeManifestPlugin("openshell", {
        gateway: { label: "Gateway" },
        mode: { label: "Mode" },
      }),
    ];
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          openshell: {
            config: { gateway: "my-gw", mode: "mirror" },
          },
        },
      },
    };
    const result = discoverUnconfiguredPlugins({
      config,
      manifestPlugins: plugins,
    });
    expect(result).toHaveLength(0);
  });

  it("treats empty string as unconfigured", () => {
    const plugins = [
      makeManifestPlugin("test-plugin", {
        endpoint: { label: "Endpoint" },
      }),
    ];
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "test-plugin": {
            config: { endpoint: "" },
          },
        },
      },
    };
    const result = discoverUnconfiguredPlugins({
      config,
      manifestPlugins: plugins,
    });
    expect(result).toHaveLength(1);
  });

  it("returns empty when no plugins have uiHints", () => {
    const plugins = [makeManifestPlugin("bare")];
    const result = discoverUnconfiguredPlugins({
      config: {},
      manifestPlugins: plugins,
    });
    expect(result).toHaveLength(0);
  });

  it("treats dotted uiHint paths as configured when nested config exists", () => {
    const plugins = [
      makeManifestPlugin(
        "brave",
        {
          "webSearch.mode": { label: "Brave Search Mode" },
        },
        {
          properties: {
            webSearch: {
              properties: {
                mode: {
                  enum: ["web", "llm-context"],
                  type: "string",
                },
              },
              type: "object",
            },
          },
          type: "object",
        },
      ),
    ];
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          brave: {
            config: {
              webSearch: {
                mode: "llm-context",
              },
            },
          },
        },
      },
    };
    const result = discoverUnconfiguredPlugins({
      config,
      manifestPlugins: plugins,
    });
    expect(result).toHaveLength(0);
  });
});

describe("setupPluginConfig", () => {
  it("allows skipping plugin setup from the multiselect prompt", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          ...makeManifestPlugin("device-pairing", {
            enabled: { label: "Enable pairing" },
          }),
          enabledByDefault: true,
        },
      ],
    });

    const note = vi.fn(async () => {});
    const select = vi.fn(async () => {
      throw new Error("select should not run when plugin setup is skipped");
    });
    const text = vi.fn(async () => {
      throw new Error("text should not run when plugin setup is skipped");
    });
    const confirm = vi.fn(async () => {
      throw new Error("confirm should not run when plugin setup is skipped");
    });

    const result = await setupPluginConfig({
      config: {
        plugins: {
          entries: {
            "device-pairing": {
              enabled: true,
            },
          },
        },
      },
      prompter: {
        confirm,
        intro: vi.fn(async () => {}),
        multiselect: vi.fn(async () => ["__skip__"]) as unknown as WizardPrompter["multiselect"],
        note,
        outro: vi.fn(async () => {}),
        progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
        select: select as unknown as WizardPrompter["select"],
        text,
      },
    });

    expect(result).toEqual({
      plugins: {
        entries: {
          "device-pairing": {
            enabled: true,
          },
        },
      },
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("writes dotted uiHint values into nested plugin config", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          ...makeManifestPlugin(
            "brave",
            {
              "webSearch.mode": { label: "Brave Search Mode" },
            },
            {
              additionalProperties: false,
              properties: {
                webSearch: {
                  additionalProperties: false,
                  properties: {
                    mode: {
                      enum: ["web", "llm-context"],
                      type: "string",
                    },
                  },
                  type: "object",
                },
              },
              type: "object",
            },
          ),
          enabledByDefault: true,
        },
      ],
    });

    const result = await setupPluginConfig({
      config: {
        plugins: {
          entries: {
            brave: {
              enabled: true,
            },
          },
        },
      },
      prompter: {
        confirm: vi.fn(async () => true),
        intro: vi.fn(async () => {}),
        multiselect: vi.fn(async () => ["brave"]) as unknown as WizardPrompter["multiselect"],
        note: vi.fn(async () => {}),
        outro: vi.fn(async () => {}),
        progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
        select: vi.fn(async () => "llm-context") as unknown as WizardPrompter["select"],
        text: vi.fn(async () => ""),
      },
    });

    expect(result.plugins?.entries?.brave?.config).toEqual({
      webSearch: {
        mode: "llm-context",
      },
    });
    expect(result.plugins?.entries?.brave?.config?.["webSearch.mode"]).toBeUndefined();
  });

  it("coerces integer schema fields from text input", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        makeManifestPlugin(
          "retry-plugin",
          {
            retries: { label: "Retries" },
          },
          {
            additionalProperties: false,
            properties: {
              retries: {
                type: "integer",
              },
            },
            type: "object",
          },
        ),
      ],
    });

    const result = await setupPluginConfig({
      config: {
        plugins: {
          entries: {
            "retry-plugin": {
              enabled: true,
            },
          },
        },
      },
      prompter: {
        confirm: vi.fn(async () => true),
        intro: vi.fn(async () => {}),
        multiselect: vi.fn(async () => [
          "retry-plugin",
        ]) as unknown as WizardPrompter["multiselect"],
        note: vi.fn(async () => {}),
        outro: vi.fn(async () => {}),
        progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
        select: vi.fn(async () => "") as unknown as WizardPrompter["select"],
        text: vi.fn(async () => "3") as unknown as WizardPrompter["text"],
      },
    });

    expect(result.plugins?.entries?.["retry-plugin"]?.config).toEqual({
      retries: 3,
    });
  });
});
