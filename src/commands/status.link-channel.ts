import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultChannelAccountContext } from "./channel-account-context.js";

export interface LinkChannelContext {
  linked: boolean;
  authAgeMs: number | null;
  account?: unknown;
  accountId?: string;
  plugin: ChannelPlugin;
}

export async function resolveLinkChannelContext(
  cfg: OpenClawConfig,
): Promise<LinkChannelContext | null> {
  for (const plugin of listChannelPlugins()) {
    const { defaultAccountId, account, enabled, configured } =
      await resolveDefaultChannelAccountContext(plugin, cfg, {
        commandName: "status",
        mode: "read_only",
      });
    const snapshot = plugin.config.describeAccount
      ? plugin.config.describeAccount(account, cfg)
      : ({
          accountId: defaultAccountId,
          configured,
          enabled,
        } as ChannelAccountSnapshot);
    const summary = plugin.status?.buildChannelSummary
      ? await plugin.status.buildChannelSummary({
          account,
          cfg,
          defaultAccountId,
          snapshot,
        })
      : undefined;
    const summaryRecord = summary;
    const linked =
      summaryRecord && typeof summaryRecord.linked === "boolean" ? summaryRecord.linked : null;
    if (linked === null) {
      continue;
    }
    const authAgeMs =
      summaryRecord && typeof summaryRecord.authAgeMs === "number" ? summaryRecord.authAgeMs : null;
    return { account, accountId: defaultAccountId, authAgeMs, linked, plugin };
  }
  return null;
}
