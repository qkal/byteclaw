import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  capArrayByJsonBytes,
  classifySessionKey,
  deriveSessionTitle,
  listAgentsForGateway,
  listSessionsFromStore,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  parseGroupKey,
  pruneLegacyStoreKeys,
  resolveGatewayModelSupportsImages,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelIdentityRef,
  resolveSessionModelRef,
  resolveSessionStoreKey,
} from "./session-utils.js";

function resolveSyncRealpath(filePath: string): string {
  return fs.realpathSync.native(filePath);
}

function createSymlinkOrSkip(targetPath: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(targetPath, linkPath);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
      return false;
    }
    throw error;
  }
}

function createSingleAgentAvatarConfig(workspace: string): OpenClawConfig {
  return {
    agents: {
      list: [{ default: true, id: "main", identity: { avatar: "avatar-link.png" }, workspace }],
    },
    session: { mainKey: "main" },
  } as OpenClawConfig;
}

function createModelDefaultsConfig(params: {
  primary: string;
  models?: Record<string, Record<string, never>>;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: params.primary },
        models: params.models,
      },
    },
  } as OpenClawConfig;
}

describe("gateway session utils", () => {
  afterEach(() => {
    resetConfigRuntimeState();
  });

  test("capArrayByJsonBytes trims from the front", () => {
    const res = capArrayByJsonBytes(["a", "b", "c"], 10);
    expect(res.items).toEqual(["b", "c"]);
  });

  test("parseGroupKey handles group keys", () => {
    expect(parseGroupKey("discord:group:dev")).toEqual({
      channel: "discord",
      id: "dev",
      kind: "group",
    });
    expect(parseGroupKey("agent:ops:discord:group:dev")).toEqual({
      channel: "discord",
      id: "dev",
      kind: "group",
    });
    expect(parseGroupKey("foo:bar")).toBeNull();
  });

  test("classifySessionKey respects chat type + prefixes", () => {
    expect(classifySessionKey("global")).toBe("global");
    expect(classifySessionKey("unknown")).toBe("unknown");
    expect(classifySessionKey("discord:group:dev")).toBe("group");
    expect(classifySessionKey("main")).toBe("direct");
    const entry = { chatType: "group" } as SessionEntry;
    expect(classifySessionKey("main", entry)).toBe("group");
  });

  test("resolveSessionStoreKey maps main aliases to default agent main", () => {
    const cfg = {
      agents: { list: [{ default: true, id: "ops" }] },
      session: { mainKey: "work" },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "work" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:main" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:MAIN" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "MAIN" })).toBe("agent:ops:work");
  });

  test("resolveSessionStoreKey canonicalizes bare keys to default agent", () => {
    const cfg = {
      agents: { list: [{ default: true, id: "ops" }] },
      session: { mainKey: "main" },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "discord:group:123" })).toBe(
      "agent:ops:discord:group:123",
    );
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:alpha:main" })).toBe(
      "agent:alpha:main",
    );
  });

  test("resolveSessionStoreKey falls back to first list entry when no agent is marked default", () => {
    const cfg = {
      agents: { list: [{ id: "ops" }, { id: "review" }] },
      session: { mainKey: "main" },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:ops:main");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "discord:group:123" })).toBe(
      "agent:ops:discord:group:123",
    );
  });

  test("resolveSessionStoreKey falls back to main when agents.list is missing", () => {
    const cfg = {
      session: { mainKey: "work" },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:main:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "thread-1" })).toBe("agent:main:thread-1");
  });

  test("resolveSessionStoreKey normalizes session key casing", () => {
    const cfg = {
      agents: { list: [{ default: true, id: "ops" }] },
      session: { mainKey: "main" },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "CoP" })).toBe(
      resolveSessionStoreKey({ cfg, sessionKey: "cop" }),
    );
    expect(resolveSessionStoreKey({ cfg, sessionKey: "MySession" })).toBe("agent:ops:mysession");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:CoP" })).toBe("agent:ops:cop");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:alpha:MySession" })).toBe(
      "agent:alpha:mysession",
    );
  });

  test("resolveSessionStoreKey honors global scope", () => {
    const cfg = {
      agents: { list: [{ default: true, id: "ops" }] },
      session: { mainKey: "work", scope: "global" },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("global");
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("global");
    expect(target.agentId).toBe("ops");
  });

  test("resolveGatewaySessionStoreTarget uses canonical key for main alias", () => {
    const storeTemplate = path.join(
      os.tmpdir(),
      "openclaw-session-utils",
      "{agentId}",
      "sessions.json",
    );
    const cfg = {
      agents: { list: [{ default: true, id: "ops" }] },
      session: { mainKey: "main", store: storeTemplate },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("agent:ops:main");
    expect(target.storeKeys).toEqual(expect.arrayContaining(["agent:ops:main", "main"]));
    expect(target.storePath).toBe(path.resolve(storeTemplate.replace("{agentId}", "ops")));
  });

  test("resolveGatewaySessionStoreTarget includes legacy mixed-case store key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-case-"));
    const storePath = path.join(dir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({ "agent:ops:MySession": { sessionId: "s1", updatedAt: 1 } }),
      "utf8",
    );
    const cfg = {
      agents: { list: [{ default: true, id: "ops" }] },
      session: { mainKey: "main", store: storePath },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:ops:mysession" });
    expect(target.canonicalKey).toBe("agent:ops:mysession");
    expect(target.storeKeys).toEqual(
      expect.arrayContaining(["agent:ops:mysession", "agent:ops:MySession"]),
    );
    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    const found = target.storeKeys.some((k) => Boolean(store[k]));
    expect(found).toBe(true);
  });

  test("resolveGatewaySessionStoreTarget includes all case-variant duplicate keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-dupes-"));
    const storePath = path.join(dir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:ops:MySession": { sessionId: "s-mixed", updatedAt: 1 },
        "agent:ops:mysession": { sessionId: "s-lower", updatedAt: 2 },
      }),
      "utf8",
    );
    const cfg = {
      agents: { list: [{ default: true, id: "ops" }] },
      session: { mainKey: "main", store: storePath },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:ops:mysession" });
    expect(target.storeKeys).toEqual(
      expect.arrayContaining(["agent:ops:mysession", "agent:ops:MySession"]),
    );
  });

  test("resolveGatewaySessionStoreTarget finds legacy main alias key when mainKey is customized", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-alias-"));
    const storePath = path.join(dir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({ "agent:ops:MAIN": { sessionId: "s1", updatedAt: 1 } }),
      "utf8",
    );
    const cfg = {
      agents: { list: [{ default: true, id: "ops" }] },
      session: { mainKey: "work", store: storePath },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:ops:main" });
    expect(target.canonicalKey).toBe("agent:ops:work");
    expect(target.storeKeys).toEqual(expect.arrayContaining(["agent:ops:MAIN"]));
  });

  test("resolveGatewaySessionStoreTarget preserves discovered store paths for non-round-tripping agent dirs", async () => {
    await withStateDirEnv("session-utils-discovered-store-", async ({ stateDir }) => {
      const retiredSessionsDir = path.join(stateDir, "agents", "Retired Agent", "sessions");
      fs.mkdirSync(retiredSessionsDir, { recursive: true });
      const retiredStorePath = path.join(retiredSessionsDir, "sessions.json");
      fs.writeFileSync(
        retiredStorePath,
        JSON.stringify({
          "agent:retired-agent:main": { sessionId: "sess-retired", updatedAt: 1 },
        }),
        "utf8",
      );

      const cfg = {
        agents: { list: [{ default: true, id: "main" }] },
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
      } as OpenClawConfig;

      const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:retired-agent:main" });

      expect(target.storePath).toBe(resolveSyncRealpath(retiredStorePath));
    });
  });

  test("loadSessionEntry reads discovered stores from non-round-tripping agent dirs", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-load-entry-", async ({ stateDir }) => {
        const retiredSessionsDir = path.join(stateDir, "agents", "Retired Agent", "sessions");
        fs.mkdirSync(retiredSessionsDir, { recursive: true });
        const retiredStorePath = path.join(retiredSessionsDir, "sessions.json");
        fs.writeFileSync(
          retiredStorePath,
          JSON.stringify({
            "agent:retired-agent:main": { sessionId: "sess-retired", updatedAt: 7 },
          }),
          "utf8",
        );
        const cfg = {
          agents: { list: [{ default: true, id: "main" }] },
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);

        const loaded = loadSessionEntry("agent:retired-agent:main");

        expect(loaded.storePath).toBe(resolveSyncRealpath(retiredStorePath));
        expect(loaded.entry?.sessionId).toBe("sess-retired");
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("loadSessionEntry prefers the freshest duplicate row for a logical key", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-load-entry-freshest-", async ({ stateDir }) => {
        const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
        fs.mkdirSync(sessionsDir, { recursive: true });
        const storePath = path.join(sessionsDir, "sessions.json");
        fs.writeFileSync(
          storePath,
          JSON.stringify(
            {
              "agent:main:MAIN": { sessionId: "sess-fresh", updatedAt: 2 },
              "agent:main:main": { sessionId: "sess-stale", updatedAt: 1 },
            },
            null,
            2,
          ),
          "utf8",
        );
        const cfg = {
          agents: { list: [{ default: true, id: "main" }] },
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);

        const loaded = loadSessionEntry("agent:main:main");

        expect(loaded.entry?.sessionId).toBe("sess-fresh");
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("loadSessionEntry prefers the freshest duplicate row across discovered stores", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-load-entry-cross-store-", async ({ stateDir }) => {
        const canonicalSessionsDir = path.join(stateDir, "agents", "main", "sessions");
        fs.mkdirSync(canonicalSessionsDir, { recursive: true });
        fs.writeFileSync(
          path.join(canonicalSessionsDir, "sessions.json"),
          JSON.stringify(
            {
              "agent:main:MAIN": { sessionId: "sess-canonical-fresh", updatedAt: 1000 },
              "agent:main:main": { sessionId: "sess-canonical-stale", updatedAt: 10 },
            },
            null,
            2,
          ),
          "utf8",
        );

        const discoveredSessionsDir = path.join(stateDir, "agents", "main ", "sessions");
        fs.mkdirSync(discoveredSessionsDir, { recursive: true });
        fs.writeFileSync(
          path.join(discoveredSessionsDir, "sessions.json"),
          JSON.stringify(
            {
              "agent:main:main": { sessionId: "sess-discovered-mid", updatedAt: 500 },
            },
            null,
            2,
          ),
          "utf8",
        );

        const cfg = {
          agents: { list: [{ default: true, id: "main" }] },
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);

        const loaded = loadSessionEntry("agent:main:main");

        expect(loaded.entry?.sessionId).toBe("sess-canonical-fresh");
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("pruneLegacyStoreKeys removes alias and case-variant ghost keys", () => {
    const store: Record<string, unknown> = {
      "agent:ops:MAIN": { sessionId: "legacy-upper", updatedAt: 1 },
      "agent:ops:Main": { sessionId: "legacy-mixed", updatedAt: 2 },
      "agent:ops:main": { sessionId: "legacy-lower", updatedAt: 4 },
      "agent:ops:work": { sessionId: "canonical", updatedAt: 3 },
    };
    pruneLegacyStoreKeys({
      candidates: ["agent:ops:work", "agent:ops:main"],
      canonicalKey: "agent:ops:work",
      store,
    });
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);
  });

  test("migrateAndPruneGatewaySessionStoreKey promotes the freshest duplicate row", () => {
    const cfg = {
      agents: { list: [{ default: true, id: "main" }] },
      session: { mainKey: "main" },
    } as OpenClawConfig;
    const store: Record<string, SessionEntry> = {
      "agent:main:MAIN": {
        sessionId: "sess-fresh",
        updatedAt: 2,
      } as SessionEntry,
      "agent:main:Main": {
        sessionId: "sess-stale",
        updatedAt: 1,
      } as SessionEntry,
    };

    const result = migrateAndPruneGatewaySessionStoreKey({
      cfg,
      key: "agent:main:main",
      store,
    });

    expect(result.primaryKey).toBe("agent:main:main");
    expect(result.entry?.sessionId).toBe("sess-fresh");
    expect(store["agent:main:main"]?.sessionId).toBe("sess-fresh");
    expect(store["agent:main:MAIN"]).toBeUndefined();
    expect(store["agent:main:Main"]).toBeUndefined();
  });

  test("migrateAndPruneGatewaySessionStoreKey replaces a stale canonical row with a fresher duplicate", () => {
    const cfg = {
      agents: { list: [{ default: true, id: "main" }] },
      session: { mainKey: "main" },
    } as OpenClawConfig;
    const store: Record<string, SessionEntry> = {
      "agent:main:MAIN": {
        sessionId: "sess-fresh",
        updatedAt: 2,
      } as SessionEntry,
      "agent:main:main": {
        sessionId: "sess-stale",
        updatedAt: 1,
      } as SessionEntry,
    };

    const result = migrateAndPruneGatewaySessionStoreKey({
      cfg,
      key: "agent:main:main",
      store,
    });

    expect(result.primaryKey).toBe("agent:main:main");
    expect(result.entry?.sessionId).toBe("sess-fresh");
    expect(store["agent:main:main"]?.sessionId).toBe("sess-fresh");
    expect(store["agent:main:MAIN"]).toBeUndefined();
  });

  test("listAgentsForGateway rejects avatar symlink escapes outside workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-avatar-outside-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const outsideFile = path.join(root, "outside.txt");
    fs.writeFileSync(outsideFile, "top-secret", "utf8");
    const linkPath = path.join(workspace, "avatar-link.png");
    if (!createSymlinkOrSkip(outsideFile, linkPath)) {
      return;
    }

    const cfg = createSingleAgentAvatarConfig(workspace);

    const result = listAgentsForGateway(cfg);
    expect(result.agents[0]?.identity?.avatarUrl).toBeUndefined();
  });

  test("listAgentsForGateway allows avatar symlinks that stay inside workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-avatar-inside-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, "avatars"), { recursive: true });
    const targetPath = path.join(workspace, "avatars", "actual.png");
    fs.writeFileSync(targetPath, "avatar", "utf8");
    const linkPath = path.join(workspace, "avatar-link.png");
    if (!createSymlinkOrSkip(targetPath, linkPath)) {
      return;
    }

    const cfg = createSingleAgentAvatarConfig(workspace);

    const result = listAgentsForGateway(cfg);
    expect(result.agents[0]?.identity?.avatarUrl).toBe(
      `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`,
    );
  });

  test("listAgentsForGateway keeps explicit agents.list scope over disk-only agents (scope boundary)", async () => {
    await withStateDirEnv("openclaw-agent-list-scope-", async ({ stateDir }) => {
      fs.mkdirSync(path.join(stateDir, "agents", "main"), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "agents", "codex"), { recursive: true });

      const cfg = {
        agents: { list: [{ default: true, id: "main" }] },
        session: { mainKey: "main" },
      } as OpenClawConfig;

      const { agents } = listAgentsForGateway(cfg);
      expect(agents.map((agent) => agent.id)).toEqual(["main"]);
    });
  });

  test("listAgentsForGateway includes effective workspace + model for default agent", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai-codex/gpt-5.4"],
            primary: "openai/gpt-5.4",
          },
          workspace: "/tmp/default-workspace",
        },
        list: [{ default: true, id: "main" }],
      },
      session: { mainKey: "main" },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg);
    expect(result.agents[0]).toMatchObject({
      id: "main",
      model: {
        fallbacks: ["openai-codex/gpt-5.4"],
        primary: "openai/gpt-5.4",
      },
      workspace: "/tmp/default-workspace",
    });
  });

  test("listAgentsForGateway respects per-agent fallback override (including explicit empty list)", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai-codex/gpt-5.4"],
            primary: "openai/gpt-5.4",
          },
        },
        list: [
          { default: true, id: "main" },
          {
            id: "ops",
            model: {
              fallbacks: [],
              primary: "anthropic/claude-opus-4-6",
            },
          },
        ],
      },
      session: { mainKey: "main" },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg);
    const ops = result.agents.find((agent) => agent.id === "ops");
    expect(ops?.model).toEqual({ primary: "anthropic/claude-opus-4-6" });
  });
});

