import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createIMessageTestPlugin } from "../../test/helpers/channels/imessage-test-plugin.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  extractHookToken,
  isHookAgentAllowed,
  normalizeAgentPayload,
  normalizeHookDispatchSessionKey,
  normalizeWakePayload,
  resolveHookSessionKey,
  resolveHookTargetAgentId,
  resolveHooksConfig,
} from "./hooks.js";

const createDemoAliasPlugin = () => ({
  ...createChannelTestPluginBase({
    docsPath: "/channels/demo-alias-channel",
    id: "demo-alias-channel",
    label: "Demo Alias Channel",
  }),
  meta: {
    ...createChannelTestPluginBase({
      docsPath: "/channels/demo-alias-channel",
      id: "demo-alias-channel",
      label: "Demo Alias Channel",
    }).meta,
    aliases: ["workspace-chat"],
  },
});

describe("gateway hooks helpers", () => {
  const resolveHooksConfigOrThrow = (cfg: OpenClawConfig) => {
    const resolved = resolveHooksConfig(cfg);
    expect(resolved).not.toBeNull();
    if (!resolved) {
      throw new Error("hooks config missing");
    }
    return resolved;
  };

  const buildHookAgentConfig = (allowedAgentIds: string[]) =>
    ({
      agents: {
        list: [{ default: true, id: "main" }, { id: "hooks" }],
      },
      hooks: {
        allowedAgentIds,
        enabled: true,
        token: "secret",
      },
    }) as OpenClawConfig;

  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });
  test("resolveHooksConfig normalizes paths + requires token", () => {
    const base = {
      hooks: {
        enabled: true,
        path: "hooks///",
        token: "secret",
      },
    } as OpenClawConfig;
    const resolved = resolveHooksConfig(base);
    expect(resolved?.basePath).toBe("/hooks");
    expect(resolved?.token).toBe("secret");
    expect(resolved?.sessionPolicy.allowRequestSessionKey).toBe(false);
  });

  test("resolveHooksConfig rejects root path", () => {
    const cfg = {
      hooks: { enabled: true, path: "/", token: "x" },
    } as OpenClawConfig;
    expect(() => resolveHooksConfig(cfg)).toThrow("hooks.path may not be '/'");
  });

  test("extractHookToken prefers bearer > header", () => {
    const req = {
      headers: {
        authorization: "Bearer top",
        "x-openclaw-token": "header",
      },
    } as unknown as IncomingMessage;
    const result1 = extractHookToken(req);
    expect(result1).toBe("top");

    const req2 = {
      headers: { "x-openclaw-token": "header" },
    } as unknown as IncomingMessage;
    const result2 = extractHookToken(req2);
    expect(result2).toBe("header");

    const req3 = { headers: {} } as unknown as IncomingMessage;
    const result3 = extractHookToken(req3);
    expect(result3).toBeUndefined();
  });

  test("normalizeWakePayload trims + validates", () => {
    expect(normalizeWakePayload({ text: "  hi " })).toEqual({
      ok: true,
      value: { mode: "now", text: "hi" },
    });
    expect(normalizeWakePayload({ mode: "now", text: "  " }).ok).toBe(false);
  });

  test("normalizeAgentPayload defaults + validates channel", () => {
    const ok = normalizeAgentPayload({ message: "hello" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.sessionKey).toBeUndefined();
      expect(ok.value.channel).toBe("last");
      expect(ok.value.name).toBe("Hook");
      expect(ok.value.deliver).toBe(true);
    }

    const explicitNoDeliver = normalizeAgentPayload({ deliver: false, message: "hello" });
    expect(explicitNoDeliver.ok).toBe(true);
    if (explicitNoDeliver.ok) {
      expect(explicitNoDeliver.value.deliver).toBe(false);
    }

    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: createIMessageTestPlugin(),
          pluginId: "imessage",
          source: "test",
        },
      ]),
    );
    const imsg = normalizeAgentPayload({ channel: "imsg", message: "yo" });
    expect(imsg.ok).toBe(true);
    if (imsg.ok) {
      expect(imsg.value.channel).toBe("imessage");
    }

    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: createDemoAliasPlugin(),
          pluginId: "demo-alias-channel",
          source: "test",
        },
      ]),
    );
    const aliasChannel = normalizeAgentPayload({ channel: "workspace-chat", message: "yo" });
    expect(aliasChannel.ok).toBe(true);
    if (aliasChannel.ok) {
      expect(aliasChannel.value.channel).toBe("demo-alias-channel");
    }

    const bad = normalizeAgentPayload({ channel: "sms", message: "yo" });
    expect(bad.ok).toBe(false);
  });

  test("normalizeAgentPayload passes agentId", () => {
    const ok = normalizeAgentPayload({ agentId: "hooks", message: "hello" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.agentId).toBe("hooks");
    }

    const noAgent = normalizeAgentPayload({ message: "hello" });
    expect(noAgent.ok).toBe(true);
    if (noAgent.ok) {
      expect(noAgent.value.agentId).toBeUndefined();
    }
  });

  test("resolveHookTargetAgentId falls back to default for unknown agent ids", () => {
    const cfg = {
      agents: {
        list: [{ default: true, id: "main" }, { id: "hooks" }],
      },
      hooks: { enabled: true, token: "secret" },
    } as OpenClawConfig;
    const resolved = resolveHooksConfig(cfg);
    expect(resolved).not.toBeNull();
    if (!resolved) {
      return;
    }
    expect(resolveHookTargetAgentId(resolved, "hooks")).toBe("hooks");
    expect(resolveHookTargetAgentId(resolved, "missing-agent")).toBe("main");
    expect(resolveHookTargetAgentId(resolved, undefined)).toBeUndefined();
  });

  test("isHookAgentAllowed honors hooks.allowedAgentIds for explicit routing", () => {
    const resolved = resolveHooksConfigOrThrow(buildHookAgentConfig(["hooks"]));
    expect(isHookAgentAllowed(resolved, undefined)).toBe(true);
    expect(isHookAgentAllowed(resolved, "hooks")).toBe(true);
    expect(isHookAgentAllowed(resolved, "missing-agent")).toBe(false);
  });

  test("isHookAgentAllowed treats empty allowlist as deny-all for explicit agentId", () => {
    const resolved = resolveHooksConfigOrThrow(buildHookAgentConfig([]));
    expect(isHookAgentAllowed(resolved, undefined)).toBe(true);
    expect(isHookAgentAllowed(resolved, "hooks")).toBe(false);
    expect(isHookAgentAllowed(resolved, "main")).toBe(false);
  });

  test("isHookAgentAllowed treats wildcard allowlist as allow-all", () => {
    const resolved = resolveHooksConfigOrThrow(buildHookAgentConfig(["*"]));
    expect(isHookAgentAllowed(resolved, undefined)).toBe(true);
    expect(isHookAgentAllowed(resolved, "hooks")).toBe(true);
    expect(isHookAgentAllowed(resolved, "missing-agent")).toBe(true);
  });

  test("resolveHookSessionKey disables request sessionKey by default", () => {
    const cfg = {
      hooks: { enabled: true, token: "secret" },
    } as OpenClawConfig;
    const resolved = resolveHooksConfig(cfg);
    expect(resolved).not.toBeNull();
    if (!resolved) {
      return;
    }
    const denied = resolveHookSessionKey({
      hooksConfig: resolved,
      sessionKey: "agent:main:dm:u99999",
      source: "request",
    });
    expect(denied.ok).toBe(false);
  });

  test("resolveHookSessionKey allows request sessionKey when explicitly enabled", () => {
    const cfg = {
      hooks: { allowRequestSessionKey: true, enabled: true, token: "secret" },
    } as OpenClawConfig;
    const resolved = resolveHooksConfig(cfg);
    expect(resolved).not.toBeNull();
    if (!resolved) {
      return;
    }
    const allowed = resolveHookSessionKey({
      hooksConfig: resolved,
      sessionKey: "hook:manual",
      source: "request",
    });
    expect(allowed).toEqual({ ok: true, value: "hook:manual" });
  });

  test("resolveHookSessionKey enforces allowed prefixes", () => {
    const cfg = {
      hooks: {
        allowRequestSessionKey: true,
        allowedSessionKeyPrefixes: ["hook:"],
        enabled: true,
        token: "secret",
      },
    } as OpenClawConfig;
    const resolved = resolveHooksConfig(cfg);
    expect(resolved).not.toBeNull();
    if (!resolved) {
      return;
    }

    const blocked = resolveHookSessionKey({
      hooksConfig: resolved,
      sessionKey: "agent:main:main",
      source: "request",
    });
    expect(blocked.ok).toBe(false);

    const allowed = resolveHookSessionKey({
      hooksConfig: resolved,
      sessionKey: "hook:gmail:1",
      source: "mapping",
    });
    expect(allowed).toEqual({ ok: true, value: "hook:gmail:1" });
  });

  test("resolveHookSessionKey uses defaultSessionKey when request key is absent", () => {
    const cfg = {
      hooks: {
        defaultSessionKey: "hook:ingress",
        enabled: true,
        token: "secret",
      },
    } as OpenClawConfig;
    const resolved = resolveHooksConfig(cfg);
    expect(resolved).not.toBeNull();
    if (!resolved) {
      return;
    }

    const resolvedKey = resolveHookSessionKey({
      hooksConfig: resolved,
      source: "request",
    });
    expect(resolvedKey).toEqual({ ok: true, value: "hook:ingress" });
  });

  test("normalizeHookDispatchSessionKey preserves target agent scope", () => {
    expect(
      normalizeHookDispatchSessionKey({
        sessionKey: "agent:hooks:slack:channel:c123",
        targetAgentId: "hooks",
      }),
    ).toBe("agent:hooks:slack:channel:c123");
  });

  test("normalizeHookDispatchSessionKey rebinds non-target agent scoped keys to the target agent", () => {
    expect(
      normalizeHookDispatchSessionKey({
        sessionKey: "agent:main:slack:channel:c123",
        targetAgentId: "hooks",
      }),
    ).toBe("agent:hooks:slack:channel:c123");
  });

  test("resolveHooksConfig validates defaultSessionKey and generated fallback against prefixes", () => {
    expect(() =>
      resolveHooksConfig({
        hooks: {
          allowedSessionKeyPrefixes: ["hook:"],
          defaultSessionKey: "agent:main:main",
          enabled: true,
          token: "secret",
        },
      } as OpenClawConfig),
    ).toThrow("hooks.defaultSessionKey must match hooks.allowedSessionKeyPrefixes");

    expect(() =>
      resolveHooksConfig({
        hooks: {
          allowedSessionKeyPrefixes: ["agent:"],
          enabled: true,
          token: "secret",
        },
      } as OpenClawConfig),
    ).toThrow(
      "hooks.allowedSessionKeyPrefixes must include 'hook:' when hooks.defaultSessionKey is unset",
    );
  });
});

const emptyRegistry = createTestRegistry([]);
