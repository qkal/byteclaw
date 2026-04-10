import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import {
  getChannelSetupPlugin,
  listChannelSetupPlugins,
} from "../channels/plugins/setup-registry.js";
import type { ChannelSetupPlugin } from "../channels/plugins/setup-wizard-types.js";
import { listChatChannels } from "../channels/registry.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  resolveChannelSetupEntries,
  shouldShowChannelInSetup,
} from "../commands/channel-setup/discovery.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "../commands/channel-setup/plugin-install.js";
import { resolveChannelSetupWizardAdapterForPlugin } from "../commands/channel-setup/registry.js";
import { listTrustedChannelPluginCatalogEntries } from "../commands/channel-setup/trusted-catalog.js";
import type {
  ChannelOnboardingPostWriteHook,
  ChannelSetupConfiguredResult,
  ChannelSetupResult,
  SetupChannelsOptions,
} from "../commands/channel-setup/types.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import { isChannelConfigured } from "../config/channel-configured.js";
import type { OpenClawConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  formatAccountLabel,
  maybeConfigureDmPolicies,
  promptConfiguredAction,
  promptRemovalAccountId,
} from "./channel-setup.prompts.js";
import {
  collectChannelStatus,
  noteChannelPrimer,
  resolveChannelSelectionNoteLines,
  resolveChannelSetupSelectionContributions,
  resolveQuickstartDefault,
} from "./channel-setup.status.js";
export { noteChannelStatus } from "./channel-setup.status.js";

export function createChannelOnboardingPostWriteHookCollector() {
  const hooks = new Map<string, ChannelOnboardingPostWriteHook>();
  return {
    collect(hook: ChannelOnboardingPostWriteHook) {
      hooks.set(`${hook.channel}:${hook.accountId}`, hook);
    },
    drain(): ChannelOnboardingPostWriteHook[] {
      const next = [...hooks.values()];
      hooks.clear();
      return next;
    },
  };
}

export async function runCollectedChannelOnboardingPostWriteHooks(params: {
  hooks: ChannelOnboardingPostWriteHook[];
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
}): Promise<void> {
  for (const hook of params.hooks) {
    try {
      await hook.run({ cfg: params.cfg, runtime: params.runtime });
    } catch (error) {
      const message = formatErrorMessage(error);
      params.runtime.error(
        `Channel ${hook.channel} post-setup warning for "${hook.accountId}": ${message}`,
      );
    }
  }
}

// Channel-specific prompts moved into setup flow adapters.

