import { afterEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { buildChannelSummary } from "./channel-summary.js";

function makeSlackHttpSummaryPlugin(): ChannelPlugin {
  return {
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      defaultAccountId: () => "primary",
      inspectAccount: (cfg) =>
        (cfg as { marker?: string }).marker === "source"
          ? {
              accountId: "primary",
              name: "Primary",
              enabled: true,
              configured: true,
              mode: "http",
              botToken: "xoxb-http",
              signingSecret: "",
              botTokenSource: "config",
              signingSecretSource: "config", // Pragma: allowlist secret
              botTokenStatus: "available",
              signingSecretStatus: "configured_unavailable", // Pragma: allowlist secret
            }
          : {
              accountId: "primary",
              botToken: "xoxb-http",
              botTokenSource: "config",
              botTokenStatus: "available",
              configured: false,
              enabled: true,
              mode: "http",
              name: "Primary",
            },
      isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
      isEnabled: () => true,
      listAccountIds: () => ["primary"],
      resolveAccount: () => ({
        accountId: "primary",
        botToken: "xoxb-http",
        botTokenSource: "config",
        botTokenStatus: "available",
        configured: false,
        enabled: true,
        mode: "http",
        name: "Primary",
      }),
    },
    id: "slack",
    meta: {
      blurb: "test",
      docsPath: "/channels/slack",
      id: "slack",
      label: "Slack",
      selectionLabel: "Slack",
    },
  };
}

function makeTelegramSummaryPlugin(params: {
  enabled: boolean;
  configured: boolean;
  linked?: boolean;
  authAgeMs?: number;
  allowFrom?: string[];
}): ChannelPlugin {
  return {
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      defaultAccountId: () => "primary",
      formatAllowFrom: () => ["alice", "bob", "carol"],
      inspectAccount: () => ({
        accountId: "primary",
        allowFrom: params.allowFrom ?? [],
        configured: params.configured,
        dmPolicy: "mutuals",
        enabled: params.enabled,
        linked: params.linked,
        name: "Main Bot",
        tokenSource: "env",
      }),
      isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
      isEnabled: (account) => Boolean((account as { enabled?: boolean }).enabled),
      listAccountIds: () => ["primary"],
      resolveAccount: () => ({
        accountId: "primary",
        allowFrom: params.allowFrom ?? [],
        configured: params.configured,
        dmPolicy: "mutuals",
        enabled: params.enabled,
        linked: params.linked,
        name: "Main Bot",
        tokenSource: "env",
      }),
    },
    id: "telegram",
    meta: {
      blurb: "test",
      docsPath: "/channels/telegram",
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
    },
    status: {
      buildChannelSummary: async () => ({
        authAgeMs: params.authAgeMs,
        configured: params.configured,
        linked: params.linked,
        self: { e164: "+15551234567" },
      }),
    },
  };
}

function makeSignalSummaryPlugin(params: { enabled: boolean; configured: boolean }): ChannelPlugin {
  return {
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      defaultAccountId: () => "desktop",
      inspectAccount: () => ({
        accountId: "desktop",
        appTokenSource: "env",
        baseUrl: "https://signal.example.test",
        cliPath: "/usr/local/bin/signal-cli",
        configured: params.configured,
        dbPath: "/tmp/signal.db",
        enabled: params.enabled,
        name: "Desktop",
        port: 31337,
      }),
      isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
      isEnabled: (account) => Boolean((account as { enabled?: boolean }).enabled),
      listAccountIds: () => ["desktop"],
      resolveAccount: () => ({
        accountId: "desktop",
        appTokenSource: "env",
        baseUrl: "https://signal.example.test",
        cliPath: "/usr/local/bin/signal-cli",
        configured: params.configured,
        dbPath: "/tmp/signal.db",
        enabled: params.enabled,
        name: "Desktop",
        port: 31337,
      }),
    },
    id: "signal",
    meta: {
      blurb: "test",
      docsPath: "/channels/signal",
      id: "signal",
      label: "Signal",
      selectionLabel: "Signal",
    },
  };
}

