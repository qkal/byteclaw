import type {
  Button,
  StringSelectMenu} from "@buape/carbon";
import {
  type AutocompleteInteraction,
  type ButtonInteraction,
  ChannelType,
  Command,
  type CommandInteraction,
  type CommandOptions,
  type StringSelectMenuInteraction,
  type TopLevelComponents,
} from "@buape/carbon";
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-streaming";
import {
  resolveCommandAuthorizedFromAuthorizers,
  resolveNativeCommandSessionTargets,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig, loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { buildPairingReply } from "openclaw/plugin-sdk/conversation-runtime";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import {
  type ChatCommandDefinition,
  type CommandArgDefinition,
  type CommandArgValues,
  type CommandArgs,
  type NativeCommandSpec,
  buildCommandTextFromArgs,
  findCommandByNativeName,
  parseCommandArgs,
  resolveCommandArgChoices,
  resolveCommandArgMenu,
  serializeCommandArgs,
} from "openclaw/plugin-sdk/native-command-registry";
import * as pluginRuntime from "openclaw/plugin-sdk/plugin-runtime";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import {
  type ReplyPayload,
  dispatchReplyWithDispatcher,
} from "openclaw/plugin-sdk/reply-dispatch-runtime";
import {
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
} from "openclaw/plugin-sdk/reply-payload";
import { createSubsystemLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import {
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordChannelPolicyCommandAuthorizer,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess,
  resolveGroupDmAllow,
} from "./allow-list.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";
import { buildDiscordNativeCommandContext } from "./native-command-context.js";
import { resolveDiscordNativeInteractionRouteState } from "./native-command-route.js";
import {
  type DiscordCommandArgContext,
  type DiscordModelPickerContext,
  buildDiscordCommandArgMenu,
  createDiscordCommandArgFallbackButton as createDiscordCommandArgFallbackButtonUi,
  createDiscordModelPickerFallbackButton as createDiscordModelPickerFallbackButtonUi,
  createDiscordModelPickerFallbackSelect as createDiscordModelPickerFallbackSelectUi,
  replyWithDiscordModelPickerProviders,
  resolveDiscordNativeChoiceContext,
  shouldOpenDiscordModelPickerFromCommand,
} from "./native-command-ui.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";
import type { ThreadBindingManager } from "./thread-bindings.js";
import { resolveDiscordThreadParentInfo } from "./threading.js";

type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];
const log = createSubsystemLogger("discord/native-command");
// Discord application command and option descriptions are limited to 1-100 chars.
// https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-structure
const DISCORD_COMMAND_DESCRIPTION_MAX = 100;
let matchPluginCommandImpl = pluginRuntime.matchPluginCommand;
let executePluginCommandImpl = pluginRuntime.executePluginCommand;
let dispatchReplyWithDispatcherImpl = dispatchReplyWithDispatcher;
let resolveDiscordNativeInteractionRouteStateImpl = resolveDiscordNativeInteractionRouteState;

export const __testing = {
  setDispatchReplyWithDispatcher(
    next: typeof dispatchReplyWithDispatcher,
  ): typeof dispatchReplyWithDispatcher {
    const previous = dispatchReplyWithDispatcherImpl;
    dispatchReplyWithDispatcherImpl = next;
    return previous;
  },
  setExecutePluginCommand(
    next: typeof pluginRuntime.executePluginCommand,
  ): typeof pluginRuntime.executePluginCommand {
    const previous = executePluginCommandImpl;
    executePluginCommandImpl = next;
    return previous;
  },
  setMatchPluginCommand(
    next: typeof pluginRuntime.matchPluginCommand,
  ): typeof pluginRuntime.matchPluginCommand {
    const previous = matchPluginCommandImpl;
    matchPluginCommandImpl = next;
    return previous;
  },
  setResolveDiscordNativeInteractionRouteState(
    next: typeof resolveDiscordNativeInteractionRouteState,
  ): typeof resolveDiscordNativeInteractionRouteState {
    const previous = resolveDiscordNativeInteractionRouteStateImpl;
    resolveDiscordNativeInteractionRouteStateImpl = next;
    return previous;
  },
};

function truncateDiscordCommandDescription(params: { value: string; label: string }): string {
  const { value, label } = params;
  if (value.length <= DISCORD_COMMAND_DESCRIPTION_MAX) {
    return value;
  }
  log.warn(
    `discord: truncating native command description (${label}) from ${value.length} to ${DISCORD_COMMAND_DESCRIPTION_MAX}: ${JSON.stringify(value)}`,
  );
  return value.slice(0, DISCORD_COMMAND_DESCRIPTION_MAX);
}

function resolveDiscordCommandLogLabel(command: ChatCommandDefinition): string {
  if (typeof command.nativeName === "string" && command.nativeName.trim().length > 0) {
    return command.nativeName;
  }
  return command.key;
}

function resolveDiscordNativeCommandAllowlistAccess(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  sender: { id: string; name?: string; tag?: string };
  chatType: "direct" | "group" | "thread" | "channel";
  conversationId?: string;
  guildId?: string | null;
}) {
  const commandsAllowFrom = params.cfg.commands?.allowFrom;
  if (!commandsAllowFrom || typeof commandsAllowFrom !== "object") {
    return { allowed: false, configured: false } as const;
  }
  const rawAllowList = Array.isArray(commandsAllowFrom.discord)
    ? commandsAllowFrom.discord
    : commandsAllowFrom["*"];
  if (!Array.isArray(rawAllowList)) {
    return { allowed: false, configured: false } as const;
  }
  // Check guild-level entries (e.g. "guild:123456") before user matching.
  const guildId = normalizeOptionalString(params.guildId);
  if (guildId) {
    for (const entry of rawAllowList) {
      const text = normalizeOptionalString(String(entry)) ?? "";
      if (text.startsWith("guild:") && text.slice("guild:".length) === guildId) {
        return { allowed: true, configured: true } as const;
      }
    }
  }
  const allowList = normalizeDiscordAllowList(rawAllowList.map(String), [
    "discord:",
    "user:",
    "pk:",
  ]);
  if (!allowList) {
    return { allowed: false, configured: true } as const;
  }
  const match = resolveDiscordAllowListMatch({
    allowList,
    allowNameMatching: false,
    candidate: params.sender,
  });
  return { allowed: match.allowed, configured: true } as const;
}

