import { describe, expect, it, vi } from "vitest";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import { makeDirectPlugin } from "../../test-utils/channel-plugin-test-fixtures.js";
import { buildChannelsTable } from "./channels.js";

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(),
}));

function makeMattermostPlugin(): ChannelPlugin {
  return {
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      defaultAccountId: () => "echo",
      isConfigured: () => true,
      isEnabled: () => true,
      listAccountIds: () => ["echo"],
      resolveAccount: () => ({
        baseUrl: "https://mm.example.com",
        botToken: "bot-token-value",
        enabled: true,
        name: "Echo",
      }),
    },
    id: "mattermost",
    meta: {
      blurb: "test",
      docsPath: "/channels/mattermost",
      id: "mattermost",
      label: "Mattermost",
      selectionLabel: "Mattermost",
    },
  };
}

type TestTable = Awaited<ReturnType<typeof buildChannelsTable>>;

function makeSlackDirectPlugin(config: ChannelPlugin["config"]): ChannelPlugin {
  return makeDirectPlugin({
    config,
    docsPath: "/channels/slack",
    id: "slack",
    label: "Slack",
  });
}

function createSlackTokenAccount(params?: { botToken?: string; appToken?: string }) {
  return {
    appToken: params?.appToken ?? "app-token",
    botToken: params?.botToken ?? "bot-token",
    enabled: true,
    name: "Primary",
  };
}

function createUnavailableSlackTokenAccount() {
  return {
    appToken: "",
    appTokenSource: "config",
    appTokenStatus: "configured_unavailable",
    botToken: "",
    botTokenSource: "config",
    botTokenStatus: "configured_unavailable",
    configured: true,
    enabled: true,
    name: "Primary",
  };
}

function makeSlackPlugin(params?: { botToken?: string; appToken?: string }): ChannelPlugin {
  return makeSlackDirectPlugin({
    defaultAccountId: () => "primary",
    inspectAccount: () => createSlackTokenAccount(params),
    isConfigured: () => true,
    isEnabled: () => true,
    listAccountIds: () => ["primary"],
    resolveAccount: () => createSlackTokenAccount(params),
  });
}

function makeUnavailableSlackPlugin(): ChannelPlugin {
  return makeSlackDirectPlugin({
    defaultAccountId: () => "primary",
    inspectAccount: () => createUnavailableSlackTokenAccount(),
    isConfigured: () => true,
    isEnabled: () => true,
    listAccountIds: () => ["primary"],
    resolveAccount: () => createUnavailableSlackTokenAccount(),
  });
}

function makeSourceAwareUnavailablePlugin(): ChannelPlugin {
  return makeSlackDirectPlugin({
    defaultAccountId: () => "primary",
    inspectAccount: (cfg) =>
      (cfg as { marker?: string }).marker === "source"
        ? createUnavailableSlackTokenAccount()
        : {
            appToken: "",
            appTokenSource: "none",
            botToken: "",
            botTokenSource: "none",
            configured: false,
            enabled: true,
            name: "Primary",
          },
    isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
    isEnabled: () => true,
    listAccountIds: () => ["primary"],
    resolveAccount: () => ({
      appToken: "",
      botToken: "",
      enabled: true,
      name: "Primary",
    }),
  });
}

function makeSourceUnavailableResolvedAvailablePlugin(): ChannelPlugin {
  return makeDirectPlugin({
    config: {
      defaultAccountId: () => "primary",
      inspectAccount: (cfg) =>
        (cfg as { marker?: string }).marker === "source"
          ? {
              configured: true,
              enabled: true,
              name: "Primary",
              tokenSource: "config",
              tokenStatus: "configured_unavailable",
            }
          : {
              configured: true,
              enabled: true,
              name: "Primary",
              tokenSource: "config",
              tokenStatus: "available",
            },
      isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
      isEnabled: () => true,
      listAccountIds: () => ["primary"],
      resolveAccount: () => ({
        configured: true,
        enabled: true,
        name: "Primary",
        tokenSource: "config",
        tokenStatus: "available",
      }),
    },
    docsPath: "/channels/discord",
    id: "discord",
    label: "Discord",
  });
}

function makeHttpSlackUnavailablePlugin(): ChannelPlugin {
  return makeDirectPlugin({
    config: {
      defaultAccountId: () => "primary",
      inspectAccount: () => ({
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
      }),
      isConfigured: () => true,
      isEnabled: () => true,
      listAccountIds: () => ["primary"],
      resolveAccount: () => ({
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
      }),
    },
    docsPath: "/channels/slack",
    id: "slack",
    label: "Slack",
  });
}

