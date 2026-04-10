import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { patchChannelSetupWizardAdapter } from "./channel-test-helpers.js";
import {
  createChannelOnboardingPostWriteHookCollector,
  runCollectedChannelOnboardingPostWriteHooks,
  setupChannels,
} from "./onboard-channels.js";
import { createExitThrowingRuntime, createWizardPrompter } from "./test-wizard-helpers.js";

function setMinimalTelegramOnboardingRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: {
          ...createChannelTestPluginBase({
            capabilities: { chatTypes: ["direct", "group"] },
            id: "telegram",
            label: "Telegram",
          }),
          setup: {
            applyAccountConfig: ({ cfg }: { cfg: OpenClawConfig }) => cfg,
          },
          setupWizard: {
            channel: "telegram",
            credentials: [],
            status: {
              configuredLabel: "Configured",
              resolveConfigured: ({ cfg }: { cfg: OpenClawConfig }) =>
                Boolean(cfg.channels?.telegram?.botToken),
              unconfiguredLabel: "Not configured",
            },
          },
        },
        pluginId: "telegram",
        source: "test",
      },
    ]),
  );
}

function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
  return createWizardPrompter(
    {
      progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
      ...overrides,
    },
    { defaultSelect: "__done__" },
  );
}

function createQuickstartTelegramSelect() {
  return vi.fn(async ({ message }: { message: string }) => {
    if (message === "Select channel (QuickStart)") {
      return "telegram";
    }
    return "__done__";
  });
}

function createUnexpectedQuickstartPrompter(select: WizardPrompter["select"]) {
  return createPrompter({
    multiselect: vi.fn(async () => {
      throw new Error("unexpected multiselect");
    }),
    select,
    text: vi.fn(async ({ message }: { message: string }) => {
      throw new Error(`unexpected text prompt: ${message}`);
    }) as unknown as WizardPrompter["text"],
  });
}

describe("setupChannels post-write hooks", () => {
  beforeEach(() => {
    setMinimalTelegramOnboardingRegistryForTests();
  });

  it("collects onboarding post-write hooks and runs them against the final config", async () => {
    const select = createQuickstartTelegramSelect();
    const afterConfigWritten = vi.fn(async () => {});
    const configureInteractive = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      accountId: "acct-1",
      cfg: {
        ...cfg,
        channels: {
          ...cfg.channels,
          telegram: { ...cfg.channels?.telegram, botToken: "new-token" },
        },
      } as OpenClawConfig,
    }));
    const restore = patchChannelSetupWizardAdapter("telegram", {
      afterConfigWritten,
      configureInteractive,
      getStatus: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
        channel: "telegram",
        configured: Boolean(cfg.channels?.telegram?.botToken),
        statusLines: [],
      })),
    });
    const prompter = createUnexpectedQuickstartPrompter(
      select as unknown as WizardPrompter["select"],
    );
    const collector = createChannelOnboardingPostWriteHookCollector();
    const runtime = createExitThrowingRuntime();

    try {
      const cfg = await setupChannels({} as OpenClawConfig, runtime, prompter, {
        onPostWriteHook: (hook) => {
          collector.collect(hook);
        },
        quickstartDefaults: true,
        skipConfirm: true,
      });

      expect(afterConfigWritten).not.toHaveBeenCalled();

      await runCollectedChannelOnboardingPostWriteHooks({
        cfg,
        hooks: collector.drain(),
        runtime,
      });

      expect(afterConfigWritten).toHaveBeenCalledWith({
        accountId: "acct-1",
        cfg,
        previousCfg: {} as OpenClawConfig,
        runtime,
      });
    } finally {
      restore();
    }
  });

  it("logs onboarding post-write hook failures without aborting", async () => {
    const runtime = createExitThrowingRuntime();

    await runCollectedChannelOnboardingPostWriteHooks({
      cfg: {} as OpenClawConfig,
      hooks: [
        {
          accountId: "acct-1",
          channel: "telegram",
          run: async () => {
            throw new Error("hook failed");
          },
        },
      ],
      runtime,
    });

    expect(runtime.error).toHaveBeenCalledWith(
      'Channel telegram post-setup warning for "acct-1": hook failed',
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