function resolveDiscordGuildNativeCommandAuthorized(params: {
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  useAccessGroups: boolean;
  commandsAllowFromAccess: ReturnType<typeof resolveDiscordNativeCommandAllowlistAccess>;
  guildInfo?: ReturnType<typeof resolveDiscordGuildEntry> | null;
  channelConfig?: ReturnType<typeof resolveDiscordChannelConfigWithFallback> | null;
  memberRoleIds: string[];
  sender: { id: string; name?: string; tag?: string };
  allowNameMatching: boolean;
  ownerAllowListConfigured: boolean;
  ownerAllowed: boolean;
}) {
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
    groupPolicy: params.discordConfig?.groupPolicy,
    providerConfigPresent: params.cfg.channels?.discord !== undefined,
  });
  const policyAuthorizer = resolveDiscordChannelPolicyCommandAuthorizer({
    channelConfig: params.channelConfig,
    groupPolicy,
    guildInfo: params.guildInfo,
  });
  if (!policyAuthorizer.allowed) {
    return false;
  }
  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    allowNameMatching: params.allowNameMatching,
    channelConfig: params.channelConfig,
    guildInfo: params.guildInfo,
    memberRoleIds: params.memberRoleIds,
    sender: params.sender,
  });
  const commandAllowlistAuthorizer = {
    allowed: params.commandsAllowFromAccess.allowed,
    configured: params.commandsAllowFromAccess.configured,
  };
  const ownerAuthorizer = {
    allowed: params.ownerAllowed,
    configured: params.ownerAllowListConfigured,
  };
  const memberAuthorizer = {
    allowed: memberAllowed,
    configured: hasAccessRestrictions,
  };
  const fallbackAuthorizers = [policyAuthorizer, ownerAuthorizer, memberAuthorizer];
  return resolveCommandAuthorizedFromAuthorizers({
    authorizers: params.useAccessGroups
      ? (params.commandsAllowFromAccess.configured
        ? [commandAllowlistAuthorizer]
        : fallbackAuthorizers)
      : (params.commandsAllowFromAccess.configured
        ? [commandAllowlistAuthorizer]
        : fallbackAuthorizers),
    modeWhenAccessGroupsOff: "configured",
    useAccessGroups: params.useAccessGroups,
  });
}

function buildDiscordCommandOptions(params: {
  command: ChatCommandDefinition;
  cfg: ReturnType<typeof loadConfig>;
  authorizeChoiceContext?: (interaction: AutocompleteInteraction) => Promise<boolean>;
  resolveChoiceContext?: (
    interaction: AutocompleteInteraction,
  ) => Promise<{ provider?: string; model?: string } | null>;
}): CommandOptions | undefined {
  const { command, cfg, authorizeChoiceContext, resolveChoiceContext } = params;
  const commandLabel = resolveDiscordCommandLogLabel(command);
  const {args} = command;
  if (!args || args.length === 0) {
    return undefined;
  }
  return args.map((arg) => {
    const required = arg.required ?? false;
    if (arg.type === "number") {
      return {
        description: truncateDiscordCommandDescription({
          label: `command:${commandLabel} arg:${arg.name}`,
          value: arg.description,
        }),
        name: arg.name,
        required,
        type: ApplicationCommandOptionType.Number,
      };
    }
    if (arg.type === "boolean") {
      return {
        description: truncateDiscordCommandDescription({
          label: `command:${commandLabel} arg:${arg.name}`,
          value: arg.description,
        }),
        name: arg.name,
        required,
        type: ApplicationCommandOptionType.Boolean,
      };
    }
    const resolvedChoices = resolveCommandArgChoices({ arg, cfg, command });
    const shouldAutocomplete =
      arg.preferAutocomplete === true ||
      (resolvedChoices.length > 0 &&
        (typeof arg.choices === "function" || resolvedChoices.length > 25));
    const autocomplete = shouldAutocomplete
      ? async (interaction: AutocompleteInteraction) => {
          if (
            typeof arg.choices === "function" &&
            resolveChoiceContext &&
            authorizeChoiceContext &&
            !(await authorizeChoiceContext(interaction))
          ) {
            await interaction.respond([]);
            return;
          }
          const focused = interaction.options.getFocused();
          const focusValue = normalizeLowercaseStringOrEmpty(focused?.value);
          const context =
            typeof arg.choices === "function" && resolveChoiceContext
              ? await resolveChoiceContext(interaction)
              : null;
          const choices = resolveCommandArgChoices({
            arg,
            cfg,
            command,
            model: context?.model,
            provider: context?.provider,
          });
          const filtered = focusValue
            ? choices.filter((choice) =>
                normalizeLowercaseStringOrEmpty(choice.label).includes(focusValue),
              )
            : choices;
          await interaction.respond(
            filtered.slice(0, 25).map((choice) => ({ name: choice.label, value: choice.value })),
          );
        }
      : undefined;
    const choices =
      resolvedChoices.length > 0 && !autocomplete
        ? resolvedChoices
            .slice(0, 25)
            .map((choice) => ({ name: choice.label, value: choice.value }))
        : undefined;
    return {
      autocomplete,
      choices,
      description: truncateDiscordCommandDescription({
        label: `command:${commandLabel} arg:${arg.name}`,
        value: arg.description,
      }),
      name: arg.name,
      required,
      type: ApplicationCommandOptionType.String,
    };
  }) satisfies CommandOptions;
}

