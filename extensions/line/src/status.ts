import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  buildTokenChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
  createDependentCredentialStatusIssueCollector,
} from "openclaw/plugin-sdk/status-helpers";
import { hasLineCredentials } from "./account-helpers.js";
import { type ChannelPlugin, DEFAULT_ACCOUNT_ID, type ResolvedLineAccount } from "./channel-api.js";

const loadLineProbeRuntime = createLazyRuntimeModule(() => import("./probe.runtime.js"));

const collectLineStatusIssues = createDependentCredentialStatusIssueCollector({
  channel: "line",
  dependencySourceKey: "tokenSource",
  missingDependentMessage: "LINE channel secret not configured",
  missingPrimaryMessage: "LINE channel access token not configured",
});

export const lineStatusAdapter: NonNullable<ChannelPlugin<ResolvedLineAccount>["status"]> =
  createComputedAccountStatusAdapter<ResolvedLineAccount>({
    buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
    collectStatusIssues: collectLineStatusIssues,
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    probeAccount: async ({ account, timeoutMs }) =>
      await (await loadLineProbeRuntime()).probeLineBot(account.channelAccessToken, timeoutMs),
    resolveAccountSnapshot: ({ account }) => ({
      accountId: account.accountId,
      configured: hasLineCredentials(account),
      enabled: account.enabled,
      extra: {
        mode: "webhook",
        tokenSource: account.tokenSource,
      },
      name: account.name,
    }),
  });