export async function setupChannels(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  options?: SetupChannelsOptions,
): Promise<OpenClawConfig> {
  let next = cfg;
  const forceAllowFromChannels = new Set(options?.forceAllowFromChannels ?? []);
  const accountOverrides: Partial<Record<ChannelChoice, string>> = {
    ...options?.accountIds,
  };
  const scopedPluginsById = new Map<ChannelChoice, ChannelSetupPlugin>();
  const resolveWorkspaceDir = () => resolveAgentWorkspaceDir(next, resolveDefaultAgentId(next));
  const rememberScopedPlugin = (plugin: ChannelSetupPlugin) => {
    const channel = plugin.id;
    scopedPluginsById.set(channel, plugin);
    options?.onResolvedPlugin?.(channel, plugin);
  };
  const getVisibleChannelPlugin = (channel: ChannelChoice): ChannelSetupPlugin | undefined =>
    scopedPluginsById.get(channel) ?? getChannelSetupPlugin(channel);
  const listVisibleInstalledPlugins = (): ChannelSetupPlugin[] => {
    const merged = new Map<string, ChannelSetupPlugin>();
    for (const plugin of listChannelSetupPlugins()) {
      if (shouldShowChannelInSetup(plugin.meta)) {
        merged.set(plugin.id, plugin);
      }
    }
    for (const plugin of scopedPluginsById.values()) {
      if (shouldShowChannelInSetup(plugin.meta)) {
        merged.set(plugin.id, plugin);
      }
    }
    return [...merged.values()];
  };
  const loadScopedChannelPlugin = async (
    channel: ChannelChoice,
    pluginId?: string,
  ): Promise<ChannelSetupPlugin | undefined> => {
    const existing = getVisibleChannelPlugin(channel);
    if (existing) {
      return existing;
    }
    const snapshot = loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg: next,
      runtime,
      channel,
      ...(pluginId ? { pluginId } : {}),
      workspaceDir: resolveWorkspaceDir(),
    });
    const plugin =
      snapshot.channels.find((entry) => entry.plugin.id === channel)?.plugin ??
      snapshot.channelSetups.find((entry) => entry.plugin.id === channel)?.plugin;
    if (plugin) {
      rememberScopedPlugin(plugin);
      return plugin;
    }
    return undefined;
  };
  const getVisibleSetupFlowAdapter = (channel: ChannelChoice) => {
    const scopedPlugin = scopedPluginsById.get(channel);
    if (scopedPlugin) {
      return resolveChannelSetupWizardAdapterForPlugin(scopedPlugin);
    }
    return resolveChannelSetupWizardAdapterForPlugin(getChannelSetupPlugin(channel));
  };
  const preloadConfiguredExternalPlugins = () => {
    // Keep setup memory bounded by snapshot-loading only configured external plugins.
    const workspaceDir = resolveWorkspaceDir();
    // Security: keep trusted workspace overrides eligible during setup while
    // Falling back from untrusted workspace shadows to the non-workspace entry.
    for (const entry of listTrustedChannelPluginCatalogEntries({ cfg: next, workspaceDir })) {
      const channel = entry.id as ChannelChoice;
      if (getVisibleChannelPlugin(channel)) {
        continue;
      }
      const explicitlyEnabled =
        next.plugins?.entries?.[entry.pluginId ?? channel]?.enabled === true;
      if (!explicitlyEnabled && !isChannelConfigured(next, channel)) {
        continue;
      }
      void loadScopedChannelPlugin(channel, entry.pluginId);
    }
  };
  preloadConfiguredExternalPlugins();

  const {
    installedPlugins,
    catalogEntries,
    installedCatalogEntries,
    statusByChannel,
    statusLines,
  } = await collectChannelStatus({
    accountOverrides,
    cfg: next,
    installedPlugins: listVisibleInstalledPlugins(),
    options,
    resolveAdapter: getVisibleSetupFlowAdapter,
  });
  if (!options?.skipStatusNote && statusLines.length > 0) {
    await prompter.note(statusLines.join("\n"), "Channel status");
  }

  const shouldConfigure = options?.skipConfirm
    ? true
    : await prompter.confirm({
        initialValue: true,
        message: "Configure chat channels now?",
      });
  if (!shouldConfigure) {
    return cfg;
  }

  const corePrimer = listChatChannels()
    .filter((meta) => shouldShowChannelInSetup(meta))
    .map((meta) => ({
      blurb: meta.blurb,
      id: meta.id,
      label: meta.label,
    }));
  const coreIds = new Set(corePrimer.map((entry) => entry.id));
  const primerChannels = [
    ...corePrimer,
    ...installedPlugins
      .filter((plugin) => !coreIds.has(plugin.id))
      .map((plugin) => ({
        blurb: plugin.meta.blurb,
        id: plugin.id,
        label: plugin.meta.label,
      })),
    ...installedCatalogEntries
      .filter((entry) => !coreIds.has(entry.id as ChannelChoice))
      .map((entry) => ({
        blurb: entry.meta.blurb,
        id: entry.id as ChannelChoice,
        label: entry.meta.label,
      })),
    ...catalogEntries
      .filter((entry) => !coreIds.has(entry.id as ChannelChoice))
      .map((entry) => ({
        blurb: entry.meta.blurb,
        id: entry.id as ChannelChoice,
        label: entry.meta.label,
      })),
  ];
  await noteChannelPrimer(prompter, primerChannels);

  const quickstartDefault =
    options?.initialSelection?.[0] ?? resolveQuickstartDefault(statusByChannel);

  const shouldPromptAccountIds = options?.promptAccountIds === true;
  const accountIdsByChannel = new Map<ChannelChoice, string>();
  const recordAccount = (channel: ChannelChoice, accountId: string) => {
    options?.onAccountId?.(channel, accountId);
    const adapter = getVisibleSetupFlowAdapter(channel);
    adapter?.onAccountRecorded?.(accountId, options);
    accountIdsByChannel.set(channel, accountId);
  };

  const selection: ChannelChoice[] = [];
  const addSelection = (channel: ChannelChoice) => {
    if (!selection.includes(channel)) {
      selection.push(channel);
    }
  };

  const resolveDisabledHint = (channel: ChannelChoice): string | undefined => {
    if (
      typeof (next.channels as Record<string, { enabled?: boolean }> | undefined)?.[channel]
        ?.enabled === "boolean"
    ) {
      return (next.channels as Record<string, { enabled?: boolean }>)[channel]?.enabled === false
        ? "disabled"
        : undefined;
    }
    const plugin = getVisibleChannelPlugin(channel);
    if (!plugin) {
      if (next.plugins?.entries?.[channel]?.enabled === false) {
        return "plugin disabled";
      }
      if (next.plugins?.enabled === false) {
        return "plugins disabled";
      }
      return undefined;
    }
    const accountId = resolveChannelDefaultAccountId({ cfg: next, plugin });
    const account = plugin.config.resolveAccount(next, accountId);
    let enabled: boolean | undefined;
    if (plugin.config.isEnabled) {
      enabled = plugin.config.isEnabled(account, next);
    } else if (typeof (account as { enabled?: boolean })?.enabled === "boolean") {
      ({ enabled } = account as { enabled?: boolean });
    }
    return enabled === false ? "disabled" : undefined;
  };

  const getChannelEntries = () => {
    const resolved = resolveChannelSetupEntries({
      cfg: next,
      installedPlugins: listVisibleInstalledPlugins(),
      workspaceDir: resolveWorkspaceDir(),
    });
    return {
      catalogById: resolved.installableCatalogById,
      entries: resolved.entries,
      installedCatalogById: resolved.installedCatalogById,
    };
  };

  const refreshStatus = async (channel: ChannelChoice) => {
    const adapter = getVisibleSetupFlowAdapter(channel);
    if (!adapter) {
      return;
    }
    const status = await adapter.getStatus({ accountOverrides, cfg: next, options });
    statusByChannel.set(channel, status);
  };

  const enableBundledPluginForSetup = async (channel: ChannelChoice): Promise<boolean> => {
    if (getVisibleChannelPlugin(channel)) {
      await refreshStatus(channel);
      return true;
    }
    const result = enablePluginInConfig(next, channel);
    next = result.config;
    if (!result.enabled) {
      await prompter.note(
        `Cannot enable ${channel}: ${result.reason ?? "plugin disabled"}.`,
        "Channel setup",
      );
      return false;
    }
    const plugin = await loadScopedChannelPlugin(channel);
    const adapter = getVisibleSetupFlowAdapter(channel);
    if (!plugin) {
      if (adapter) {
        await prompter.note(
          `${channel} plugin not available (continuing with setup). If the channel still doesn't work after setup, run \`${formatCliCommand(
            "openclaw plugins list",
          )}\` and \`${formatCliCommand("openclaw plugins enable " + channel)}\`, then restart the gateway.`,
          "Channel setup",
        );
        await refreshStatus(channel);
        return true;
      }
      await prompter.note(`${channel} plugin not available.`, "Channel setup");
      return false;
    }
    await refreshStatus(channel);
    return true;
  };

  const applySetupResult = async (channel: ChannelChoice, result: ChannelSetupResult) => {
    const previousCfg = next;
    next = result.cfg;
    const adapter = getVisibleSetupFlowAdapter(channel);
    if (result.accountId) {
      recordAccount(channel, result.accountId);
      if (adapter?.afterConfigWritten) {
        options?.onPostWriteHook?.({
          accountId: result.accountId,
          channel,
          run: async ({ cfg, runtime }) =>
            await adapter.afterConfigWritten?.({
              accountId: result.accountId!,
              cfg,
              previousCfg,
              runtime,
            }),
        });
      }
    }
    addSelection(channel);
    await refreshStatus(channel);
  };

  const applyCustomSetupResult = async (
    channel: ChannelChoice,
    result: ChannelSetupConfiguredResult,
  ) => {
    if (result === "skip") {
      return false;
    }
    await applySetupResult(channel, result);
    return true;
  };

  const configureChannel = async (channel: ChannelChoice) => {
    const adapter = getVisibleSetupFlowAdapter(channel);
    if (!adapter) {
      await prompter.note(`${channel} does not support guided setup yet.`, "Channel setup");
      return;
    }
    const result = await adapter.configure({
      accountOverrides,
      cfg: next,
      forceAllowFrom: forceAllowFromChannels.has(channel),
      options,
      prompter,
      runtime,
      shouldPromptAccountIds,
    });
    await applySetupResult(channel, result);
  };

  const handleConfiguredChannel = async (channel: ChannelChoice, label: string) => {
    const plugin = getVisibleChannelPlugin(channel);
    const adapter = getVisibleSetupFlowAdapter(channel);
    if (adapter?.configureWhenConfigured) {
      const custom = await adapter.configureWhenConfigured({
        accountOverrides,
        cfg: next,
        configured: true,
        forceAllowFrom: forceAllowFromChannels.has(channel),
        label,
        options,
        prompter,
        runtime,
        shouldPromptAccountIds,
      });
      if (!(await applyCustomSetupResult(channel, custom))) {
        return;
      }
      return;
    }
    const supportsDisable = Boolean(
      options?.allowDisable && (plugin?.config.setAccountEnabled || adapter?.disable),
    );
    const supportsDelete = Boolean(options?.allowDisable && plugin?.config.deleteAccount);
    const action = await promptConfiguredAction({
      label,
      prompter,
      supportsDelete,
      supportsDisable,
    });

    if (action === "skip") {
      return;
    }
    if (action === "update") {
      await configureChannel(channel);
      return;
    }
    if (!options?.allowDisable) {
      return;
    }

    if (action === "delete" && !supportsDelete) {
      await prompter.note(`${label} does not support deleting config entries.`, "Remove channel");
      return;
    }

    const shouldPromptAccount =
      action === "delete"
        ? Boolean(plugin?.config.deleteAccount)
        : Boolean(plugin?.config.setAccountEnabled);
    const accountId = shouldPromptAccount
      ? await promptRemovalAccountId({
          cfg: next,
          channel,
          label,
          plugin,
          prompter,
        })
      : DEFAULT_ACCOUNT_ID;
    const resolvedAccountId =
      normalizeAccountId(accountId) ??
      (plugin ? resolveChannelDefaultAccountId({ cfg: next, plugin }) : DEFAULT_ACCOUNT_ID);
    const accountLabel = formatAccountLabel(resolvedAccountId);

    if (action === "delete") {
      const confirmed = await prompter.confirm({
        initialValue: false,
        message: `Delete ${label} account "${accountLabel}"?`,
      });
      if (!confirmed) {
        return;
      }
      if (plugin?.config.deleteAccount) {
        next = plugin.config.deleteAccount({ accountId: resolvedAccountId, cfg: next });
      }
      await refreshStatus(channel);
      return;
    }

    if (plugin?.config.setAccountEnabled) {
      next = plugin.config.setAccountEnabled({
        accountId: resolvedAccountId,
        cfg: next,
        enabled: false,
      });
    } else if (adapter?.disable) {
      next = adapter.disable(next);
    }
    await refreshStatus(channel);
  };

  const handleChannelChoice = async (channel: ChannelChoice) => {
    const { catalogById, installedCatalogById } = getChannelEntries();
    const catalogEntry = catalogById.get(channel);
    const installedCatalogEntry = installedCatalogById.get(channel);
    if (catalogEntry) {
      const workspaceDir = resolveWorkspaceDir();
      const result = await ensureChannelSetupPluginInstalled({
        cfg: next,
        entry: catalogEntry,
        prompter,
        runtime,
        workspaceDir,
      });
      next = result.cfg;
      if (!result.installed) {
        return;
      }
      await loadScopedChannelPlugin(channel, result.pluginId ?? catalogEntry.pluginId);
      await refreshStatus(channel);
    } else if (installedCatalogEntry) {
      const plugin = await loadScopedChannelPlugin(channel, installedCatalogEntry.pluginId);
      if (!plugin) {
        await prompter.note(`${channel} plugin not available.`, "Channel setup");
        return;
      }
      await refreshStatus(channel);
    } else {
      const enabled = await enableBundledPluginForSetup(channel);
      if (!enabled) {
        return;
      }
    }

    const plugin = getVisibleChannelPlugin(channel);
    const adapter = getVisibleSetupFlowAdapter(channel);
    const label = plugin?.meta.label ?? catalogEntry?.meta.label ?? channel;
    const status = statusByChannel.get(channel);
    const configured = status?.configured ?? false;
    if (adapter?.configureInteractive) {
      const custom = await adapter.configureInteractive({
        accountOverrides,
        cfg: next,
        configured,
        forceAllowFrom: forceAllowFromChannels.has(channel),
        label,
        options,
        prompter,
        runtime,
        shouldPromptAccountIds,
      });
      if (!(await applyCustomSetupResult(channel, custom))) {
        return;
      }
      return;
    }
    if (configured) {
      await handleConfiguredChannel(channel, label);
      return;
    }
    await configureChannel(channel);
  };

  if (options?.quickstartDefaults) {
    const { entries } = getChannelEntries();
    const choice = await prompter.select({
      initialValue: quickstartDefault,
      message: "Select channel (QuickStart)",
      options: [
        ...resolveChannelSetupSelectionContributions({
          entries,
          resolveDisabledHint,
          statusByChannel,
        }).map((contribution) => contribution.option),
        {
          hint: `You can add channels later via \`${formatCliCommand("openclaw channels add")}\``,
          label: "Skip for now",
          value: "__skip__",
        },
      ],
    });
    if (choice !== "__skip__") {
      await handleChannelChoice(choice);
    }
  } else {
    const doneValue = "__done__" as const;
    const initialValue = options?.initialSelection?.[0] ?? quickstartDefault;
    while (true) {
      const { entries } = getChannelEntries();
      const choice = await prompter.select({
        initialValue,
        message: "Select a channel",
        options: [
          ...resolveChannelSetupSelectionContributions({
            entries,
            resolveDisabledHint,
            statusByChannel,
          }).map((contribution) => contribution.option),
          {
            hint: selection.length > 0 ? "Done" : "Skip for now",
            label: "Finished",
            value: doneValue,
          },
        ],
      });
      if (choice === doneValue) {
        break;
      }
      await handleChannelChoice(choice);
    }
  }

  options?.onSelection?.(selection);

  const selectedLines = resolveChannelSelectionNoteLines({
    cfg: next,
    installedPlugins: listVisibleInstalledPlugins(),
    selection,
  });
  if (selectedLines.length > 0) {
    await prompter.note(selectedLines.join("\n"), "Selected channels");
  }

  if (!options?.skipDmPolicyPrompt) {
    next = await maybeConfigureDmPolicies({
      accountIdsByChannel,
      cfg: next,
      prompter,
      resolveAdapter: getVisibleSetupFlowAdapter,
      selection,
    });
  }

  return next;
}