function shouldBypassConfiguredAcpEnsure(commandName: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(commandName);
  // Recovery slash commands still need configured ACP readiness so stale dead
  // Bindings are recreated before /new or /reset dispatches through them.
  return normalized === "acp";
}

function shouldBypassConfiguredAcpGuildGuards(commandName: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(commandName);
  return normalized === "new" || normalized === "reset";
}

function resolveDiscordNativeGroupDmAccess(params: {
  isGroupDm: boolean;
  groupEnabled?: boolean;
  groupChannels?: string[];
  channelId: string;
  channelName?: string;
  channelSlug: string;
}): { allowed: true } | { allowed: false; reason: "disabled" | "not-allowlisted" } {
  if (!params.isGroupDm) {
    return { allowed: true };
  }
  if (params.groupEnabled === false) {
    return { allowed: false, reason: "disabled" };
  }
  if (
    !resolveGroupDmAllow({
      channelId: params.channelId,
      channelName: params.channelName,
      channelSlug: params.channelSlug,
      channels: params.groupChannels,
    })
  ) {
    return { allowed: false, reason: "not-allowlisted" };
  }
  return { allowed: true };
}

async function resolveDiscordNativeAutocompleteAuthorized(params: {
  interaction: AutocompleteInteraction;
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
}): Promise<boolean> {
  const { interaction, cfg, discordConfig, accountId } = params;
  const {user} = interaction;
  if (!user) {
    return false;
  }
  const sender = resolveDiscordSenderIdentity({ author: user, pluralkitInfo: null });
  const {channel} = interaction;
  const channelType = channel?.type;
  const isDirectMessage = channelType === ChannelType.DM;
  const isGroupDm = channelType === ChannelType.GroupDM;
  const isThreadChannel =
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread;
  const channelName = channel && "name" in channel ? (channel.name as string) : undefined;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const rawChannelId = channel?.id ?? "";
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => String(roleId))
    : [];
  const allowNameMatching = isDangerousNameMatchingEnabled(discordConfig);
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
    allowFrom: discordConfig?.allowFrom ?? discordConfig?.dm?.allowFrom ?? [],
    allowNameMatching,
    sender: {
      id: sender.id,
      name: sender.name,
      tag: sender.tag,
    },
  });
  const commandsAllowFromAccess = resolveDiscordNativeCommandAllowlistAccess({
    accountId,
    cfg,
    chatType: isDirectMessage
      ? "direct"
      : isThreadChannel
        ? "thread"
        : interaction.guild
          ? "channel"
          : "group",
    conversationId: rawChannelId || undefined,
    guildId: interaction.guild?.id,
    sender: {
      id: sender.id,
      name: sender.name,
      tag: sender.tag,
    },
  });
  const guildInfo = resolveDiscordGuildEntry({
    guild: interaction.guild ?? undefined,
    guildEntries: discordConfig?.guilds,
    guildId: interaction.guild?.id ?? undefined,
  });
  let threadParentId: string | undefined;
  let threadParentName: string | undefined;
  let threadParentSlug = "";
  if (interaction.guild && channel && isThreadChannel && rawChannelId) {
    const channelInfo = await resolveDiscordChannelInfo(interaction.client, rawChannelId);
    const parentInfo = await resolveDiscordThreadParentInfo({
      channelInfo,
      client: interaction.client,
      threadChannel: {
        id: rawChannelId,
        name: channelName,
        parent: undefined,
        parentId: "parentId" in channel ? (channel.parentId ?? undefined) : undefined,
      },
    });
    threadParentId = parentInfo.id;
    threadParentName = parentInfo.name;
    threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";
  }
  const channelConfig = interaction.guild
    ? resolveDiscordChannelConfigWithFallback({
        channelId: rawChannelId,
        channelName,
        channelSlug,
        guildInfo,
        parentId: threadParentId,
        parentName: threadParentName,
        parentSlug: threadParentSlug,
        scope: isThreadChannel ? "thread" : "channel",
      })
    : null;
  if (channelConfig?.enabled === false) {
    return false;
  }
  if (interaction.guild && channelConfig?.allowed === false) {
    return false;
  }
  if (useAccessGroups && interaction.guild) {
    const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
      defaultGroupPolicy: cfg.channels?.defaults?.groupPolicy,
      groupPolicy: discordConfig?.groupPolicy,
      providerConfigPresent: cfg.channels?.discord !== undefined,
    });
    const policyAuthorizer = resolveDiscordChannelPolicyCommandAuthorizer({
      channelConfig,
      groupPolicy,
      guildInfo,
    });
    if (!policyAuthorizer.allowed) {
      return false;
    }
  }
  const dmEnabled = discordConfig?.dm?.enabled ?? true;
  const dmPolicy = discordConfig?.dmPolicy ?? discordConfig?.dm?.policy ?? "pairing";
  if (isDirectMessage) {
    if (!dmEnabled || dmPolicy === "disabled") {
      return false;
    }
    const dmAccess = await resolveDiscordDmCommandAccess({
      accountId,
      allowNameMatching,
      configuredAllowFrom: discordConfig?.allowFrom ?? discordConfig?.dm?.allowFrom ?? [],
      dmPolicy,
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
      },
      useAccessGroups,
    });
    if (dmAccess.decision !== "allow") {
      return false;
    }
  }
  const groupDmAccess = resolveDiscordNativeGroupDmAccess({
    channelId: rawChannelId,
    channelName,
    channelSlug,
    groupChannels: discordConfig?.dm?.groupChannels,
    groupEnabled: discordConfig?.dm?.groupEnabled,
    isGroupDm,
  });
  if (!groupDmAccess.allowed) {
    return false;
  }
  if (!isDirectMessage) {
    return resolveDiscordGuildNativeCommandAuthorized({
      allowNameMatching,
      cfg,
      channelConfig,
      commandsAllowFromAccess,
      discordConfig,
      guildInfo,
      memberRoleIds,
      ownerAllowListConfigured: ownerAllowList != null,
      ownerAllowed: ownerOk,
      sender,
      useAccessGroups,
    });
  }
  return true;
}

