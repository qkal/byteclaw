import {
  type ChannelSetupWizard,
  createDetectedBinaryStatus,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { listSignalAccountIds, resolveSignalAccount } from "./accounts.js";
import { installSignalCli } from "./install-signal-cli.js";
import {
  createSignalCliPathTextInput,
  normalizeSignalAccountInput,
  parseSignalAllowFromEntries,
  signalCompletionNote,
  signalDmPolicy,
  signalNumberTextInput,
  signalSetupAdapter,
} from "./setup-core.js";

const channel = "signal" as const;

export const signalSetupWizard: ChannelSetupWizard = {
  channel,
  completionNote: signalCompletionNote,
  credentials: [],
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
  dmPolicy: signalDmPolicy,
  prepare: async ({ cfg, accountId, credentialValues, runtime, prompter, options }) => {
    if (!options?.allowSignalInstall) {
      return;
    }
    const currentCliPath =
      (typeof credentialValues.cliPath === "string" ? credentialValues.cliPath : undefined) ??
      resolveSignalAccount({ accountId, cfg }).config.cliPath ??
      "signal-cli";
    const cliDetected = await detectBinary(currentCliPath);
    const wantsInstall = await prompter.confirm({
      initialValue: !cliDetected,
      message: cliDetected
        ? "signal-cli detected. Reinstall/update now?"
        : "signal-cli not found. Install now?",
    });
    if (!wantsInstall) {
      return;
    }
    try {
      const result = await installSignalCli(runtime);
      if (result.ok && result.cliPath) {
        await prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal");
        return {
          credentialValues: {
            cliPath: result.cliPath,
          },
        };
      }
      if (!result.ok) {
        await prompter.note(result.error ?? "signal-cli install failed.", "Signal");
      }
    } catch (error) {
      await prompter.note(`signal-cli install failed: ${String(error)}`, "Signal");
    }
  },
  status: createDetectedBinaryStatus({
    binaryLabel: "signal-cli",
    channelLabel: "Signal",
    configuredHint: "signal-cli found",
    configuredLabel: "configured",
    configuredScore: 1,
    detectBinary,
    resolveBinaryPath: ({ cfg, accountId }) =>
      resolveSignalAccount({ cfg, accountId }).config.cliPath ?? "signal-cli",
    resolveConfigured: ({ cfg, accountId }) =>
      accountId
        ? resolveSignalAccount({ cfg, accountId }).configured
        : listSignalAccountIds(cfg).some(
            (resolvedAccountId) =>
              resolveSignalAccount({ cfg, accountId: resolvedAccountId }).configured,
          ),
    unconfiguredHint: "signal-cli missing",
    unconfiguredLabel: "needs setup",
    unconfiguredScore: 0,
  }),
  textInputs: [
    createSignalCliPathTextInput(
      async ({ currentValue }) => !(await detectBinary(currentValue ?? "signal-cli")),
    ),
    signalNumberTextInput,
  ],
};

export { normalizeSignalAccountInput, parseSignalAllowFromEntries, signalSetupAdapter };
