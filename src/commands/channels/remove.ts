import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  getChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import { type OpenClawConfig, replaceConfigFile } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { type RuntimeEnv, defaultRuntime } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { resolveInstallableChannelPlugin } from "../channel-setup/channel-plugin-resolution.js";
import {
  type ChatChannel,
  channelLabel,
  requireValidConfigFileSnapshot,
  shouldUseWizard,
} from "./shared.js";

export interface ChannelsRemoveOptions {
  channel?: string;
  account?: string;
  delete?: boolean;
}

function listAccountIds(cfg: OpenClawConfig, channel: ChatChannel): string[] {
  const plugin = getChannelPlugin(channel);
  if (!plugin) {
    return [];
  }
  return plugin.config.listAccountIds(cfg);
}

export async function channelsRemoveCommand(
  opts: ChannelsRemoveOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const configSnapshot = await requireValidConfigFileSnapshot(runtime);
  if (!configSnapshot) {
    return;
  }
  const baseHash = configSnapshot.hash;
  let cfg = (configSnapshot.sourceConfig ?? configSnapshot.config) as OpenClawConfig;

  const useWizard = shouldUseWizard(params);
  const prompter = useWizard ? createClackPrompter() : null;
  const rawChannel = normalizeOptionalString(opts.channel) ?? "";
  let channel: ChatChannel | null = normalizeChannelId(rawChannel);
  let accountId = normalizeAccountId(opts.account);
  const deleteConfig = Boolean(opts.delete);

  if (useWizard && prompter) {
    await prompter.intro("Remove channel account");
    const selectedChannel = await prompter.select({
      message: "Channel",
      options: listChannelPlugins().map((plugin) => ({
        label: plugin.meta.label,
        value: plugin.id,
      })),
    });
    channel = selectedChannel;

    accountId = await (async () => {
      const ids = listAccountIds(cfg, selectedChannel);
      const choice = await prompter.select({
        initialValue: ids[0] ?? DEFAULT_ACCOUNT_ID,
        message: "Account",
        options: ids.map((id) => ({
          label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id,
          value: id,
        })),
      });
      return normalizeAccountId(choice);
    })();

    const wantsDisable = await prompter.confirm({
      initialValue: true,
      message: `Disable ${channelLabel(selectedChannel)} account "${accountId}"? (keeps config)`,
    });
    if (!wantsDisable) {
      await prompter.outro("Cancelled.");
      return;
    }
  } else {
    if (!rawChannel) {
      runtime.error("Channel is required. Use --channel <name>.");
      runtime.exit(1);
      return;
    }
    if (!deleteConfig) {
      const confirm = createClackPrompter();
      const channelPromptLabel = channel ? channelLabel(channel) : rawChannel;
      const ok = await confirm.confirm({
        initialValue: true,
        message: `Disable ${channelPromptLabel} account "${accountId}"? (keeps config)`,
      });
      if (!ok) {
        return;
      }
    }
  }

  const resolvedPluginState =
    !useWizard && rawChannel
      ? await resolveInstallableChannelPlugin({
          allowInstall: true,
          cfg,
          rawChannel,
          runtime,
        })
      : null;
  if (resolvedPluginState?.configChanged) {
    ({ cfg } = resolvedPluginState);
  }
  const resolvedChannel = resolvedPluginState?.channelId ?? channel;
  if (!resolvedChannel) {
    runtime.error(`Unknown channel: ${rawChannel}`);
    runtime.exit(1);
    return;
  }
  channel = resolvedChannel;
  const plugin = resolvedPluginState?.plugin ?? getChannelPlugin(resolvedChannel);
  if (!plugin) {
    runtime.error(`Unknown channel: ${resolvedChannel}`);
    runtime.exit(1);
    return;
  }
  const resolvedChannelId: ChatChannel = resolvedChannel;
  const resolvedAccountId =
    normalizeAccountId(accountId) ?? resolveChannelDefaultAccountId({ cfg, plugin });
  const accountKey = resolvedAccountId || DEFAULT_ACCOUNT_ID;

  let next = { ...cfg };
  const prevCfg = cfg;
  if (deleteConfig) {
    if (!plugin.config.deleteAccount) {
      runtime.error(`Channel ${channel} does not support delete.`);
      runtime.exit(1);
      return;
    }
    next = plugin.config.deleteAccount({
      accountId: resolvedAccountId,
      cfg: next,
    });
    await plugin.lifecycle?.onAccountRemoved?.({
      accountId: resolvedAccountId,
      prevCfg,
      runtime,
    });
  } else {
    if (!plugin.config.setAccountEnabled) {
      runtime.error(`Channel ${channel} does not support disable.`);
      runtime.exit(1);
      return;
    }
    next = plugin.config.setAccountEnabled({
      accountId: resolvedAccountId,
      cfg: next,
      enabled: false,
    });
    await plugin.lifecycle?.onAccountConfigChanged?.({
      accountId: resolvedAccountId,
      nextCfg: next,
      prevCfg,
      runtime,
    });
  }

  await replaceConfigFile({
    nextConfig: next,
    ...(baseHash !== undefined ? { baseHash } : {}),
  });
  if (useWizard && prompter) {
    await prompter.outro(
      deleteConfig
        ? `Deleted ${channelLabel(resolvedChannelId)} account "${accountKey}".`
        : `Disabled ${channelLabel(resolvedChannelId)} account "${accountKey}".`,
    );
  } else {
    runtime.log(
      deleteConfig
        ? `Deleted ${channelLabel(resolvedChannelId)} account "${accountKey}".`
        : `Disabled ${channelLabel(resolvedChannelId)} account "${accountKey}".`,
    );
  }
}
