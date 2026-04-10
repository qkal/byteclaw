import { describe, expect, it, vi } from "vitest";
import {
  createCliPathTextInput,
  createDelegatedSetupWizardStatusResolvers,
  createDelegatedTextInputShouldPrompt,
  createDetectedBinaryStatus,
} from "./setup-wizard-binary.js";
import type { ChannelSetupWizard } from "./setup-wizard.js";

describe("createDetectedBinaryStatus", () => {
  it("builds status lines, hint, and score from binary detection", async () => {
    const resolveConfigured = vi.fn(() => true);
    const resolveBinaryPath = vi.fn(() => "/usr/local/bin/signal-cli");
    const status = createDetectedBinaryStatus({
      binaryLabel: "signal-cli",
      channelLabel: "Signal",
      configuredHint: "signal-cli found",
      configuredLabel: "configured",
      configuredScore: 1,
      detectBinary: vi.fn(async () => true),
      resolveBinaryPath,
      resolveConfigured,
      unconfiguredHint: "signal-cli missing",
      unconfiguredLabel: "needs setup",
      unconfiguredScore: 0,
    });

    expect(await status.resolveConfigured({ accountId: "work", cfg: {} })).toBe(true);
    expect(resolveConfigured).toHaveBeenCalledWith({ accountId: "work", cfg: {} });
    expect(await status.resolveStatusLines?.({ cfg: {}, configured: true })).toEqual([
      "Signal: configured",
      "signal-cli: found (/usr/local/bin/signal-cli)",
    ]);
    expect(resolveBinaryPath).toHaveBeenCalledWith({ accountId: undefined, cfg: {} });
    expect(await status.resolveSelectionHint?.({ cfg: {}, configured: true })).toBe(
      "signal-cli found",
    );
    expect(await status.resolveQuickstartScore?.({ cfg: {}, configured: true })).toBe(1);
  });

  it("passes accountId into binary path resolution", async () => {
    const resolveBinaryPath = vi.fn(({ accountId }: { accountId?: string }) =>
      accountId === "work" ? "/opt/work-signal-cli" : "/usr/local/bin/signal-cli",
    );
    const status = createDetectedBinaryStatus({
      binaryLabel: "signal-cli",
      channelLabel: "Signal",
      configuredHint: "signal-cli found",
      configuredLabel: "configured",
      configuredScore: 1,
      detectBinary: vi.fn(async () => false),
      resolveBinaryPath,
      resolveConfigured: () => true,
      unconfiguredHint: "signal-cli missing",
      unconfiguredLabel: "needs setup",
      unconfiguredScore: 0,
    });

    expect(
      await status.resolveStatusLines?.({ accountId: "work", cfg: {}, configured: false }),
    ).toEqual(["Signal: needs setup", "signal-cli: missing (/opt/work-signal-cli)"]);
    expect(resolveBinaryPath).toHaveBeenCalledWith({ accountId: "work", cfg: {} });
  });
});

describe("createCliPathTextInput", () => {
  it("reuses the same path resolver for current and initial values", async () => {
    const textInput = createCliPathTextInput({
      helpLines: ["help"],
      helpTitle: "iMessage",
      inputKey: "cliPath",
      message: "CLI path",
      resolvePath: () => "imsg",
      shouldPrompt: async () => false,
    });

    expect(
      await textInput.currentValue?.({ accountId: "default", cfg: {}, credentialValues: {} }),
    ).toBe("imsg");
    expect(
      await textInput.initialValue?.({ accountId: "default", cfg: {}, credentialValues: {} }),
    ).toBe("imsg");
    expect(textInput.helpTitle).toBe("iMessage");
    expect(textInput.helpLines).toEqual(["help"]);
  });
});

describe("createDelegatedSetupWizardStatusResolvers", () => {
  it("forwards optional status resolvers to the loaded wizard", async () => {
    const loadWizard = vi.fn(
      async (): Promise<ChannelSetupWizard> => ({
        channel: "demo",
        credentials: [],
        status: {
          configuredLabel: "configured",
          resolveConfigured: () => true,
          resolveQuickstartScore: async () => 7,
          resolveSelectionHint: async () => "hint",
          resolveStatusLines: async () => ["line"],
          unconfiguredLabel: "needs setup",
        },
      }),
    );

    const status = createDelegatedSetupWizardStatusResolvers(loadWizard);

    expect(await status.resolveStatusLines?.({ cfg: {}, configured: true })).toEqual(["line"]);
    expect(await status.resolveSelectionHint?.({ cfg: {}, configured: true })).toBe("hint");
    expect(await status.resolveQuickstartScore?.({ cfg: {}, configured: true })).toBe(7);
  });
});

describe("createDelegatedTextInputShouldPrompt", () => {
  it("forwards shouldPrompt for the requested input key", async () => {
    const loadWizard = vi.fn(
      async (): Promise<ChannelSetupWizard> => ({
        channel: "demo",
        credentials: [],
        status: {
          configuredLabel: "configured",
          resolveConfigured: () => true,
          unconfiguredLabel: "needs setup",
        },
        textInputs: [
          {
            inputKey: "cliPath",
            message: "CLI path",
            shouldPrompt: async ({ currentValue }) => currentValue !== "imsg",
          },
        ],
      }),
    );

    const shouldPrompt = createDelegatedTextInputShouldPrompt({
      inputKey: "cliPath",
      loadWizard,
    });

    expect(
      await shouldPrompt({
        accountId: "default",
        cfg: {},
        credentialValues: {},
        currentValue: "imsg",
      }),
    ).toBe(false);
    expect(
      await shouldPrompt({
        accountId: "default",
        cfg: {},
        credentialValues: {},
        currentValue: "other",
      }),
    ).toBe(true);
  });
});
