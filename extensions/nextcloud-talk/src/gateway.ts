import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import { type ResolvedNextcloudTalkAccount, resolveNextcloudTalkAccount } from "./accounts.js";
import {
  type ChannelPlugin,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  clearAccountEntryFields,
} from "./channel-api.js";
import { monitorNextcloudTalkProvider } from "./monitor.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

export const nextcloudTalkGatewayAdapter: NonNullable<
  ChannelPlugin<ResolvedNextcloudTalkAccount>["gateway"]
> = {
  logoutAccount: async ({ accountId, cfg }) => {
    const nextCfg = { ...cfg } as OpenClawConfig;
    const nextSection = cfg.channels?.["nextcloud-talk"]
      ? { ...cfg.channels["nextcloud-talk"] }
      : undefined;
    let cleared = false;
    let changed = false;

    if (nextSection) {
      if (accountId === DEFAULT_ACCOUNT_ID && nextSection.botSecret) {
        delete nextSection.botSecret;
        cleared = true;
        changed = true;
      }
      const accountCleanup = clearAccountEntryFields({
        accountId,
        accounts: nextSection.accounts as Record<string, object> | undefined,
        fields: ["botSecret"],
      });
      if (accountCleanup.changed) {
        changed = true;
        if (accountCleanup.cleared) {
          cleared = true;
        }
        if (accountCleanup.nextAccounts) {
          nextSection.accounts = accountCleanup.nextAccounts as Record<string, unknown>;
        } else {
          delete nextSection.accounts;
        }
      }
    }

    if (changed) {
      if (nextSection && Object.keys(nextSection).length > 0) {
        nextCfg.channels = { ...nextCfg.channels, "nextcloud-talk": nextSection };
      } else {
        const nextChannels = { ...nextCfg.channels } as Record<string, unknown>;
        delete nextChannels["nextcloud-talk"];
        if (Object.keys(nextChannels).length > 0) {
          nextCfg.channels = nextChannels as OpenClawConfig["channels"];
        } else {
          delete nextCfg.channels;
        }
      }
    }

    const resolved = resolveNextcloudTalkAccount({
      accountId,
      cfg: changed ? (nextCfg as CoreConfig) : (cfg as CoreConfig),
    });
    const loggedOut = resolved.secretSource === "none";

    if (changed) {
      await getNextcloudTalkRuntime().config.writeConfigFile(nextCfg);
    }

    return {
      cleared,
      envSecret: Boolean(process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim()),
      loggedOut,
    };
  },
  startAccount: async (ctx) => {
    const { account } = ctx;
    if (!account.secret || !account.baseUrl) {
      throw new Error(
        `Nextcloud Talk not configured for account "${account.accountId}" (missing secret or baseUrl)`,
      );
    }

    ctx.log?.info(`[${account.accountId}] starting Nextcloud Talk webhook server`);

    const statusSink = createAccountStatusSink({
      accountId: ctx.accountId,
      setStatus: ctx.setStatus,
    });

    await runStoppablePassiveMonitor({
      abortSignal: ctx.abortSignal,
      start: async () =>
        await monitorNextcloudTalkProvider({
          abortSignal: ctx.abortSignal,
          accountId: account.accountId,
          config: ctx.cfg as CoreConfig,
          runtime: ctx.runtime,
          statusSink,
        }),
    });
  },
};
