import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { PluginManifestRecord } from "../../../plugins/manifest-registry.js";
import * as manifestRegistry from "../../../plugins/manifest-registry.js";
import {
  collectStalePluginConfigWarnings,
  maybeRepairStalePluginConfig,
  scanStalePluginConfig,
} from "./stale-plugin-config.js";

function manifest(id: string): PluginManifestRecord {
  return {
    channels: [],
    cliBackends: [],
    hooks: [],
    id,
    manifestPath: `/plugins/${id}/openclaw.plugin.json`,
    origin: "bundled",
    providers: [],
    rootDir: `/plugins/${id}`,
    skills: [],
    source: `/plugins/${id}`,
  };
}

describe("doctor stale plugin config helpers", () => {
  beforeEach(() => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      diagnostics: [],
      plugins: [manifest("discord"), manifest("voice-call"), manifest("openai")],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds stale plugins.allow and plugins.entries refs", () => {
    const hits = scanStalePluginConfig({
      plugins: {
        allow: ["discord", "acpx"],
        entries: {
          acpx: { enabled: true },
          "voice-call": { enabled: true },
        },
      },
    } as OpenClawConfig);

    expect(hits).toEqual([
      {
        pathLabel: "plugins.allow",
        pluginId: "acpx",
        surface: "allow",
      },
      {
        pathLabel: "plugins.entries.acpx",
        pluginId: "acpx",
        surface: "entries",
      },
    ]);
  });

  it("removes stale plugin ids from allow and entries without changing valid refs", () => {
    const result = maybeRepairStalePluginConfig({
      plugins: {
        allow: ["discord", "acpx", "voice-call"],
        entries: {
          acpx: { enabled: true },
          "voice-call": { enabled: true },
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- plugins.allow: removed 1 stale plugin id (acpx)",
      "- plugins.entries: removed 1 stale plugin entry (acpx)",
    ]);
    expect(result.config.plugins?.allow).toEqual(["discord", "voice-call"]);
    expect(result.config.plugins?.entries).toEqual({
      "voice-call": { enabled: true },
    });
  });

  it("formats stale plugin warnings with a doctor hint", () => {
    const warnings = collectStalePluginConfigWarnings({
      doctorFixCommand: "openclaw doctor --fix",
      hits: [
        {
          pathLabel: "plugins.allow",
          pluginId: "acpx",
          surface: "allow",
        },
      ],
    });

    expect(warnings).toEqual([
      expect.stringContaining('plugins.allow: stale plugin reference "acpx"'),
      expect.stringContaining('Run "openclaw doctor --fix"'),
    ]);
  });

  it("does not auto-repair stale refs while plugin discovery has errors", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      diagnostics: [
        { level: "error", message: "plugin path not found: /missing", source: "/missing" },
      ],
      plugins: [],
    });

    const cfg = {
      plugins: {
        allow: ["acpx"],
        entries: {
          acpx: { enabled: true },
        },
      },
    } as OpenClawConfig;

    const hits = scanStalePluginConfig(cfg);
    expect(hits).toEqual([
      {
        pathLabel: "plugins.allow",
        pluginId: "acpx",
        surface: "allow",
      },
      {
        pathLabel: "plugins.entries.acpx",
        pluginId: "acpx",
        surface: "entries",
      },
    ]);

    const result = maybeRepairStalePluginConfig(cfg);
    expect(result.changes).toEqual([]);
    expect(result.config).toEqual(cfg);

    const warnings = collectStalePluginConfigWarnings({
      autoRepairBlocked: true,
      doctorFixCommand: "openclaw doctor --fix",
      hits,
    });
    expect(warnings[2]).toContain("Auto-removal is paused");
  });

  it("treats legacy plugin aliases as valid ids during scan and repair", () => {
    const cfg = {
      plugins: {
        allow: ["openai-codex", "acpx"],
        entries: {
          acpx: { enabled: true },
          "openai-codex": { enabled: true },
        },
      },
    } as OpenClawConfig;

    expect(scanStalePluginConfig(cfg)).toEqual([
      {
        pathLabel: "plugins.allow",
        pluginId: "openai-codex",
        surface: "allow",
      },
      {
        pathLabel: "plugins.allow",
        pluginId: "acpx",
        surface: "allow",
      },
      {
        pathLabel: "plugins.entries.openai-codex",
        pluginId: "openai-codex",
        surface: "entries",
      },
      {
        pathLabel: "plugins.entries.acpx",
        pluginId: "acpx",
        surface: "entries",
      },
    ]);

    const result = maybeRepairStalePluginConfig(cfg);
    expect(result.config.plugins?.allow).toEqual([]);
    expect(result.config.plugins?.entries).toEqual({});
  });
});