function readDiscordCommandArgs(
  interaction: CommandInteraction,
  definitions?: CommandArgDefinition[],
): CommandArgs | undefined {
  if (!definitions || definitions.length === 0) {
    return undefined;
  }
  const values: CommandArgValues = {};
  for (const definition of definitions) {
    let value: string | number | boolean | null | undefined;
    if (definition.type === "number") {
      value = interaction.options.getNumber(definition.name) ?? null;
    } else if (definition.type === "boolean") {
      value = interaction.options.getBoolean(definition.name) ?? null;
    } else {
      value = interaction.options.getString(definition.name) ?? null;
    }
    if (value != null) {
      values[definition.name] = value;
    }
  }
  return Object.keys(values).length > 0 ? { values } : undefined;
}

function isDiscordUnknownInteraction(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as {
    discordCode?: number;
    status?: number;
    message?: string;
    rawBody?: { code?: number; message?: string };
  };
  if (err.discordCode === 10_062 || err.rawBody?.code === 10_062) {
    return true;
  }
  if (err.status === 404 && /Unknown interaction/i.test(err.message ?? "")) {
    return true;
  }
  if (/Unknown interaction/i.test(err.rawBody?.message ?? "")) {
    return true;
  }
  return false;
}

function hasRenderableReplyPayload(payload: ReplyPayload): boolean {
  if (resolveSendableOutboundReplyParts(payload).hasContent) {
    return true;
  }
  const discordData = payload.channelData?.discord as
    | { components?: TopLevelComponents[] }
    | undefined;
  if (Array.isArray(discordData?.components) && discordData.components.length > 0) {
    return true;
  }
  return false;
}

async function safeDiscordInteractionCall<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (isDiscordUnknownInteraction(error)) {
      logVerbose(`discord: ${label} skipped (interaction expired)`);
      return null;
    }
    throw error;
  }
}

