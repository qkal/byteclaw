import {
  type ChannelSetupAdapter,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
} from "openclaw/plugin-sdk/setup";

const channel = "whatsapp" as const;

export const whatsappSetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const namedConfig = applyAccountNameToChannelSection({
      accountId,
      alwaysUseAccounts: true,
      cfg,
      channelKey: channel,
      name: input.name,
    });
    const next = migrateBaseNameToDefaultAccount({
      alwaysUseAccounts: true,
      cfg: namedConfig,
      channelKey: channel,
    });
    const entry = {
      ...next.channels?.whatsapp?.accounts?.[accountId],
      ...(input.authDir ? { authDir: input.authDir } : {}),
      enabled: true,
    };
    return {
      ...next,
      channels: {
        ...next.channels,
        whatsapp: {
          ...next.channels?.whatsapp,
          accounts: {
            ...next.channels?.whatsapp?.accounts,
            [accountId]: entry,
          },
        },
      },
    };
  },
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      accountId,
      alwaysUseAccounts: true,
      cfg,
      channelKey: channel,
      name,
    }),
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
};