describe("resolveSessionModelRef", () => {
  test("prefers explicit session overrides ahead of runtime model fields", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      model: "gpt-5.4",
      modelOverride: "claude-opus-4-6",
      modelProvider: "openai-codex",
      providerOverride: "anthropic",
      sessionId: "s1",
      updatedAt: Date.now(),
    });

    expect(resolved).toEqual({ model: "claude-opus-4-6", provider: "anthropic" });
  });

  test("preserves openrouter provider when model contains vendor prefix", () => {
    const cfg = createModelDefaultsConfig({
      primary: "openrouter/minimax/minimax-m2.7",
    });

    const resolved = resolveSessionModelRef(cfg, {
      model: "anthropic/claude-haiku-4.5",
      modelProvider: "openrouter",
      sessionId: "s-or",
      updatedAt: Date.now(),
    });

    expect(resolved).toEqual({
      model: "anthropic/claude-haiku-4.5",
      provider: "openrouter",
    });
  });

  test("falls back to override when runtime model is not recorded yet", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      modelOverride: "openai-codex/gpt-5.4",
      sessionId: "s2",
      updatedAt: Date.now(),
    });

    expect(resolved).toEqual({ model: "gpt-5.4", provider: "openai-codex" });
  });

  test("keeps nested model ids under the stored provider override", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      modelOverride: "moonshotai/kimi-k2.5",
      providerOverride: "nvidia",
      sessionId: "s-nested",
      updatedAt: Date.now(),
    });

    expect(resolved).toEqual({ model: "moonshotai/kimi-k2.5", provider: "nvidia" });
  });

  test("preserves explicit wrapper providers for vendor-prefixed override models", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      model: "openrouter/free",
      modelOverride: "anthropic/claude-haiku-4.5",
      modelProvider: "openrouter",
      providerOverride: "openrouter",
      sessionId: "s-openrouter-override",
      updatedAt: Date.now(),
    });

    expect(resolved).toEqual({
      model: "anthropic/claude-haiku-4.5",
      provider: "openrouter",
    });
  });

  test("strips a duplicated provider prefix from stored overrides", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      modelOverride: "openai-codex/gpt-5.4",
      providerOverride: "openai-codex",
      sessionId: "s-qualified-override",
      updatedAt: Date.now(),
    });

    expect(resolved).toEqual({ model: "gpt-5.4", provider: "openai-codex" });
  });

  test("falls back to resolved provider for unprefixed legacy runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveSessionModelRef(cfg, {
      model: "claude-sonnet-4-6",
      modelProvider: undefined,
      sessionId: "legacy-session",
      updatedAt: Date.now(),
    });

    expect(resolved).toEqual({
      model: "claude-sonnet-4-6",
      provider: "google-gemini-cli",
    });
  });

  test("preserves provider from slash-prefixed model when modelProvider is missing", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveSessionModelRef(cfg, {
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
      sessionId: "slash-model",
      updatedAt: Date.now(),
    });

    expect(resolved).toEqual({ model: "claude-sonnet-4-6", provider: "anthropic" });
  });
});

