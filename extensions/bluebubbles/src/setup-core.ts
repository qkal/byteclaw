import {
  type ChannelSetupAdapter,
  type DmPolicy,
  type OpenClawConfig,
  addWildcardAllowFrom,
  createSetupInputPresenceValidator,
  normalizeAccountId,
  patchScopedAccountConfig,
  prepareScopedSetupConfig,
} from "openclaw/plugin-sdk/setup";
import { applyBlueBubblesConnectionConfig } from "./config-apply.js";

const channel = "bluebubbles" as const;

export function setBlueBubblesDmPolicy(
  cfg: OpenClawConfig,
  accountId: string,
  dmPolicy: DmPolicy,
): OpenClawConfig {
  const resolvedAccountId = normalizeAccountId(accountId);
  const existingAllowFrom =
    resolvedAccountId === "default"
      ? cfg.channels?.bluebubbles?.allowFrom
      : ((
          cfg.channels?.bluebubbles?.accounts?.[resolvedAccountId] as
            | { allowFrom?: readonly (string | number)[] }
            | undefined
        )?.allowFrom ?? cfg.channels?.bluebubbles?.allowFrom);
  return patchScopedAccountConfig({
    accountId: resolvedAccountId,
    cfg,
    channelKey: channel,
    ensureAccountEnabled: false,
    ensureChannelEnabled: false,
    patch: {
      dmPolicy,
      ...(dmPolicy === "open" ? { allowFrom: addWildcardAllowFrom(existingAllowFrom) } : {}),
    },
  });
}

export function setBlueBubblesAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom: string[],
): OpenClawConfig {
  return patchScopedAccountConfig({
    accountId,
    cfg,
    channelKey: channel,
    ensureAccountEnabled: false,
    ensureChannelEnabled: false,
    patch: { allowFrom },
  });
}

export const blueBubblesSetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const next = prepareScopedSetupConfig({
      accountId,
      cfg,
      channelKey: channel,
      migrateBaseName: true,
      name: input.name,
    });
    return applyBlueBubblesConnectionConfig({
      accountId,
      cfg: next,
      onlyDefinedFields: true,
      patch: {
        password: input.password,
        serverUrl: input.httpUrl,
        webhookPath: input.webhookPath,
      },
    });
  },
  applyAccountName: ({ cfg, accountId, name }) =>
    prepareScopedSetupConfig({
      accountId,
      cfg,
      channelKey: channel,
      name,
    }),
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  validateInput: createSetupInputPresenceValidator({
    validate: ({ input }) => {
      if (!input.httpUrl && !input.password) {
        return "BlueBubbles requires --http-url and --password.";
      }
      if (!input.httpUrl) {
        return "BlueBubbles requires --http-url.";
      }
      if (!input.password) {
        return "BlueBubbles requires --password.";
      }
      return null;
    },
  }),
};
