import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listChannelPluginCatalogEntries } from "../../channels/plugins/catalog.js";
import { parseOptionalDelimitedEntries } from "../../channels/plugins/helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { moveSingleAccountChannelSectionToDefaultAccount } from "../../channels/plugins/setup-helpers.js";
import type { ChannelSetupPlugin } from "../../channels/plugins/setup-wizard-types.js";
import type { ChannelId, ChannelPlugin, ChannelSetupInput } from "../../channels/plugins/types.js";
import { type OpenClawConfig, replaceConfigFile } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { type RuntimeEnv, defaultRuntime } from "../../runtime.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { applyAgentBindings, describeBinding } from "../agents.bindings.js";
import { isCatalogChannelInstalled } from "../channel-setup/discovery.js";
import {
  createChannelOnboardingPostWriteHookCollector,
  runCollectedChannelOnboardingPostWriteHooks,
} from "../onboard-channels.js";
import type { ChannelChoice } from "../onboard-types.js";
import { applyAccountName, applyChannelAccountConfig } from "./add-mutators.js";
import { channelLabel, requireValidConfigFileSnapshot, shouldUseWizard } from "./shared.js";

export type ChannelsAddOptions = {
  channel?: string;
  account?: string;
  initialSyncLimit?: number | string;
  groupChannels?: string;
  dmAllowlist?: string;
} & Omit<ChannelSetupInput, "groupChannels" | "dmAllowlist" | "initialSyncLimit">;

function resolveCatalogChannelEntry(raw: string, cfg: OpenClawConfig | null) {
  const trimmed = normalizeOptionalLowercaseString(raw);
  if (!trimmed) {
    return undefined;
  }
  const workspaceDir = cfg ? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)) : undefined;
  return listChannelPluginCatalogEntries({ workspaceDir }).find((entry) => {
    if (normalizeOptionalLowercaseString(entry.id) === trimmed) {
      return true;
    }
    return (entry.meta.aliases ?? []).some(
      (alias) => normalizeOptionalLowercaseString(alias) === trimmed,
    );
  });
}

