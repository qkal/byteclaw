import {
  type ChannelSetupWizard,
  createDetectedBinaryStatus,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { resolveIMessageAccount } from "./accounts.js";
import {
  createIMessageCliPathTextInput,
  imessageCompletionNote,
  imessageDmPolicy,
  imessageSetupAdapter,
  imessageSetupStatusBase,
  parseIMessageAllowFromEntries,
} from "./setup-core.js";

const channel = "imessage" as const;

export const imessageSetupWizard: ChannelSetupWizard = {
  channel,
  completionNote: imessageCompletionNote,
  credentials: [],
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
  dmPolicy: imessageDmPolicy,
  status: createDetectedBinaryStatus({
    binaryLabel: "imsg",
    channelLabel: "iMessage",
    configuredHint: imessageSetupStatusBase.configuredHint,
    configuredLabel: imessageSetupStatusBase.configuredLabel,
    configuredScore: imessageSetupStatusBase.configuredScore,
    detectBinary,
    resolveBinaryPath: ({ cfg, accountId }) =>
      resolveIMessageAccount({ cfg, accountId }).config.cliPath ?? "imsg",
    resolveConfigured: imessageSetupStatusBase.resolveConfigured,
    unconfiguredHint: imessageSetupStatusBase.unconfiguredHint,
    unconfiguredLabel: imessageSetupStatusBase.unconfiguredLabel,
    unconfiguredScore: imessageSetupStatusBase.unconfiguredScore,
  }),
  textInputs: [
    createIMessageCliPathTextInput(
      async ({ currentValue }) => !(await detectBinary(currentValue ?? "imsg")),
    ),
  ],
};

export { imessageSetupAdapter, parseIMessageAllowFromEntries };