function makeFallbackSummaryPlugin(params: {
  configured: boolean;
  enabled: boolean;
  accountIds?: string[];
  defaultAccountId?: string;
}): ChannelPlugin {
  return {
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      defaultAccountId: () => params.defaultAccountId ?? "default",
      inspectAccount: (_cfg, accountId) => ({
        accountId,
        configured: params.configured,
        enabled: params.enabled,
      }),
      isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
      isEnabled: (account) => Boolean((account as { enabled?: boolean }).enabled),
      listAccountIds: () => params.accountIds ?? [],
      resolveAccount: (_cfg, accountId) => ({
        accountId,
        configured: params.configured,
        enabled: params.enabled,
      }),
    },
    id: "fallback-plugin",
    meta: {
      blurb: "test",
      docsPath: "/channels/fallback",
      id: "fallback-plugin",
      label: "Fallback",
      selectionLabel: "Fallback",
    },
  };
}

describe("buildChannelSummary", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("preserves Slack HTTP signing-secret unavailable state from source config", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        { plugin: makeSlackHttpSummaryPlugin(), pluginId: "slack", source: "test" },
      ]),
    );

    const lines = await buildChannelSummary({ channels: {}, marker: "resolved" } as never, {
      colorize: false,
      includeAllowFrom: false,
      sourceConfig: { channels: {}, marker: "source" } as never,
    });

    expect(lines).toContain("Slack: configured");
    expect(lines).toContain(
      "  - primary (Primary) (bot:config, signing:config, secret unavailable in this command path)",
    );
  });

  it("shows disabled status without configured account detail lines", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: makeTelegramSummaryPlugin({ configured: false, enabled: false }),
          pluginId: "telegram",
          source: "test",
        },
      ]),
    );

    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: true,
    });

    expect(lines).toEqual(["Telegram: disabled +15551234567"]);
  });

  it("includes linked summary metadata and truncates allow-from details", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: makeTelegramSummaryPlugin({
            allowFrom: ["alice", "bob", "carol"],
            authAgeMs: 300_000,
            configured: true,
            enabled: true,
            linked: true,
          }),
          pluginId: "telegram",
          source: "test",
        },
      ]),
    );

    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: true,
    });

    expect(lines).toContain("Telegram: linked +15551234567 auth 5m ago");
    expect(lines).toContain("  - primary (Main Bot) (dm:mutuals, token:env, allow:alice,bob)");
  });

  it("shows not-linked status when linked metadata is explicitly false", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: makeTelegramSummaryPlugin({
            configured: true,
            enabled: true,
            linked: false,
          }),
          pluginId: "telegram",
          source: "test",
        },
      ]),
    );

    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
    });

    expect(lines).toContain("Telegram: not linked +15551234567");
    expect(lines).toContain("  - primary (Main Bot) (dm:mutuals, token:env)");
  });

  it("renders non-slack account detail fields for configured accounts", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: makeSignalSummaryPlugin({ configured: true, enabled: false }),
          pluginId: "signal",
          source: "test",
        },
      ]),
    );

    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
    });

    expect(lines).toEqual([
      "Signal: disabled",
      "  - desktop (Desktop) (disabled, app:env, https://signal.example.test, port:31337, cli:/usr/local/bin/signal-cli, db:/tmp/signal.db)",
    ]);
  });

  it("uses the channel label and default account id when no accounts exist", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: makeFallbackSummaryPlugin({
            accountIds: [],
            configured: true,
            defaultAccountId: "fallback-account",
            enabled: true,
          }),
          pluginId: "fallback-plugin",
          source: "test",
        },
      ]),
    );

    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
    });

    expect(lines).toEqual(["Fallback: configured", "  - fallback-account"]);
  });

  it("shows not-configured status when enabled accounts exist without configured ones", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: makeFallbackSummaryPlugin({
            accountIds: ["fallback-account"],
            configured: false,
            enabled: true,
          }),
          pluginId: "fallback-plugin",
          source: "test",
        },
      ]),
    );

    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
    });

    expect(lines).toEqual(["Fallback: not configured"]);
  });
});
