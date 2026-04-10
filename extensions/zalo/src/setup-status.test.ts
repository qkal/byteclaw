import { describe, expect, it } from "vitest";
import { createPluginSetupWizardStatus } from "../../../test/helpers/plugins/setup-wizard.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { zaloSetupWizard } from "./setup-surface.js";

const zaloGetStatus = createPluginSetupWizardStatus({
  id: "zalo",
  meta: {
    label: "Zalo",
  },
  setupWizard: zaloSetupWizard,
} as never);

describe("zalo setup wizard status", () => {
  it("treats SecretRef botToken as configured", async () => {
    const status = await zaloGetStatus({
      accountOverrides: {},
      cfg: {
        channels: {
          zalo: {
            botToken: {
              id: "ZALO_BOT_TOKEN",
              provider: "default",
              source: "env",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(status.configured).toBe(true);
  });
});
