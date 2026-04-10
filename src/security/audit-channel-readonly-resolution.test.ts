import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { collectChannelSecurityFindings } from "./audit-channel.js";

function stubChannelPlugin(params: {
  id: "zalouser";
  label: string;
  resolveAccount: (cfg: OpenClawConfig, accountId: string | null | undefined) => unknown;
}): ChannelPlugin {
  return {
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    config: {
      isConfigured: () => true,
      isEnabled: () => true,
      listAccountIds: () => ["default"],
      resolveAccount: (cfg, accountId) => params.resolveAccount(cfg, accountId),
    },
    id: params.id,
    meta: {
      blurb: "test stub",
      docsPath: "/docs/testing",
      id: params.id,
      label: params.label,
      selectionLabel: params.label,
    },
    security: {},
  };
}

describe("security audit channel read-only resolution", () => {
  it("adds a read-only resolution warning when channel account resolveAccount throws", async () => {
    const plugin = stubChannelPlugin({
      id: "zalouser",
      label: "Zalo Personal",
      resolveAccount: () => {
        throw new Error("missing SecretRef");
      },
    });

    const cfg: OpenClawConfig = {
      channels: {
        zalouser: {
          enabled: true,
        },
      },
    };

    const findings = await collectChannelSecurityFindings({
      cfg,
      plugins: [plugin],
    });

    const finding = findings.find(
      (entry) => entry.checkId === "channels.zalouser.account.read_only_resolution",
    );
    expect(finding?.severity).toBe("warn");
    expect(finding?.title).toContain("could not be fully resolved");
    expect(finding?.detail).toContain("zalouser:default: failed to resolve account");
    expect(finding?.detail).toContain("missing SecretRef");
  });
});
