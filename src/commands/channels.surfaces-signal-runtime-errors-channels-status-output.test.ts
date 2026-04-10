import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIMessageTestPlugin } from "../../test/helpers/channels/imessage-test-plugin.js";
import { collectStatusIssuesFromLastError } from "../plugin-sdk/status-helpers.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { formatGatewayChannelsStatusLines } from "./channels/status.js";

const signalPlugin = {
  ...createChannelTestPluginBase({ id: "signal" }),
  status: {
    collectStatusIssues: (accounts: Parameters<typeof collectStatusIssuesFromLastError>[1]) =>
      collectStatusIssuesFromLastError("signal", accounts),
  },
};

describe("channels command", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ plugin: signalPlugin, pluginId: "signal", source: "test" }]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("surfaces Signal runtime errors in channels status output", () => {
    const lines = formatGatewayChannelsStatusLines({
      channelAccounts: {
        signal: [
          {
            accountId: "default",
            configured: true,
            enabled: true,
            lastError: "signal-cli unreachable",
            running: false,
          },
        ],
      },
    });
    expect(lines.join("\n")).toMatch(/Warnings:/);
    expect(lines.join("\n")).toMatch(/signal/i);
    expect(lines.join("\n")).toMatch(/Channel error/i);
  });

  it("surfaces iMessage runtime errors in channels status output", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: createIMessageTestPlugin(),
          pluginId: "imessage",
          source: "test",
        },
      ]),
    );
    const lines = formatGatewayChannelsStatusLines({
      channelAccounts: {
        imessage: [
          {
            accountId: "default",
            configured: true,
            enabled: true,
            lastError: "imsg permission denied",
            running: false,
          },
        ],
      },
    });
    expect(lines.join("\n")).toMatch(/Warnings:/);
    expect(lines.join("\n")).toMatch(/imessage/i);
    expect(lines.join("\n")).toMatch(/Channel error/i);
  });
});