describe("listSessionsFromStore selected model display", () => {
  test("shows the selected override model even when a fallback runtime model exists", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const result = listSessionsFromStore({
      cfg,
      opts: {},
      store: {
        "agent:main:main": {
          model: "gpt-5.4",
          modelOverride: "claude-opus-4-6",
          modelProvider: "openai-codex",
          providerOverride: "anthropic",
          sessionId: "sess-main",
          updatedAt: Date.now(),
        } as SessionEntry,
      },
      storePath: "/tmp/sessions.json",
    });

    expect(result.sessions[0]?.modelProvider).toBe("anthropic");
    expect(result.sessions[0]?.model).toBe("claude-opus-4-6");
  });
});

describe("resolveSessionModelIdentityRef", () => {
  const resolveLegacyIdentityRef = (
    cfg: OpenClawConfig,
    modelProvider: string | undefined = undefined,
  ) =>
    resolveSessionModelIdentityRef(cfg, {
      model: "claude-sonnet-4-6",
      modelProvider,
      sessionId: "legacy-session",
      updatedAt: Date.now(),
    });

  test("does not inherit default provider for unprefixed legacy runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("infers provider from configured model allowlist when unambiguous", () => {
    const cfg = createModelDefaultsConfig({
      models: {
        "anthropic/claude-sonnet-4-6": {},
      },
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ model: "claude-sonnet-4-6", provider: "anthropic" });
  });

  test("infers provider from configured provider catalogs when allowlist is absent", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });
    cfg.models = {
      providers: {
        "qwen-dashscope": {
          models: [{ id: "qwen-max" }],
        },
      },
    } as unknown as OpenClawConfig["models"];

    const resolved = resolveSessionModelIdentityRef(cfg, {
      model: "qwen-max",
      modelProvider: undefined,
      sessionId: "custom-provider-runtime-model",
      updatedAt: Date.now(),
    });

    expect(resolved).toEqual({ model: "qwen-max", provider: "qwen-dashscope" });
  });

  test("keeps provider unknown when configured models are ambiguous", () => {
    const cfg = createModelDefaultsConfig({
      models: {
        "anthropic/claude-sonnet-4-6": {},
        "minimax/claude-sonnet-4-6": {},
      },
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("keeps provider unknown when configured provider catalog matches are ambiguous", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });
    cfg.models = {
      providers: {
        qwen: {
          models: [{ id: "qwen-max" }],
        },
        "qwen-dashscope": {
          models: [{ id: "qwen-max" }],
        },
      },
    } as unknown as OpenClawConfig["models"];

    const resolved = resolveSessionModelIdentityRef(cfg, {
      model: "qwen-max",
      modelProvider: undefined,
      sessionId: "ambiguous-custom-provider-runtime-model",
      updatedAt: Date.now(),
    });

    expect(resolved).toEqual({ model: "qwen-max" });
  });

  test("preserves provider from slash-prefixed runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveSessionModelIdentityRef(cfg, {
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
      sessionId: "slash-model",
      updatedAt: Date.now(),
    });

    expect(resolved).toEqual({ model: "claude-sonnet-4-6", provider: "anthropic" });
  });

  test("infers wrapper provider for slash-prefixed runtime model when allowlist match is unique", () => {
    const cfg = createModelDefaultsConfig({
      models: {
        "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
      },
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveSessionModelIdentityRef(cfg, {
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
      sessionId: "slash-model",
      updatedAt: Date.now(),
    });

    expect(resolved).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      provider: "vercel-ai-gateway",
    });
  });
});