export async function channelsAddCommand(
  opts: ChannelsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const configSnapshot = await requireValidConfigFileSnapshot(runtime);
  if (!configSnapshot) {
    return;
  }
  const cfg = (configSnapshot.sourceConfig ?? configSnapshot.config) as OpenClawConfig;
  const baseHash = configSnapshot.hash;
  let nextConfig = cfg;

  const useWizard = shouldUseWizard(params);
  if (useWizard) {
    const [{ buildAgentSummaries }, { setupChannels }] = await Promise.all([
      import("../agents.config.js"),
      import("../onboard-channels.js"),
    ]);
    const prompter = createClackPrompter();
    const postWriteHooks = createChannelOnboardingPostWriteHookCollector();
    let selection: ChannelChoice[] = [];
    const accountIds: Partial<Record<ChannelChoice, string>> = {};
    const resolvedPlugins = new Map<ChannelChoice, ChannelSetupPlugin>();
    await prompter.intro("Channel setup");
    let nextConfig = await setupChannels(cfg, runtime, prompter, {
      allowDisable: false,
      allowSignalInstall: true,
      onAccountId: (channel, accountId) => {
        accountIds[channel] = accountId;
      },
      onPostWriteHook: (hook) => {
        postWriteHooks.collect(hook);
      },
      onResolvedPlugin: (channel, plugin) => {
        resolvedPlugins.set(channel, plugin);
      },
      onSelection: (value) => {
        selection = value;
      },
      promptAccountIds: true,
    });
    if (selection.length === 0) {
      await prompter.outro("No channels selected.");
      return;
    }

    const wantsNames = await prompter.confirm({
      initialValue: false,
      message: "Add display names for these accounts? (optional)",
    });
    if (wantsNames) {
      for (const channel of selection) {
        const accountId = accountIds[channel] ?? DEFAULT_ACCOUNT_ID;
        const plugin = resolvedPlugins.get(channel) ?? getChannelPlugin(channel);
        const account = plugin?.config.resolveAccount(nextConfig, accountId) as
          | { name?: string }
          | undefined;
        const snapshot = plugin?.config.describeAccount?.(account, nextConfig);
        const existingName = snapshot?.name ?? account?.name;
        const name = await prompter.text({
          initialValue: existingName,
          message: `${channel} account name (${accountId})`,
        });
        if (name?.trim()) {
          nextConfig = applyAccountName({
            accountId,
            cfg: nextConfig,
            channel,
            name,
            plugin,
          });
        }
      }
    }

    const bindTargets = selection
      .map((channel) => ({
        accountId: accountIds[channel]?.trim(),
        channel,
      }))
      .filter(
        (
          value,
        ): value is {
          channel: ChannelChoice;
          accountId: string;
        } => Boolean(value.accountId),
      );
    if (bindTargets.length > 0) {
      const bindNow = await prompter.confirm({
        initialValue: true,
        message: "Bind configured channel accounts to agents now?",
      });
      if (bindNow) {
        const agentSummaries = buildAgentSummaries(nextConfig);
        const defaultAgentId = resolveDefaultAgentId(nextConfig);
        for (const target of bindTargets) {
          const targetAgentId = await prompter.select({
            initialValue: defaultAgentId,
            message: `Route ${target.channel} account "${target.accountId}" to agent`,
            options: agentSummaries.map((agent) => ({
              label: agent.isDefault ? `${agent.id} (default)` : agent.id,
              value: agent.id,
            })),
          });
          const bindingResult = applyAgentBindings(nextConfig, [
            {
              agentId: targetAgentId,
              match: { accountId: target.accountId, channel: target.channel },
            },
          ]);
          nextConfig = bindingResult.config;
          if (bindingResult.added.length > 0 || bindingResult.updated.length > 0) {
            await prompter.note(
              [
                ...bindingResult.added.map((binding) => `Added: ${describeBinding(binding)}`),
                ...bindingResult.updated.map((binding) => `Updated: ${describeBinding(binding)}`),
              ].join("\n"),
              "Routing bindings",
            );
          }
          if (bindingResult.conflicts.length > 0) {
            await prompter.note(
              [
                "Skipped bindings already claimed by another agent:",
                ...bindingResult.conflicts.map(
                  (conflict) =>
                    `- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
                ),
              ].join("\n"),
              "Routing bindings",
            );
          }
        }
      }
    }

    await replaceConfigFile({
      nextConfig,
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    await runCollectedChannelOnboardingPostWriteHooks({
      cfg: nextConfig,
      hooks: postWriteHooks.drain(),
      runtime,
    });
    await prompter.outro("Channels updated.");
    return;
  }

  const rawChannel = String(opts.channel ?? "");
  let channel = normalizeChannelId(rawChannel);
  let catalogEntry = channel ? undefined : resolveCatalogChannelEntry(rawChannel, nextConfig);
  const resolveWorkspaceDir = () =>
    resolveAgentWorkspaceDir(nextConfig, resolveDefaultAgentId(nextConfig));
  // May trigger loadOpenClawPlugins on cache miss (disk scan + jiti import)
  const loadScopedPlugin = async (
    channelId: ChannelId,
    pluginId?: string,
  ): Promise<ChannelPlugin | undefined> => {
    const existing = getChannelPlugin(channelId);
    if (existing) {
      return existing;
    }
    const { loadChannelSetupPluginRegistrySnapshotForChannel } =
      await import("../channel-setup/plugin-install.js");
    const snapshot = loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg: nextConfig,
      runtime,
      channel: channelId,
      ...(pluginId ? { pluginId } : {}),
      workspaceDir: resolveWorkspaceDir(),
    });
    return (
      snapshot.channels.find((entry) => entry.plugin.id === channelId)?.plugin ??
      snapshot.channelSetups.find((entry) => entry.plugin.id === channelId)?.plugin
    );
  };

  if (!channel && catalogEntry) {
    const workspaceDir = resolveWorkspaceDir();
    if (
      !isCatalogChannelInstalled({
        cfg: nextConfig,
        entry: catalogEntry,
        workspaceDir,
      })
    ) {
      const { ensureChannelSetupPluginInstalled } =
        await import("../channel-setup/plugin-install.js");
      const prompter = createClackPrompter();
      const result = await ensureChannelSetupPluginInstalled({
        cfg: nextConfig,
        entry: catalogEntry,
        prompter,
        runtime,
        workspaceDir,
      });
      nextConfig = result.cfg;
      if (!result.installed) {
        return;
      }
      catalogEntry = {
        ...catalogEntry,
        ...(result.pluginId ? { pluginId: result.pluginId } : {}),
      };
    }
    channel = normalizeChannelId(catalogEntry.id) ?? (catalogEntry.id as ChannelId);
  }

  if (!channel) {
    const hint = catalogEntry
      ? `Plugin ${catalogEntry.meta.label} could not be loaded after install.`
      : `Unknown channel: ${String(opts.channel ?? "")}`;
    runtime.error(hint);
    runtime.exit(1);
    return;
  }

  const plugin = await loadScopedPlugin(channel, catalogEntry?.pluginId);
  if (!plugin?.setup?.applyAccountConfig) {
    runtime.error(`Channel ${channel} does not support add.`);
    runtime.exit(1);
    return;
  }
  const useEnv = opts.useEnv === true;
  const initialSyncLimit =
    typeof opts.initialSyncLimit === "number"
      ? opts.initialSyncLimit
      : typeof opts.initialSyncLimit === "string" && opts.initialSyncLimit.trim()
        ? Number.parseInt(opts.initialSyncLimit, 10)
        : undefined;
  const groupChannels = parseOptionalDelimitedEntries(opts.groupChannels);
  const dmAllowlist = parseOptionalDelimitedEntries(opts.dmAllowlist);

  const input: ChannelSetupInput = {
    accessToken: opts.accessToken,
    appToken: opts.appToken,
    audience: opts.audience,
    audienceType: opts.audienceType,
    authDir: opts.authDir,
    autoDiscoverChannels: opts.autoDiscoverChannels,
    botToken: opts.botToken,
    cliPath: opts.cliPath,
    code: opts.code,
    dbPath: opts.dbPath,
    deviceName: opts.deviceName,
    dmAllowlist,
    groupChannels,
    homeserver: opts.homeserver,
    httpHost: opts.httpHost,
    httpPort: opts.httpPort,
    httpUrl: opts.httpUrl,
    initialSyncLimit,
    name: opts.name,
    password: opts.password,
    privateKey: opts.privateKey,
    region: opts.region,
    relayUrls: opts.relayUrls,
    service: opts.service,
    ship: opts.ship,
    signalNumber: opts.signalNumber,
    token: opts.token,
    tokenFile: opts.tokenFile,
    url: opts.url,
    useEnv,
    userId: opts.userId,
    webhookPath: opts.webhookPath,
    webhookUrl: opts.webhookUrl,
  };
  const accountId =
    plugin.setup.resolveAccountId?.({
      accountId: opts.account,
      cfg: nextConfig,
      input,
    }) ?? normalizeAccountId(opts.account);

  const validationError = plugin.setup.validateInput?.({
    accountId,
    cfg: nextConfig,
    input,
  });
  if (validationError) {
    runtime.error(validationError);
    runtime.exit(1);
    return;
  }

  const prevConfig = nextConfig;

  if (accountId !== DEFAULT_ACCOUNT_ID) {
    nextConfig = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: nextConfig,
      channelKey: channel,
    });
  }

  nextConfig = applyChannelAccountConfig({
    accountId,
    cfg: nextConfig,
    channel,
    input,
    plugin,
  });
  await plugin.lifecycle?.onAccountConfigChanged?.({
    accountId,
    nextCfg: nextConfig,
    prevCfg: prevConfig,
    runtime,
  });

  await replaceConfigFile({
    nextConfig,
    ...(baseHash !== undefined ? { baseHash } : {}),
  });
  runtime.log(`Added ${channelLabel(channel)} account "${accountId}".`);
  const afterAccountConfigWritten = plugin.setup?.afterAccountConfigWritten;
  if (afterAccountConfigWritten) {
    await runCollectedChannelOnboardingPostWriteHooks({
      cfg: nextConfig,
      hooks: [
        {
          accountId,
          channel,
          run: async ({ cfg: writtenCfg, runtime: hookRuntime }) =>
            await afterAccountConfigWritten({
              previousCfg: cfg,
              cfg: writtenCfg,
              accountId,
              input,
              runtime: hookRuntime,
            }),
        },
      ],
      runtime,
    });
  }
}
