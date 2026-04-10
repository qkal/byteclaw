import {
  type ChannelSetupAdapter,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  prepareScopedSetupConfig,
} from "openclaw/plugin-sdk/setup";
import { applyMatrixSetupAccountConfig, validateMatrixSetupInput } from "./setup-config.js";
import type { CoreConfig } from "./types.js";

const channel = "matrix" as const;

function resolveMatrixSetupAccountId(params: { accountId?: string; name?: string }): string {
  return normalizeAccountId(params.accountId?.trim() || params.name?.trim() || DEFAULT_ACCOUNT_ID);
}

export const matrixSetupAdapter: ChannelSetupAdapter = {
  afterAccountConfigWritten: async ({ previousCfg, cfg, accountId, runtime }) => {
    const { runMatrixSetupBootstrapAfterConfigWrite } = await import("./setup-bootstrap.js");
    await runMatrixSetupBootstrapAfterConfigWrite({
      accountId,
      cfg: cfg as CoreConfig,
      previousCfg: previousCfg as CoreConfig,
      runtime,
    });
  },
  applyAccountConfig: ({ cfg, accountId, input }) =>
    applyMatrixSetupAccountConfig({
      accountId,
      cfg: cfg as CoreConfig,
      input,
    }),
  applyAccountName: ({ cfg, accountId, name }) =>
    prepareScopedSetupConfig({
      accountId,
      cfg: cfg as CoreConfig,
      channelKey: channel,
      name,
    }) as CoreConfig,
  resolveAccountId: ({ accountId, input }) =>
    resolveMatrixSetupAccountId({
      accountId,
      name: input?.name,
    }),
  resolveBindingAccountId: ({ accountId, agentId }) =>
    resolveMatrixSetupAccountId({
      accountId,
      name: agentId,
    }),
  validateInput: ({ accountId, input }) => validateMatrixSetupInput({ accountId, input }),
};