export function createDiscordNativeCommand(params: {
  command: NativeCommandSpec;
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  ephemeralDefault: boolean;
  threadBindings: ThreadBindingManager;
}): Command {
  const {
    command,
    cfg,
    discordConfig,
    accountId,
    sessionPrefix,
    ephemeralDefault,
    threadBindings,
  } = params;
  const commandDefinition =
    findCommandByNativeName(command.name, "discord") ??
    ({
      acceptsArgs: command.acceptsArgs,
      args: command.args,
      argsParsing: "none",
      description: command.description,
      key: command.name,
      nativeName: command.name,
      scope: "native",
      textAliases: [],
    } satisfies ChatCommandDefinition);
  const argDefinitions = commandDefinition.args ?? command.args;
  const commandOptions = buildDiscordCommandOptions({
    authorizeChoiceContext: async (interaction) =>
      await resolveDiscordNativeAutocompleteAuthorized({
        accountId,
        cfg,
        discordConfig,
        interaction,
      }),
    cfg,
    command: commandDefinition,
    resolveChoiceContext: async (interaction) =>
      resolveDiscordNativeChoiceContext({
        accountId,
        cfg,
        interaction,
        threadBindings,
      }),
  });
  const options = commandOptions
    ? (commandOptions satisfies CommandOptions)
    : (command.acceptsArgs
      ? ([
          {
            description: "Command input",
            name: "input",
            required: false,
            type: ApplicationCommandOptionType.String,
          },
        ] satisfies CommandOptions)
      : undefined);

  return new (class extends Command {
    name = command.name;
    description = truncateDiscordCommandDescription({
      label: `command:${command.name}`,
      value: command.description,
    });
    defer = false;
    ephemeral = ephemeralDefault;
    options = options;

    async run(interaction: CommandInteraction) {
      const deferred = await safeDiscordInteractionCall("interaction defer", () =>
        interaction.defer(),
      );
      if (deferred === null) {
        return;
      }
      const commandArgs = argDefinitions?.length
        ? readDiscordCommandArgs(interaction, argDefinitions)
        : (command.acceptsArgs
          ? parseCommandArgs(commandDefinition, interaction.options.getString("input") ?? "")
          : undefined);
      const commandArgsWithRaw = commandArgs
        ? ({
            ...commandArgs,
            raw: serializeCommandArgs(commandDefinition, commandArgs) ?? commandArgs.raw,
          } satisfies CommandArgs)
        : undefined;
      const prompt = buildCommandTextFromArgs(commandDefinition, commandArgsWithRaw);
      await dispatchDiscordCommandInteraction({
        interaction,
        prompt,
        command: commandDefinition,
        commandArgs: commandArgsWithRaw,
        cfg,
        discordConfig,
        accountId,
        sessionPrefix,
        // Slash commands are deferred up front, so all later responses must use
        // Follow-up/edit semantics instead of the initial reply endpoint.
        preferFollowUp: true,
        threadBindings,
      });
    }
  })();
}