function makeTokenPlugin(): ChannelPlugin {
  return makeDirectPlugin({
    config: {
      defaultAccountId: () => "primary",
      isConfigured: () => true,
      isEnabled: () => true,
      listAccountIds: () => ["primary"],
      resolveAccount: () => ({
        enabled: true,
        name: "Primary",
        token: "token-value",
      }),
    },
    docsPath: "/channels/token-only",
    id: "token-only",
    label: "TokenOnly",
  });
}

async function buildTestTable(
  plugins: ChannelPlugin[],
  params?: { cfg?: Record<string, unknown>; sourceConfig?: Record<string, unknown> },
) {
  vi.mocked(listChannelPlugins).mockReturnValue(plugins);
  return await buildChannelsTable((params?.cfg ?? { channels: {} }) as never, {
    showSecrets: false,
    sourceConfig: params?.sourceConfig as never,
  });
}

function expectTableRow(
  table: TestTable,
  params: { id: string; state: string; detailContains?: string; detailEquals?: string },
) {
  const row = table.rows.find((entry) => entry.id === params.id);
  expect(row).toBeDefined();
  expect(row?.state).toBe(params.state);
  if (params.detailContains) {
    expect(row?.detail).toContain(params.detailContains);
  }
  if (params.detailEquals) {
    expect(row?.detail).toBe(params.detailEquals);
  }
  return row;
}

function expectTableDetailRows(
  table: TestTable,
  title: string,
  rows: Record<string, string>[],
) {
  const detail = table.details.find((entry) => entry.title === title);
  expect(detail).toBeDefined();
  expect(detail?.rows).toEqual(rows);
}

describe("buildChannelsTable - mattermost token summary", () => {
  it("does not require appToken for mattermost accounts", async () => {
    const table = await buildTestTable([makeMattermostPlugin()]);
    const mattermostRow = expectTableRow(table, { id: "mattermost", state: "ok" });
    expect(mattermostRow?.detail).not.toContain("need bot+app");
  });

  it("keeps bot+app requirement when both fields exist", async () => {
    const table = await buildTestTable([makeSlackPlugin({ appToken: "", botToken: "bot-token" })]);
    expectTableRow(table, { detailContains: "need bot+app", id: "slack", state: "warn" });
  });

  it("reports configured-but-unavailable Slack credentials as warn", async () => {
    const table = await buildTestTable([makeUnavailableSlackPlugin()]);
    expectTableRow(table, {
      detailContains: "unavailable in this command path",
      id: "slack",
      state: "warn",
    });
  });

  it("preserves unavailable credential state from the source config snapshot", async () => {
    const table = await buildTestTable([makeSourceAwareUnavailablePlugin()], {
      cfg: { channels: {}, marker: "resolved" },
      sourceConfig: { channels: {}, marker: "source" },
    });

    expectTableRow(table, {
      detailContains: "unavailable in this command path",
      id: "slack",
      state: "warn",
    });
    expectTableDetailRows(table, "Slack accounts", [
      {
        Account: "primary (Primary)",
        Notes: "bot:config · app:config · secret unavailable in this command path",
        Status: "WARN",
      },
    ]);
  });

  it("treats status-only available credentials as resolved", async () => {
    const table = await buildTestTable([makeSourceUnavailableResolvedAvailablePlugin()], {
      cfg: { channels: {}, marker: "resolved" },
      sourceConfig: { channels: {}, marker: "source" },
    });

    expectTableRow(table, { detailEquals: "configured", id: "discord", state: "ok" });
    expectTableDetailRows(table, "Discord accounts", [
      {
        Account: "primary (Primary)",
        Notes: "token:config",
        Status: "OK",
      },
    ]);
  });

  it("treats Slack HTTP signing-secret availability as required config", async () => {
    const table = await buildTestTable([makeHttpSlackUnavailablePlugin()]);
    expectTableRow(table, {
      detailContains: "configured http credentials unavailable",
      id: "slack",
      state: "warn",
    });
    expectTableDetailRows(table, "Slack accounts", [
      {
        Account: "primary (Primary)",
        Notes: "bot:config · signing:config · secret unavailable in this command path",
        Status: "WARN",
      },
    ]);
  });

  it("still reports single-token channels as ok", async () => {
    const table = await buildTestTable([makeTokenPlugin()]);
    expectTableRow(table, { detailContains: "token", id: "token-only", state: "ok" });
  });
});