describe("deriveSessionTitle", () => {
  test("returns undefined for undefined entry", () => {
    expect(deriveSessionTitle(undefined)).toBeUndefined();
  });

  test("prefers displayName when set", () => {
    const entry = {
      displayName: "My Custom Session",
      sessionId: "abc123",
      subject: "Group Chat",
      updatedAt: Date.now(),
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("My Custom Session");
  });

  test("falls back to subject when displayName is missing", () => {
    const entry = {
      sessionId: "abc123",
      subject: "Dev Team Chat",
      updatedAt: Date.now(),
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Dev Team Chat");
  });

  test("uses first user message when displayName and subject missing", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    expect(deriveSessionTitle(entry, "Hello, how are you?")).toBe("Hello, how are you?");
  });

  test("truncates long first user message to 60 chars with ellipsis", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    const longMsg =
      "This is a very long message that exceeds sixty characters and should be truncated appropriately";
    const result = deriveSessionTitle(entry, longMsg);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(60);
    expect(result!.endsWith("…")).toBe(true);
  });

  test("truncates at word boundary when possible", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    const longMsg = "This message has many words and should be truncated at a word boundary nicely";
    const result = deriveSessionTitle(entry, longMsg);
    expect(result).toBeDefined();
    expect(result!.endsWith("…")).toBe(true);
    expect(result!.includes("  ")).toBe(false);
  });

  test("falls back to sessionId prefix with date", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: new Date("2024-03-15T10:30:00Z").getTime(),
    } as SessionEntry;
    const result = deriveSessionTitle(entry);
    expect(result).toBe("abcd1234 (2024-03-15)");
  });

  test("falls back to sessionId prefix without date when updatedAt missing", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: 0,
    } as SessionEntry;
    const result = deriveSessionTitle(entry);
    expect(result).toBe("abcd1234");
  });

  test("trims whitespace from displayName", () => {
    const entry = {
      displayName: "  Padded Name  ",
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Padded Name");
  });

  test("ignores empty displayName and falls through", () => {
    const entry = {
      displayName: "   ",
      sessionId: "abc123",
      subject: "Actual Subject",
      updatedAt: Date.now(),
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Actual Subject");
  });
});

