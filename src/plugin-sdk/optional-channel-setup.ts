import type { ChannelSetupWizard } from "../channels/plugins/setup-wizard.js";
import type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { formatDocsLink } from "../terminal/links.js";

interface OptionalChannelSetupParams {
  channel: string;
  label: string;
  npmSpec?: string;
  docsPath?: string;
}

function buildOptionalChannelSetupMessage(params: OptionalChannelSetupParams): string {
  const installTarget = params.npmSpec ?? `the ${params.label} plugin`;
  const message = [`${params.label} setup requires ${installTarget} to be installed.`];
  if (params.docsPath) {
    message.push(`Docs: ${formatDocsLink(params.docsPath, params.docsPath.replace(/^\/+/u, ""))}`);
  }
  return message.join(" ");
}

export function createOptionalChannelSetupAdapter(
  params: OptionalChannelSetupParams,
): ChannelSetupAdapter {
  const message = buildOptionalChannelSetupMessage(params);
  return {
    applyAccountConfig: () => {
      throw new Error(message);
    },
    resolveAccountId: ({ accountId }) => accountId ?? DEFAULT_ACCOUNT_ID,
    validateInput: () => message,
  };
}

export function createOptionalChannelSetupWizard(
  params: OptionalChannelSetupParams,
): ChannelSetupWizard {
  const message = buildOptionalChannelSetupMessage(params);
  return {
    channel: params.channel,
    credentials: [],
    finalize: async () => {
      throw new Error(message);
    },
    status: {
      configuredHint: message,
      configuredLabel: `${params.label} plugin installed`,
      resolveConfigured: () => false,
      resolveSelectionHint: () => message,
      resolveStatusLines: () => [message],
      unconfiguredHint: message,
      unconfiguredLabel: `install ${params.label} plugin`,
      unconfiguredScore: 0,
    },
  };
}
