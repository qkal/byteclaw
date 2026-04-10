import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { collectChannelSecurityFindings } from "./audit-channel.js";

describe("security audit channel dm policy", () => {
  it("warns when multiple DM senders share the main session", async () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { enabled: true } },
      session: { dmScope: "main" },
    };
    const plugins: ChannelPlugin[] = [
      {
        capabilities: { chatTypes: ["direct"] },
        config: {
          isConfigured: () => true,
          isEnabled: () => true,
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        id: "whatsapp",
        meta: {
          blurb: "Test",
          docsPath: "/channels/whatsapp",
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
        },
        security: {
          resolveDmPolicy: () => ({
            allowFrom: ["user-a", "user-b"],
            allowFromPath: "channels.whatsapp.",
            approveHint: "approve",
            policy: "allowlist",
            policyPath: "channels.whatsapp.dmPolicy",
          }),
        },
      },
    ];

    const findings = await collectChannelSecurityFindings({
      cfg,
      plugins,
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "channels.whatsapp.dm.scope_main_multiuser",
          remediation: expect.stringContaining('config set session.dmScope "per-channel-peer"'),
          severity: "warn",
        }),
      ]),
    );
  });
});