describe("resolveGatewayModelSupportsImages", () => {
  test("keeps Foundry GPT deployments image-capable even when stale catalog metadata says text-only", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        loadGatewayModelCatalog: async () => [
          { id: "gpt-5.4", input: ["text"], name: "GPT-5.4", provider: "microsoft-foundry" },
        ],
        model: "gpt-5.4",
        provider: "microsoft-foundry",
      }),
    ).resolves.toBe(true);
  });

  test("uses the preserved Foundry model name hint for alias deployments with stale text-only input metadata", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        loadGatewayModelCatalog: async () => [
          {
            id: "deployment-gpt5",
            input: ["text"],
            name: "gpt-5.4",
            provider: "microsoft-foundry",
          },
        ],
        model: "deployment-gpt5",
        provider: "microsoft-foundry",
      }),
    ).resolves.toBe(true);
  });

  test("treats claude-cli Claude models as image-capable even when catalog metadata is stale or missing", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        loadGatewayModelCatalog: async () => [
          {
            id: "claude-sonnet-4-6",
            input: ["text"],
            name: "Claude Sonnet 4.6",
            provider: "claude-cli",
          },
        ],
        model: "claude-sonnet-4-6",
        provider: "claude-cli",
      }),
    ).resolves.toBe(true);
  });
});
