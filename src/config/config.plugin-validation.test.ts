import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { validateConfigObjectWithPlugins } from "./config.js";

vi.unmock("../version.js");

async function chmodSafeDir(dir: string) {
  if (process.platform === "win32") {
    return;
  }
  await fs.chmod(dir, 0o755);
}

async function mkdirSafe(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  await chmodSafeDir(dir);
}

async function writePluginFixture(params: {
  dir: string;
  id: string;
  schema: Record<string, unknown>;
  channels?: string[];
}) {
  await mkdirSafe(params.dir);
  await fs.writeFile(
    path.join(params.dir, "index.js"),
    `export default { id: "${params.id}", register() {} };`,
    "utf8",
  );
  const manifest: Record<string, unknown> = {
    configSchema: params.schema,
    id: params.id,
  };
  if (params.channels) {
    manifest.channels = params.channels;
  }
  await fs.writeFile(
    path.join(params.dir, "openclaw.plugin.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
}

async function writeBundleFixture(params: {
  dir: string;
  format: "codex" | "claude";
  name: string;
}) {
  await mkdirSafe(params.dir);
  const manifestDir = path.join(
    params.dir,
    params.format === "codex" ? ".codex-plugin" : ".claude-plugin",
  );
  await mkdirSafe(manifestDir);
  await fs.writeFile(
    path.join(manifestDir, "plugin.json"),
    JSON.stringify({ name: params.name }, null, 2),
    "utf8",
  );
}

async function writeManifestlessClaudeBundleFixture(params: { dir: string }) {
  await mkdirSafe(params.dir);
  await mkdirSafe(path.join(params.dir, "commands"));
  await fs.writeFile(
    path.join(params.dir, "commands", "review.md"),
    "---\ndescription: fixture\n---\n",
    "utf8",
  );
  await fs.writeFile(path.join(params.dir, "settings.json"), '{"hideThinkingBlock":true}', "utf8");
}

function expectRemovedPluginWarnings(
  result: { ok: boolean; warnings?: { path: string; message: string }[] },
  removedId: string,
  removedLabel: string,
) {
  expect(result.ok).toBe(true);
  if (result.ok) {
    const message = `plugin removed: ${removedLabel} (stale config entry ignored; remove it from plugins config)`;
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        { message, path: `plugins.entries.${removedId}` },
        { message, path: "plugins.allow" },
        { message, path: "plugins.deny" },
        { message, path: "plugins.slots.memory" },
      ]),
    );
  }
}