async function dispatchDiscordCommandInteraction(params: {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  prompt: string;
  command: ChatCommandDefinition;
  commandArgs?: CommandArgs;
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  preferFollowUp: boolean;
  threadBindings: ThreadBindingManager;
  suppressReplies?: boolean;
}) {
  const {
    interaction,
    prompt,
    command,
    commandArgs,
    cfg,
    discordConfig,
    accountId,
    sessionPrefix,
    preferFollowUp,
    threadBindings,
    suppressReplies,
  } = params;
  const respond = async (content: string, options?: { ephemeral?: boolean }) => {
    const payload = {
      content,
      ...(options?.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
    };
    await safeDiscordInteractionCall("interaction reply", async () => {
      if (preferFollowUp) {
        await interaction.followUp(payload);
        return;
      }
      await interaction.reply(payload);
    });
  };

  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const {user} = interaction;
  if (!user) {
    return;
  }
  const sender = resolveDiscordSenderIdentity({ author: user, pluralkitInfo: null });
  const {channel} = interaction;
  const channelType = channel?.type;
  const isDirectMessage = channelType === ChannelType.DM;
  const isGroupDm = channelType === ChannelType.GroupDM;
  const isThreadChannel =
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread;
  const channelName = channel && "name" in channel ? (channel.name as string) : undefined;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const rawChannelId = channel?.id ?? "";
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => String(roleId))
    : [];
  const allowNameMatching = isDangerousNameMatchingEnabled(discordConfig);
  const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
    allowFrom: discordConfig?.allowFrom ?? discordConfig?.dm?.allowFrom ?? [],
    allowNameMatching,
    sender: {
      id: sender.id,
      name: sender.name,
      tag: sender.tag,
    },
  });
  const commandsAllowFromAccess = resolveDiscordNativeCommandAllowlistAccess({
    accountId,
    cfg,
    chatType: isDirectMessage
      ? "direct"
      : isThreadChannel
        ? "thread"
        : interaction.guild
          ? "channel"
          : "group",
    conversationId: rawChannelId || undefined,
    guildId: interaction.guild?.id,
    sender: {
      id: sender.id,
      name: sender.name,
      tag: sender.tag,
    },
  });
  const guildInfo = resolveDiscordGuildEntry({
    guild: interaction.guild ?? undefined,
    guildEntries: discordConfig?.guilds,
    guildId: interaction.guild?.id ?? undefined,
  });
  let threadParentId: string | undefined;
  let threadParentName: string | undefined;
  let threadParentSlug = "";
  if (interaction.guild && channel && isThreadChannel && rawChannelId) {
    // Threads inherit parent channel config unless explicitly overridden.
    const channelInfo = await resolveDiscordChannelInfo(interaction.client, rawChannelId);
    const parentInfo = await resolveDiscordThreadParentInfo({
      channelInfo,
      client: interaction.client,
      threadChannel: {
        id: rawChannelId,
        name: channelName,
        parent: undefined,
        parentId: "parentId" in channel ? (channel.parentId ?? undefined) : undefined,
      },
    });
    threadParentId = parentInfo.id;
    threadParentName = parentInfo.name;
    threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";
  }
  const channelConfig = interaction.guild
    ? resolveDiscordChannelConfigWithFallback({
        channelId: rawChannelId,
        channelName,
        channelSlug,
        guildInfo,
        parentId: threadParentId,
        parentName: threadParentName,
        parentSlug: threadParentSlug,
        scope: isThreadChannel ? "thread" : "channel",
      })
    : null;
  let nativeRouteStatePromise:
    | ReturnType<typeof resolveDiscordNativeInteractionRouteStateImpl>
    | undefined;
  const getNativeRouteState = () =>
    (nativeRouteStatePromise ??= resolveDiscordNativeInteractionRouteStateImpl({
      accountId,
      cfg,
      conversationId: rawChannelId || "unknown",
      directUserId: user.id,
      enforceConfiguredBindingReadiness: !shouldBypassConfiguredAcpEnsure(
        command.nativeName ?? command.key,
      ),
      guildId: interaction.guild?.id ?? undefined,
      isDirectMessage,
      isGroupDm,
      memberRoleIds,
      parentConversationId: threadParentId,
      threadBinding: isThreadChannel ? threadBindings.getByThreadId(rawChannelId) : undefined,
    }));
  const canBypassConfiguredAcpGuildGuards = async () => {
    if (
      !interaction.guild ||
      !shouldBypassConfiguredAcpGuildGuards(command.nativeName ?? command.key)
    ) {
      return false;
    }
    const routeState = await getNativeRouteState();
    return (
      routeState.effectiveRoute.matchedBy === "binding.channel" ||
      routeState.boundSessionKey != null ||
      routeState.configuredBinding != null ||
      routeState.configuredRoute != null
    );
  };
  if (channelConfig?.enabled === false && !(await canBypassConfiguredAcpGuildGuards())) {
    await respond("This channel is disabled.");
    return;
  }
  if (
    interaction.guild &&
    channelConfig?.allowed === false &&
    !(await canBypassConfiguredAcpGuildGuards())
  ) {
    await respond("This channel is not allowed.");
    return;
  }
  if (useAccessGroups && interaction.guild) {
    const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
      defaultGroupPolicy: cfg.channels?.defaults?.groupPolicy,
      groupPolicy: discordConfig?.groupPolicy,
      providerConfigPresent: cfg.channels?.discord !== undefined,
    });
    const policyAuthorizer = resolveDiscordChannelPolicyCommandAuthorizer({
      channelConfig,
      groupPolicy,
      guildInfo,
    });
    if (!policyAuthorizer.allowed && !(await canBypassConfiguredAcpGuildGuards())) {
      await respond("This channel is not allowed.");
      return;
    }
  }
  const dmEnabled = discordConfig?.dm?.enabled ?? true;
  const dmPolicy = discordConfig?.dmPolicy ?? discordConfig?.dm?.policy ?? "pairing";
  let commandAuthorized = true;
  if (isDirectMessage) {
    if (!dmEnabled || dmPolicy === "disabled") {
      await respond("Discord DMs are disabled.");
      return;
    }
    const dmAccess = await resolveDiscordDmCommandAccess({
      accountId,
      allowNameMatching,
      configuredAllowFrom: discordConfig?.allowFrom ?? discordConfig?.dm?.allowFrom ?? [],
      dmPolicy,
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
      },
      useAccessGroups,
    });
    ({ commandAuthorized } = dmAccess);
    if (dmAccess.decision !== "allow") {
      await handleDiscordDmCommandDecision({
        accountId,
        dmAccess,
        onPairingCreated: async (code) => {
          await respond(
            buildPairingReply({
              channel: "discord",
              code,
              idLine: `Your Discord user id: ${user.id}`,
            }),
            { ephemeral: true },
          );
        },
        onUnauthorized: async () => {
          await respond("You are not authorized to use this command.", { ephemeral: true });
        },
        sender: {
          id: user.id,
          name: sender.name,
          tag: sender.tag,
        },
      });
      return;
    }
  }
  const groupDmAccess = resolveDiscordNativeGroupDmAccess({
    channelId: rawChannelId,
    channelName,
    channelSlug,
    groupChannels: discordConfig?.dm?.groupChannels,
    groupEnabled: discordConfig?.dm?.groupEnabled,
    isGroupDm,
  });
  if (!groupDmAccess.allowed) {
    await respond(
      groupDmAccess.reason === "disabled"
        ? "Discord group DMs are disabled."
        : "This group DM is not allowed.",
    );
    return;
  }
  if (!isDirectMessage) {
    commandAuthorized = resolveDiscordGuildNativeCommandAuthorized({
      allowNameMatching,
      cfg,
      channelConfig,
      commandsAllowFromAccess,
      discordConfig,
      guildInfo,
      memberRoleIds,
      ownerAllowListConfigured: ownerAllowList != null,
      ownerAllowed: ownerOk,
      sender,
      useAccessGroups,
    });
    if (!commandAuthorized && !(await canBypassConfiguredAcpGuildGuards())) {
      await respond("You are not authorized to use this command.", { ephemeral: true });
      return;
    }
  }

  const menu = resolveCommandArgMenu({
    args: commandArgs,
    cfg,
    command,
  });
  if (menu) {
    const menuPayload = buildDiscordCommandArgMenu({
      command,
      ctx: {
        accountId,
        cfg,
        discordConfig,
        sessionPrefix,
        threadBindings,
      },
      dispatchCommandInteraction: dispatchDiscordCommandInteraction,
      interaction: interaction as CommandInteraction,
      menu,
      safeInteractionCall: safeDiscordInteractionCall,
    });
    if (preferFollowUp) {
      await safeDiscordInteractionCall("interaction follow-up", () =>
        interaction.followUp({
          components: menuPayload.components,
          content: menuPayload.content,
          ephemeral: true,
        }),
      );
      return;
    }
    await safeDiscordInteractionCall("interaction reply", () =>
      interaction.reply({
        components: menuPayload.components,
        content: menuPayload.content,
        ephemeral: true,
      }),
    );
    return;
  }

  const pluginMatch = matchPluginCommandImpl(prompt);
  if (pluginMatch) {
    if (suppressReplies) {
      return;
    }
    const channelId = rawChannelId || "unknown";
    const isThreadChannel =
      interaction.channel?.type === ChannelType.PublicThread ||
      interaction.channel?.type === ChannelType.PrivateThread ||
      interaction.channel?.type === ChannelType.AnnouncementThread;
    const messageThreadId = !isDirectMessage && isThreadChannel ? channelId : undefined;
    const threadParentId =
      !isDirectMessage && isThreadChannel ? (interaction.channel.parentId ?? undefined) : undefined;
    const { effectiveRoute } = await getNativeRouteState();
    const pluginReply = await executePluginCommandImpl({
      accountId,
      args: pluginMatch.args,
      channel: "discord",
      channelId,
      command: pluginMatch.command,
      commandBody: prompt,
      config: cfg,
      from: isDirectMessage
        ? `discord:${user.id}`
        : (isGroupDm
          ? `discord:group:${channelId}`
          : `discord:channel:${channelId}`),
      isAuthorizedSender: commandAuthorized,
      messageThreadId,
      senderId: sender.id,
      sessionKey: effectiveRoute.sessionKey,
      threadParentId,
      to: `slash:${user.id}`,
    });
    if (!hasRenderableReplyPayload(pluginReply)) {
      await respond("Done.");
      return;
    }
    await deliverDiscordInteractionReply({
      chunkMode: resolveChunkMode(cfg, "discord", accountId),
      interaction,
      maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({ accountId, cfg, discordConfig }),
      payload: pluginReply,
      preferFollowUp,
      textLimit: resolveTextChunkLimit(cfg, "discord", accountId, {
        fallbackLimit: 2000,
      }),
    });
    return;
  }

  const pickerCommandContext = shouldOpenDiscordModelPickerFromCommand({
    command,
    commandArgs,
  });
  if (pickerCommandContext) {
    await replyWithDiscordModelPickerProviders({
      accountId,
      cfg,
      command: pickerCommandContext,
      interaction,
      preferFollowUp,
      safeInteractionCall: safeDiscordInteractionCall,
      threadBindings,
      userId: user.id,
    });
    return;
  }

  const isGuild = Boolean(interaction.guild);
  const channelId = rawChannelId || "unknown";
  const interactionId = interaction.rawData.id;
  const routeState = await getNativeRouteState();
  if (routeState.bindingReadiness && !routeState.bindingReadiness.ok) {
    const {configuredBinding} = routeState;
    if (configuredBinding) {
      logVerbose(
        `discord native command: configured ACP binding unavailable for channel ${configuredBinding.record.conversation.conversationId}: ${routeState.bindingReadiness.error}`,
      );
      await respond("Configured ACP binding is unavailable right now. Please try again.");
      return;
    }
  }
  const {boundSessionKey} = routeState;
  const {effectiveRoute} = routeState;
  const { sessionKey, commandTargetSessionKey } = resolveNativeCommandSessionTargets({
    agentId: effectiveRoute.agentId,
    boundSessionKey,
    sessionPrefix,
    targetSessionKey: effectiveRoute.sessionKey,
    userId: user.id,
  });
  const ctxPayload = buildDiscordNativeCommandContext({
    accountId: effectiveRoute.accountId,
    allowNameMatching,
    channelConfig,
    channelId,
    channelTopic: channel && "topic" in channel ? (channel.topic ?? undefined) : undefined,
    commandArgs: commandArgs ?? {},
    commandAuthorized,
    commandTargetSessionKey,
    guildInfo,
    guildName: interaction.guild?.name,
    interactionId,
    isDirectMessage,
    isGroupDm,
    isGuild,
    isThreadChannel,
    prompt,
    sender: { id: sender.id, name: sender.name, tag: sender.tag },
    sessionKey,
    threadParentId,
    user: {
      globalName: user.globalName,
      id: user.id,
      username: user.username,
    },
  });

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    accountId: effectiveRoute.accountId,
    agentId: effectiveRoute.agentId,
    cfg,
    channel: "discord",
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, effectiveRoute.agentId);
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(discordConfig);

  let didReply = false;
  const dispatchResult = await dispatchReplyWithDispatcherImpl({
    cfg,
    ctx: ctxPayload,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: async (payload) => {
        if (suppressReplies) {
          return;
        }
        try {
          await deliverDiscordInteractionReply({
            chunkMode: resolveChunkMode(cfg, "discord", accountId),
            interaction,
            maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({ cfg, discordConfig, accountId }),
            mediaLocalRoots,
            payload,
            preferFollowUp: preferFollowUp || didReply,
            textLimit: resolveTextChunkLimit(cfg, "discord", accountId, {
              fallbackLimit: 2000,
            }),
          });
        } catch (error) {
          if (isDiscordUnknownInteraction(error)) {
            logVerbose("discord: interaction reply skipped (interaction expired)");
            return;
          }
          throw error;
        }
        didReply = true;
      },
      humanDelay: resolveHumanDelayConfig(cfg, effectiveRoute.agentId),
      onError: (err, info) => {
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
        log.error(`discord slash ${info.kind} reply failed: ${message}`);
      },
    },
    replyOptions: {
      disableBlockStreaming:
        typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : undefined,
      onModelSelected,
      skillFilter: channelConfig?.skills,
    },
  });

  // Fallback: if the agent turn produced no deliverable replies (for example,
  // A skill only used message.send side effects), close the interaction with
  // A minimal acknowledgment so Discord does not stay in a pending state.
  if (
    !suppressReplies &&
    !didReply &&
    dispatchResult.counts.final === 0 &&
    dispatchResult.counts.block === 0 &&
    dispatchResult.counts.tool === 0
  ) {
    await safeDiscordInteractionCall("interaction empty fallback", async () => {
      const payload = {
        content: "✅ Done.",
        ephemeral: true,
      };
      if (preferFollowUp) {
        await interaction.followUp(payload);
        return;
      }
      await interaction.reply(payload);
    });
  }
}

