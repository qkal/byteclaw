import { afterEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { makeDirectPlugin } from "../test-utils/channel-plugin-test-fixtures.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { formatConfigChannelsStatusLines } from "./channels/status.js";

function registerSingleTestPlugin(pluginId: string, plugin: ChannelPlugin) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin,
        pluginId,
        source: "test",
      },
    ]),
  );
}

async function formatLocalStatusSummary(
  cfg: unknown,
  options?: {
    sourceConfig?: unknown;
  },
) {
  const lines = await formatConfigChannelsStatusLines(
    cfg as never,
    { mode: "local" },
    options?.sourceConfig ? { sourceConfig: options.sourceConfig as never } : undefined,
  );
  return lines.join("\n");
}

function unresolvedTokenAccount() {
  return {
    configured: true,
    enabled: true,
    name: "Primary",
    token: "",
    tokenSource: "config",
    tokenStatus: "configured_unavailable",
  } as const;
}

function tokenOnlyPluginConfig() {
  return {
    defaultAccountId: () => "primary",
    isConfigured: () => true,
    isEnabled: () => true,
    listAccountIds: () => ["primary"],
  } as const;
}

function makeUnavailableTokenPlugin(): ChannelPlugin {
  return makeDirectPlugin({
    config: {
      ...tokenOnlyPluginConfig(),
      resolveAccount: () => unresolvedTokenAccount(),
    },
    docsPath: "/channels/token-only",
    id: "token-only",
    label: "TokenOnly",
  });
}

function makeResolvedTokenPlugin(): ChannelPlugin {
  return makeDirectPlugin({
    config: {
      ...tokenOnlyPluginConfig(),
      inspectAccount: (cfg) =>
        (cfg as { secretResolved?: boolean }).secretResolved
          ? {
              accountId: "primary",
              configured: true,
              enabled: true,
              name: "Primary",
              token: "resolved-token",
              tokenSource: "config",
              tokenStatus: "available",
            }
          : { accountId: "primary", ...unresolvedTokenAccount() },
      resolveAccount: () => unresolvedTokenAccount(),
    },
    docsPath: "/channels/token-only",
    id: "token-only",
    label: "TokenOnly",
  });
}

function makeResolvedTokenPluginWithoutInspectAccount(): ChannelPlugin {
  return {
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      defaultAccountId: () => "primary",
      isConfigured: () => true,
      isEnabled: () => true,
      listAccountIds: () => ["primary"],
      resolveAccount: (cfg) => {
        if (!(cfg as { secretResolved?: boolean }).secretResolved) {
          throw new Error("raw SecretRef reached resolveAccount");
        }
        return {
          configured: true,
          enabled: true,
          name: "Primary",
          token: "resolved-token",
          tokenSource: "config",
          tokenStatus: "available",
        };
      },
    },
    id: "token-only",
    meta: {
      blurb: "test",
      docsPath: "/channels/token-only",
      id: "token-only",
      label: "TokenOnly",
      selectionLabel: "TokenOnly",
    },
  };
}

function makeUnavailableHttpSlackPlugin(): ChannelPlugin {
  return makeDirectPlugin({
    config: {
      defaultAccountId: () => "primary",
      inspectAccount: () => ({
        accountId: "primary",
        name: "Primary",
        enabled: true,
        configured: true,
        mode: "http",
        botToken: "resolved-bot",
        botTokenSource: "config",
        botTokenStatus: "available",
        signingSecret: "",
        signingSecretSource: "config", // Pragma: allowlist secret
        signingSecretStatus: "configured_unavailable", // Pragma: allowlist secret
      }),
      isConfigured: () => true,
      isEnabled: () => true,
      listAccountIds: () => ["primary"],
      resolveAccount: () => ({
        configured: true,
        enabled: true,
        name: "Primary",
      }),
    },
    docsPath: "/channels/slack",
    id: "slack",
    label: "Slack",
  });
}

function expectResolvedTokenStatusSummary(
  summary: string,
  options?: { includeUnavailableTokenLine?: boolean },
) {
  expect(summary).toContain("TokenOnly");
  expect(summary).toContain("configured");
  expect(summary).toContain("token:config");
  expect(summary).not.toContain("secret unavailable in this command path");
  if (options?.includeUnavailableTokenLine === false) {
    expect(summary).not.toContain("token:config (unavailable)");
  }
}

describe("config-only channels status output", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("shows configured-but-unavailable credentials distinctly from not configured", async () => {
    registerSingleTestPlugin("token-only", makeUnavailableTokenPlugin());

    const joined = await formatLocalStatusSummary({ channels: {} });
    expect(joined).toContain("TokenOnly");
    expect(joined).toContain("TokenOnly primary");
    expect(joined).toContain("configured, secret unavailable in this command path");
    expect(joined).toContain("token:config (unavailable)");
  });

  it("prefers resolved config snapshots when command-local secret resolution succeeds", async () => {
    registerSingleTestPlugin("token-only", makeResolvedTokenPlugin());

    const joined = await formatLocalStatusSummary(
      { channels: {}, secretResolved: true },
      {
        sourceConfig: { channels: {} },
      },
    );
    expectResolvedTokenStatusSummary(joined, { includeUnavailableTokenLine: false });
  });

  it("does not resolve raw source config for extension channels without inspectAccount", async () => {
    registerSingleTestPlugin("token-only", makeResolvedTokenPluginWithoutInspectAccount());

    const joined = await formatLocalStatusSummary(
      { channels: {}, secretResolved: true },
      {
        sourceConfig: { channels: {} },
      },
    );
    expectResolvedTokenStatusSummary(joined);
  });

  it("renders Slack HTTP signing-secret availability in config-only status", async () => {
    registerSingleTestPlugin("slack", makeUnavailableHttpSlackPlugin());

    const joined = await formatLocalStatusSummary({ channels: {} });
    expect(joined).toContain("Slack");
    expect(joined).toContain("configured, secret unavailable in this command path");
    expect(joined).toContain("mode:http");
    expect(joined).toContain("bot:config");
    expect(joined).toContain("signing:config (unavailable)");
  });
});