describe("config plugin validation", () => {
  let fixtureRoot = "";
  let suiteHome = "";
  let badPluginDir = "";
  let enumPluginDir = "";
  let bluebubblesPluginDir = "";
  let googleOverridePluginDir = "";
  let voiceCallSchemaPluginDir = "";
  let bundlePluginDir = "";
  let manifestlessClaudeBundleDir = "";
  const suiteEnv = () =>
    ({
      HOME: suiteHome,
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
      OPENCLAW_HOME: undefined,
      OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: "10000",
      OPENCLAW_STATE_DIR: path.join(suiteHome, ".openclaw"),
      OPENCLAW_VERSION: undefined,
      VITEST: "true",
    }) satisfies NodeJS.ProcessEnv;

  const validateInSuite = (raw: unknown) =>
    validateConfigObjectWithPlugins(raw, { env: suiteEnv() });

  const validateRemovedPluginConfig = (removedId: string) =>
    validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        allow: [removedId],
        deny: [removedId],
        enabled: false,
        entries: { [removedId]: { enabled: true } },
        slots: { memory: removedId },
      },
    });

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-plugin-validation-"));
    await chmodSafeDir(fixtureRoot);
    suiteHome = path.join(fixtureRoot, "home");
    await mkdirSafe(suiteHome);
    badPluginDir = path.join(suiteHome, "bad-plugin");
    enumPluginDir = path.join(suiteHome, "enum-plugin");
    bluebubblesPluginDir = path.join(suiteHome, "bluebubbles-plugin");
    await writePluginFixture({
      dir: badPluginDir,
      id: "bad-plugin",
      schema: {
        additionalProperties: false,
        properties: {
          value: { type: "boolean" },
        },
        required: ["value"],
        type: "object",
      },
    });
    await writePluginFixture({
      dir: enumPluginDir,
      id: "enum-plugin",
      schema: {
        properties: {
          fileFormat: {
            enum: ["markdown", "html"],
            type: "string",
          },
        },
        required: ["fileFormat"],
        type: "object",
      },
    });
    await writePluginFixture({
      channels: ["bluebubbles"],
      dir: bluebubblesPluginDir,
      id: "bluebubbles-plugin",
      schema: { type: "object" },
    });
    googleOverridePluginDir = path.join(suiteHome, "google");
    await writePluginFixture({
      dir: googleOverridePluginDir,
      id: "google",
      schema: {
        properties: {
          apiKey: { type: "string" },
        },
        type: "object",
      },
    });
    bundlePluginDir = path.join(suiteHome, "bundle-plugin");
    await writeBundleFixture({
      dir: bundlePluginDir,
      format: "codex",
      name: "Bundle Fixture",
    });
    manifestlessClaudeBundleDir = path.join(suiteHome, "manifestless-claude-bundle");
    await writeManifestlessClaudeBundleFixture({
      dir: manifestlessClaudeBundleDir,
    });
    voiceCallSchemaPluginDir = path.join(suiteHome, "voice-call-schema-plugin");
    const voiceCallManifestPath = path.join(
      process.cwd(),
      "extensions",
      "voice-call",
      "openclaw.plugin.json",
    );
    const voiceCallManifest = JSON.parse(await fs.readFile(voiceCallManifestPath, "utf8")) as {
      configSchema?: Record<string, unknown>;
    };
    if (!voiceCallManifest.configSchema) {
      throw new Error("voice-call manifest missing configSchema");
    }
    await writePluginFixture({
      dir: voiceCallSchemaPluginDir,
      id: "voice-call-schema-fixture",
      schema: voiceCallManifest.configSchema,
    });
    clearPluginManifestRegistryCache();
    // Warm the plugin manifest cache once so path-based validations can reuse
    // Parsed manifests across test cases.
    validateInSuite({
      plugins: {
        enabled: false,
        load: {
          paths: [
            badPluginDir,
            bluebubblesPluginDir,
            bundlePluginDir,
            manifestlessClaudeBundleDir,
            voiceCallSchemaPluginDir,
          ],
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearPluginManifestRegistryCache();
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { force: true, recursive: true });
    clearPluginManifestRegistryCache();
  });

  it("reports missing plugin refs across load paths, entries, and allowlist surfaces", async () => {
    const missingPath = path.join(suiteHome, "missing-plugin-dir");
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        allow: ["missing-allow"],
        deny: ["missing-deny"],
        enabled: false,
        entries: { "missing-plugin": { enabled: true } },
        load: { paths: [missingPath] },
        slots: { memory: "missing-slot" },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some(
          (issue) =>
            issue.path === "plugins.load.paths" && issue.message.includes("plugin path not found"),
        ),
      ).toBe(true);
      expect(res.issues).toEqual(
        expect.arrayContaining([
          { message: "plugin not found: missing-deny", path: "plugins.deny" },
          { message: "plugin not found: missing-slot", path: "plugins.slots.memory" },
        ]),
      );
      expect(res.warnings).toContainEqual({
        message:
          "plugin not found: missing-allow (stale config entry ignored; remove it from plugins config)",
        path: "plugins.allow",
      });
      expect(res.warnings).toContainEqual({
        message:
          "plugin not found: missing-plugin (stale config entry ignored; remove it from plugins config)",
        path: "plugins.entries.missing-plugin",
      });
    }
  });

  it("does not fail validation for the implicit default memory slot when plugins config is explicit", async () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: { list: [{ id: "pi" }] },
        plugins: {
          entries: { acpx: { enabled: true } },
        },
      },
      {
        env: {
          ...suiteEnv(),
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(suiteHome, "missing-bundled-plugins"),
        },
      },
    );
    expect(res.ok).toBe(true);
  });

  it("warns for removed legacy plugin ids instead of failing validation", async () => {
    const removedId = "google-antigravity-auth";
    const res = validateRemovedPluginConfig(removedId);
    expectRemovedPluginWarnings(res, removedId, removedId);
  });

  it("warns for removed google gemini auth plugin ids instead of failing validation", async () => {
    const removedId = "google-gemini-cli-auth";
    const res = validateRemovedPluginConfig(removedId);
    expectRemovedPluginWarnings(res, removedId, removedId);
  });

  it("does not auto-allow config-loaded overrides of bundled web search plugin ids", async () => {
    const res = validateInSuite({
      plugins: {
        allow: ["bluebubbles", "memory-core"],
        entries: {
          google: {
            config: {
              apiKey: "test-google-key",
            },
          },
        },
        load: {
          paths: [googleOverridePluginDir],
        },
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.warnings).toContainEqual({
      message: expect.stringContaining(
        "plugin google: duplicate plugin id detected; bundled plugin will be overridden by config plugin",
      ),
      path: "plugins.entries.google",
    });
  });

  it("surfaces plugin config diagnostics", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        entries: { "bad-plugin": { config: { value: "nope" } } },
        load: { paths: [badPluginDir] },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const hasIssue = res.issues.some(
        (issue) =>
          issue.path.startsWith("plugins.entries.bad-plugin.config") &&
          issue.message.includes("invalid config"),
      );
      expect(hasIssue).toBe(true);
    }
  });

  it("does not require native config schemas for enabled bundle plugins", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        entries: { "bundle-fixture": { enabled: true } },
        load: { paths: [bundlePluginDir] },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts enabled manifestless Claude bundles without a native schema", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        entries: { "manifestless-claude-bundle": { enabled: true } },
        load: { paths: [manifestlessClaudeBundleDir] },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("surfaces allowed enum values for plugin config diagnostics", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        entries: { "enum-plugin": { config: { fileFormat: "txt" } } },
        load: { paths: [enumPluginDir] },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const issue = res.issues.find(
        (entry) => entry.path === "plugins.entries.enum-plugin.config.fileFormat",
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('allowed: "markdown", "html"');
      expect(issue?.allowedValues).toEqual(["markdown", "html"]);
      expect(issue?.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("accepts voice-call webhookSecurity and streaming guard config fields", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        entries: {
          "voice-call-schema-fixture": {
            config: {
              provider: "twilio",
              staleCallReaperSeconds: 180,
              streaming: {
                enabled: true,
                maxConnections: 64,
                maxPendingConnections: 16,
                maxPendingConnectionsPerIp: 4,
                preStartTimeoutMs: 5000,
              },
              webhookSecurity: {
                allowedHosts: ["voice.example.com"],
                trustForwardingHeaders: false,
                trustedProxyIPs: ["127.0.0.1"],
              },
            },
          },
        },
        load: { paths: [voiceCallSchemaPluginDir] },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts voice-call OpenAI TTS speed, instructions, and baseUrl config fields", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        entries: {
          "voice-call-schema-fixture": {
            config: {
              tts: {
                providers: {
                  openai: {
                    baseUrl: "http://localhost:8880/v1",
                    instructions: "Speak in a cheerful tone",
                    speed: 1.5,
                    voice: "alloy",
                  },
                },
              },
            },
          },
        },
        load: { paths: [voiceCallSchemaPluginDir] },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects out-of-range voice-call OpenAI TTS speed values", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        entries: {
          "voice-call-schema-fixture": {
            config: {
              tts: {
                providers: {
                  openai: {
                    speed: 10,
                  },
                },
              },
            },
          },
        },
        load: { paths: [voiceCallSchemaPluginDir] },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some(
          (issue) =>
            issue.path ===
            "plugins.entries.voice-call-schema-fixture.config.tts.providers.openai.speed",
        ),
      ).toBe(true);
    }
  });

  it("rejects out-of-range voice-call ElevenLabs voice settings", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        entries: {
          "voice-call-schema-fixture": {
            config: {
              tts: {
                providers: {
                  elevenlabs: {
                    voiceSettings: {
                      stability: 5,
                    },
                  },
                },
              },
            },
          },
        },
        load: { paths: [voiceCallSchemaPluginDir] },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some(
          (issue) =>
            issue.path ===
            "plugins.entries.voice-call-schema-fixture.config.tts.providers.elevenlabs.voiceSettings.stability",
        ),
      ).toBe(true);
    }
  });

  it("accepts known plugin ids and valid channel/heartbeat enums", async () => {
    const res = validateInSuite({
      agents: {
        defaults: { heartbeat: { directPolicy: "block", target: "last" } },
        list: [{ heartbeat: { directPolicy: "allow" }, id: "pi" }],
      },
      channels: {
        modelByChannel: {
          openai: {
            whatsapp: "openai/gpt-5.4",
          },
        },
      },
      plugins: { enabled: false, entries: { discord: { enabled: true } } },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts plugin heartbeat targets", async () => {
    const res = validateInSuite({
      agents: { defaults: { heartbeat: { target: "bluebubbles" } }, list: [{ id: "pi" }] },
      plugins: { enabled: false, load: { paths: [bluebubblesPluginDir] } },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown heartbeat targets", async () => {
    const res = validateInSuite({
      agents: {
        defaults: { heartbeat: { target: "not-a-channel" } },
        list: [{ id: "pi" }],
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toContainEqual({
        message: "unknown heartbeat target: not-a-channel",
        path: "agents.defaults.heartbeat.target",
      });
    }
  });

  it("rejects invalid heartbeat directPolicy values", async () => {
    const res = validateInSuite({
      agents: {
        defaults: { heartbeat: { directPolicy: "maybe" } },
        list: [{ id: "pi" }],
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some((issue) => issue.path === "agents.defaults.heartbeat.directPolicy"),
      ).toBe(true);
    }
  });
});