export function createDiscordCommandArgFallbackButton(params: DiscordCommandArgContext): Button {
  return createDiscordCommandArgFallbackButtonUi({
    ctx: params,
    dispatchCommandInteraction: dispatchDiscordCommandInteraction,
    safeInteractionCall: safeDiscordInteractionCall,
  });
}

export function createDiscordModelPickerFallbackButton(params: DiscordModelPickerContext): Button {
  return createDiscordModelPickerFallbackButtonUi({
    ctx: params,
    dispatchCommandInteraction: dispatchDiscordCommandInteraction,
    safeInteractionCall: safeDiscordInteractionCall,
  });
}

export function createDiscordModelPickerFallbackSelect(
  params: DiscordModelPickerContext,
): StringSelectMenu {
  return createDiscordModelPickerFallbackSelectUi({
    ctx: params,
    dispatchCommandInteraction: dispatchDiscordCommandInteraction,
    safeInteractionCall: safeDiscordInteractionCall,
  });
}

async function deliverDiscordInteractionReply(params: {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  payload: ReplyPayload;
  mediaLocalRoots?: readonly string[];
  textLimit: number;
  maxLinesPerMessage?: number;
  preferFollowUp: boolean;
  chunkMode: "length" | "newline";
}) {
  const { interaction, payload, textLimit, maxLinesPerMessage, preferFollowUp, chunkMode } = params;
  const reply = resolveSendableOutboundReplyParts(payload);
  const discordData = payload.channelData?.discord as
    | { components?: TopLevelComponents[] }
    | undefined;
  let firstMessageComponents =
    Array.isArray(discordData?.components) && discordData.components.length > 0
      ? discordData.components
      : undefined;

  let hasReplied = false;
  const sendMessage = async (
    content: string,
    files?: { name: string; data: Buffer }[],
    components?: TopLevelComponents[],
  ) => {
    const payload =
      files && files.length > 0
        ? {
            content,
            ...(components ? { components } : {}),
            files: files.map((file) => {
              if (file.data instanceof Blob) {
                return { data: file.data, name: file.name };
              }
              const arrayBuffer = Uint8Array.from(file.data).buffer;
              return { data: new Blob([arrayBuffer]), name: file.name };
            }),
          }
        : {
            content,
            ...(components ? { components } : {}),
          };
    await safeDiscordInteractionCall("interaction send", async () => {
      if (!preferFollowUp && !hasReplied) {
        await interaction.reply(payload);
        hasReplied = true;
        firstMessageComponents = undefined;
        return;
      }
      await interaction.followUp(payload);
      hasReplied = true;
      firstMessageComponents = undefined;
    });
  };

  if (reply.hasMedia) {
    const media = await Promise.all(
      reply.mediaUrls.map(async (url) => {
        const loaded = await loadWebMedia(url, {
          localRoots: params.mediaLocalRoots,
        });
        return {
          data: loaded.buffer,
          name: loaded.fileName ?? "upload",
        };
      }),
    );
    const chunks = resolveTextChunksWithFallback(
      reply.text,
      chunkDiscordTextWithMode(reply.text, {
        chunkMode,
        maxChars: textLimit,
        maxLines: maxLinesPerMessage,
      }),
    );
    const caption = chunks[0] ?? "";
    await sendMessage(caption, media, firstMessageComponents);
    for (const chunk of chunks.slice(1)) {
      if (!chunk.trim()) {
        continue;
      }
      await interaction.followUp({ content: chunk });
    }
    return;
  }

  if (!reply.hasText && !firstMessageComponents) {
    return;
  }
  const chunks =
    reply.text || firstMessageComponents
      ? resolveTextChunksWithFallback(
          reply.text,
          chunkDiscordTextWithMode(reply.text, {
            chunkMode,
            maxChars: textLimit,
            maxLines: maxLinesPerMessage,
          }),
        )
      : [];
  for (const chunk of chunks) {
    if (!chunk.trim() && !firstMessageComponents) {
      continue;
    }
    await sendMessage(chunk, undefined, firstMessageComponents);
  }
}
