import {
  Button,
  type ButtonInteraction,
  ChannelSelectMenu,
  type ChannelSelectMenuInteraction,
  type ComponentData,
  MentionableSelectMenu,
  type MentionableSelectMenuInteraction,
  Modal,
  type ModalInteraction,
  RoleSelectMenu,
  type RoleSelectMenuInteraction,
  StringSelectMenu,
  type StringSelectMenuInteraction,
  type TopLevelComponents,
  UserSelectMenu,
  type UserSelectMenuInteraction,
} from "@buape/carbon";
import type { APIStringSelectComponent } from "discord-api-types/v10";
import { ButtonStyle, ChannelType } from "discord-api-types/v10";
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { createNonExitingRuntime, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { logDebug, logError } from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { createDiscordRestClient } from "../client.js";
import {
  parseDiscordComponentCustomIdForCarbon,
  parseDiscordModalCustomIdForCarbon,
} from "../component-custom-id.js";
import { resolveDiscordComponentEntry, resolveDiscordModalEntry } from "../components-registry.js";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import {
  type DiscordInteractiveHandlerContext,
  dispatchDiscordPluginInteractiveHandler,
} from "../interactive-dispatch.js";
import { editDiscordComponentMessage } from "../send.components.js";
import {
  AGENT_BUTTON_KEY,
  AGENT_SELECT_KEY,
  type AgentComponentContext,
  type AgentComponentInteraction,
  type AgentComponentMessageInteraction,
  type ComponentInteractionContext,
  type DiscordChannelContext,
  ackComponentInteraction,
  ensureAgentComponentInteractionAllowed,
  ensureComponentUserAllowed,
  ensureGuildComponentMemberAllowed,
  formatModalSubmissionText,
  mapSelectValues,
  parseAgentComponentData,
  parseDiscordComponentData,
  parseDiscordModalId,
  resolveAgentComponentRoute,
  resolveComponentCommandAuthorized,
  resolveDiscordChannelContext,
  resolveDiscordInteractionId,
  resolveInteractionContextWithDmAuth,
  resolveInteractionCustomId,
  resolveModalFieldValues,
  resolvePinnedMainDmOwnerFromAllowlist,
} from "./agent-components-helpers.js";
import {
  enqueueSystemEvent,
  readSessionUpdatedAt,
  resolveStorePath,
} from "./agent-components.deps.runtime.js";
import {
  normalizeDiscordAllowList,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
} from "./allow-list.js";
import { formatDiscordUserTag } from "./format.js";
import {
  buildDiscordGroupSystemPrompt,
  buildDiscordInboundAccessContext,
} from "./inbound-context.js";
import { buildDirectLabel, buildGuildLabel } from "./reply-context.js";
import { deliverDiscordReply } from "./reply-delivery.js";

let conversationRuntimePromise: Promise<typeof import("./agent-components.runtime.js")> | undefined;
let componentsRuntimePromise: Promise<typeof import("../components.js")> | undefined;
let replyRuntimePromise: Promise<typeof import("openclaw/plugin-sdk/reply-runtime")> | undefined;
let replyPipelineRuntimePromise:
  | Promise<typeof import("openclaw/plugin-sdk/channel-reply-pipeline")>
  | undefined;
let typingRuntimePromise: Promise<typeof import("./typing.js")> | undefined;

async function loadConversationRuntime() {
  conversationRuntimePromise ??= import("./agent-components.runtime.js");
  return await conversationRuntimePromise;
}

async function loadComponentsRuntime() {
  componentsRuntimePromise ??= import("../components.js");
  return await componentsRuntimePromise;
}

async function _loadReplyRuntime() {
  replyRuntimePromise ??= import("openclaw/plugin-sdk/reply-runtime");
  return await replyRuntimePromise;
}
async function loadReplyPipelineRuntime() {
  replyPipelineRuntimePromise ??= import("openclaw/plugin-sdk/channel-reply-pipeline");
  return await replyPipelineRuntimePromise;
}

async function loadTypingRuntime() {
  typingRuntimePromise ??= import("./typing.js");
  return await typingRuntimePromise;
}

function resolveComponentGroupPolicy(
  ctx: AgentComponentContext,
): "open" | "disabled" | "allowlist" {
  return resolveOpenProviderRuntimeGroupPolicy({
    defaultGroupPolicy: ctx.cfg.channels?.defaults?.groupPolicy,
    groupPolicy: ctx.discordConfig?.groupPolicy,
    providerConfigPresent: ctx.cfg.channels?.discord !== undefined,
  }).groupPolicy;
}

function buildDiscordComponentConversationLabel(params: {
  interactionCtx: ComponentInteractionContext;
  interaction: AgentComponentInteraction;
  channelCtx: DiscordChannelContext;
}) {
  if (params.interactionCtx.isDirectMessage) {
    return buildDirectLabel(params.interactionCtx.user);
  }
  if (params.interactionCtx.isGroupDm) {
    return `Group DM #${params.channelCtx.channelName ?? params.interactionCtx.channelId} channel id:${params.interactionCtx.channelId}`;
  }
  return buildGuildLabel({
    channelId: params.interactionCtx.channelId,
    channelName: params.channelCtx.channelName ?? params.interactionCtx.channelId,
    guild: params.interaction.guild ?? undefined,
  });
}

function resolveDiscordComponentChatType(interactionCtx: ComponentInteractionContext) {
  if (interactionCtx.isDirectMessage) {
    return "direct";
  }
  if (interactionCtx.isGroupDm) {
    return "group";
  }
  return "channel";
}

export function resolveDiscordComponentOriginatingTo(
  interactionCtx: Pick<ComponentInteractionContext, "isDirectMessage" | "userId" | "channelId">,
) {
  return resolveDiscordConversationIdentity({
    channelId: interactionCtx.channelId,
    isDirectMessage: interactionCtx.isDirectMessage,
    userId: interactionCtx.userId,
  });
}

async function dispatchPluginDiscordInteractiveEvent(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  interactionCtx: ComponentInteractionContext;
  channelCtx: DiscordChannelContext;
  isAuthorizedSender: boolean;
  data: string;
  kind: "button" | "select" | "modal";
  values?: string[];
  fields?: { id: string; name: string; values: string[] }[];
  messageId?: string;
}): Promise<"handled" | "unmatched"> {
  const normalizedConversationId =
    params.interactionCtx.rawGuildId || params.channelCtx.channelType === ChannelType.GroupDM
      ? `channel:${params.interactionCtx.channelId}`
      : `user:${params.interactionCtx.userId}`;
  let responded = false;
  let acknowledged = false;
  const updateOriginalMessage = async (input: {
    text?: string;
    components?: TopLevelComponents[];
  }) => {
    const payload = {
      ...(input.text !== undefined ? { content: input.text } : {}),
      ...(input.components !== undefined ? { components: input.components } : {}),
    };
    if (acknowledged) {
      // Carbon edits @original on reply() after acknowledge(), which preserves
      // Plugin edit/clear flows without consuming a second interaction callback.
      await params.interaction.reply(payload);
      return;
    }
    if (!("update" in params.interaction) || typeof params.interaction.update !== "function") {
      throw new Error("Discord interaction cannot update the source message");
    }
    await params.interaction.update(payload);
  };
  const respond: DiscordInteractiveHandlerContext["respond"] = {
    acknowledge: async () => {
      if (responded) {
        return;
      }
      await params.interaction.acknowledge();
      acknowledged = true;
      responded = true;
    },
    clearComponents: async (input?: { text?: string }) => {
      responded = true;
      await updateOriginalMessage({
        components: [],
        text: input?.text,
      });
    },
    editMessage: async (
      input: Parameters<DiscordInteractiveHandlerContext["respond"]["editMessage"]>[0],
    ) => {
      const { text, components } = input;
      responded = true;
      await updateOriginalMessage({
        components: components as TopLevelComponents[] | undefined,
        text,
      });
    },
    followUp: async ({ text, ephemeral = true }: { text: string; ephemeral?: boolean }) => {
      responded = true;
      await params.interaction.followUp({
        content: text,
        ephemeral,
      });
    },
    reply: async ({ text, ephemeral = true }: { text: string; ephemeral?: boolean }) => {
      responded = true;
      await params.interaction.reply({
        content: text,
        ephemeral,
      });
    },
  };
  const conversationRuntime = await loadConversationRuntime();
  const pluginBindingApproval = conversationRuntime.parsePluginBindingApprovalCustomId(params.data);
  if (pluginBindingApproval) {
    const { buildPluginBindingResolvedText, resolvePluginConversationBindingApproval } =
      conversationRuntime;
    if (!pluginBindingApproval) {
      return "unmatched";
    }
    try {
      await respond.acknowledge();
    } catch {
      // Interaction may have expired; try to continue anyway.
    }
    const resolved = await resolvePluginConversationBindingApproval({
      approvalId: pluginBindingApproval.approvalId,
      decision: pluginBindingApproval.decision,
      senderId: params.interactionCtx.userId,
    });
    const approvalMessageId = params.messageId?.trim() || params.interaction.message?.id?.trim();
    if (approvalMessageId) {
      try {
        await editDiscordComponentMessage(
          normalizedConversationId,
          approvalMessageId,
          {
            text: buildPluginBindingResolvedText(resolved),
          },
          {
            accountId: params.ctx.accountId,
          },
        );
      } catch (error) {
        logError(`discord plugin binding approval: failed to clear prompt: ${String(error)}`);
      }
    }
    if (resolved.status !== "approved") {
      try {
        await respond.followUp({
          ephemeral: true,
          text: buildPluginBindingResolvedText(resolved),
        });
      } catch (error) {
        logError(`discord plugin binding approval: failed to follow up: ${String(error)}`);
      }
    }
    return "handled";
  }
  const dispatched = await dispatchDiscordPluginInteractiveHandler({
    ctx: {
      accountId: params.ctx.accountId,
      auth: { isAuthorizedSender: params.isAuthorizedSender },
      conversationId: normalizedConversationId,
      guildId: params.interactionCtx.rawGuildId,
      interaction: {
        fields: params.fields,
        kind: params.kind,
        messageId: params.messageId,
        values: params.values,
      },
      interactionId: resolveDiscordInteractionId(params.interaction),
      parentConversationId: params.channelCtx.parentId,
      senderId: params.interactionCtx.userId,
      senderUsername: params.interactionCtx.username,
    },
    data: params.data,
    interactionId: resolveDiscordInteractionId(params.interaction),
    onMatched: async () => {
      try {
        await respond.acknowledge();
      } catch {
        // Interaction may have expired before the plugin handler ran.
      }
    },
    respond,
  });
  if (!dispatched.matched) {
    return "unmatched";
  }
  if (dispatched.handled) {
    if (!responded) {
      try {
        await respond.acknowledge();
      } catch {
        // Interaction may have expired after the handler finished.
      }
    }
    return "handled";
  }
  return "unmatched";
}

async function dispatchDiscordComponentEvent(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  interactionCtx: ComponentInteractionContext;
  channelCtx: DiscordChannelContext;
  guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
  eventText: string;
  replyToId?: string;
  routeOverrides?: { sessionKey?: string; agentId?: string; accountId?: string };
}): Promise<void> {
  const { ctx, interaction, interactionCtx, channelCtx, guildInfo, eventText } = params;
  const runtime = ctx.runtime ?? createNonExitingRuntime();
  const route = resolveAgentComponentRoute({
    channelId: interactionCtx.channelId,
    ctx,
    isDirectMessage: interactionCtx.isDirectMessage,
    isGroupDm: interactionCtx.isGroupDm,
    memberRoleIds: interactionCtx.memberRoleIds,
    parentId: channelCtx.parentId,
    rawGuildId: interactionCtx.rawGuildId,
    userId: interactionCtx.userId,
  });
  const sessionKey = params.routeOverrides?.sessionKey ?? route.sessionKey;
  const agentId = params.routeOverrides?.agentId ?? route.agentId;
  const accountId = params.routeOverrides?.accountId ?? route.accountId;
  const fromLabel = buildDiscordComponentConversationLabel({
    channelCtx,
    interaction,
    interactionCtx,
  });
  const chatType = resolveDiscordComponentChatType(interactionCtx);
  const senderName = interactionCtx.user.globalName ?? interactionCtx.user.username;
  const senderUsername = interactionCtx.user.username;
  const senderTag = formatDiscordUserTag(interactionCtx.user);
  const groupChannel =
    !interactionCtx.isDirectMessage && channelCtx.channelSlug
      ? `#${channelCtx.channelSlug}`
      : undefined;
  const groupSubject = interactionCtx.isDirectMessage ? undefined : groupChannel;
  const channelConfig = resolveDiscordChannelConfigWithFallback({
    channelId: interactionCtx.channelId,
    channelName: channelCtx.channelName,
    channelSlug: channelCtx.channelSlug,
    guildInfo,
    parentId: channelCtx.parentId,
    parentName: channelCtx.parentName,
    parentSlug: channelCtx.parentSlug,
    scope: channelCtx.isThread ? "thread" : "channel",
  });
  const allowNameMatching = isDangerousNameMatchingEnabled(ctx.discordConfig);
  const { ownerAllowFrom } = buildDiscordInboundAccessContext({
    allowNameMatching,
    channelConfig,
    guildInfo,
    isGuild: !interactionCtx.isDirectMessage,
    sender: { id: interactionCtx.user.id, name: interactionCtx.user.username, tag: senderTag },
  });
  const groupSystemPrompt = buildDiscordGroupSystemPrompt(channelConfig);
  const pinnedMainDmOwner = interactionCtx.isDirectMessage
    ? resolvePinnedMainDmOwnerFromAllowlist({
        allowFrom: channelConfig?.users ?? guildInfo?.users,
        dmScope: ctx.cfg.session?.dmScope,
        normalizeEntry: (entry: string) => {
          const normalized = normalizeDiscordAllowList([entry], ["discord:", "user:", "pk:"]);
          const candidate = normalized?.ids.values().next().value;
          return typeof candidate === "string" && /^\d+$/.test(candidate) ? candidate : undefined;
        },
      })
    : null;
  const commandAuthorized = resolveComponentCommandAuthorized({
    allowNameMatching,
    channelConfig,
    ctx,
    guildInfo,
    interactionCtx,
  });
  const storePath = resolveStorePath(ctx.cfg.session?.store, { agentId });
  const envelopeOptions = resolveEnvelopeFormatOptions(ctx.cfg);
  const previousTimestamp = readSessionUpdatedAt({
    sessionKey,
    storePath,
  });
  const timestamp = Date.now();
  const combinedBody = formatInboundEnvelope({
    body: eventText,
    channel: "Discord",
    chatType,
    envelope: envelopeOptions,
    from: fromLabel,
    previousTimestamp,
    senderLabel: senderName,
    timestamp,
  });

  const {
    createReplyReferencePlanner,
    dispatchReplyWithBufferedBlockDispatcher,
    finalizeInboundContext,
    resolveChunkMode,
    resolveTextChunkLimit,
    recordInboundSession,
  } = await (async () => {
    const conversationRuntime = await loadConversationRuntime();
    return {
      ...conversationRuntime,
    };
  })();

  const ctxPayload = finalizeInboundContext({
    AccountId: accountId,
    Body: combinedBody,
    BodyForAgent: eventText,
    ChatType: chatType,
    CommandAuthorized: commandAuthorized,
    CommandBody: eventText,
    CommandSource: "text" as const,
    ConversationLabel: fromLabel,
    From: interactionCtx.isDirectMessage
      ? `discord:${interactionCtx.userId}`
      : interactionCtx.isGroupDm
        ? `discord:group:${interactionCtx.channelId}`
        : `discord:channel:${interactionCtx.channelId}`,
    GroupChannel: groupChannel,
    GroupSpace: guildInfo?.id ?? guildInfo?.slug ?? interactionCtx.rawGuildId ?? undefined,
    GroupSubject: groupSubject,
    GroupSystemPrompt: interactionCtx.isDirectMessage ? undefined : groupSystemPrompt,
    MessageSid: interaction.rawData.id,
    OriginatingChannel: "discord" as const,
    OriginatingTo:
      resolveDiscordComponentOriginatingTo(interactionCtx) ?? `channel:${interactionCtx.channelId}`,
    OwnerAllowFrom: ownerAllowFrom,
    Provider: "discord" as const,
    RawBody: eventText,
    SenderId: interactionCtx.userId,
    SenderName: senderName,
    SenderTag: senderTag,
    SenderUsername: senderUsername,
    SessionKey: sessionKey,
    Surface: "discord" as const,
    Timestamp: timestamp,
    To: `channel:${interactionCtx.channelId}`,
    WasMentioned: true,
  });

  await recordInboundSession({
    ctx: ctxPayload,
    onRecordError: (err) => {
      logVerbose(`discord: failed updating component session meta: ${String(err)}`);
    },
    sessionKey: ctxPayload.SessionKey ?? sessionKey,
    storePath,
    updateLastRoute: interactionCtx.isDirectMessage
      ? {
          accountId,
          channel: "discord",
          mainDmOwnerPin: pinnedMainDmOwner
            ? {
                ownerRecipient: pinnedMainDmOwner,
                senderRecipient: interactionCtx.userId,
                onSkip: ({ ownerRecipient, senderRecipient }) => {
                  logVerbose(
                    `discord: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                  );
                },
              }
            : undefined,
          sessionKey: route.mainSessionKey,
          to:
            resolveDiscordComponentOriginatingTo(interactionCtx) ?? `user:${interactionCtx.userId}`,
        }
      : undefined,
  });

  const deliverTarget = `channel:${interactionCtx.channelId}`;
  const typingChannelId = interactionCtx.channelId;
  const { createChannelReplyPipeline } = await loadReplyPipelineRuntime();
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    accountId,
    agentId,
    cfg: ctx.cfg,
    channel: "discord",
  });
  const tableMode = resolveMarkdownTableMode({
    accountId,
    cfg: ctx.cfg,
    channel: "discord",
  });
  const textLimit = resolveTextChunkLimit(ctx.cfg, "discord", accountId, {
    fallbackLimit: 2000,
  });
  const token = ctx.token ?? "";
  const feedbackRest = createDiscordRestClient({
    accountId,
    cfg: ctx.cfg,
    token,
  }).rest;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(ctx.cfg, agentId);
  const replyToMode =
    ctx.discordConfig?.replyToMode ?? ctx.cfg.channels?.discord?.replyToMode ?? "off";
  const replyReference = createReplyReferencePlanner({
    replyToMode,
    startId: params.replyToId,
  });

  await dispatchReplyWithBufferedBlockDispatcher({
    cfg: ctx.cfg,
    ctx: ctxPayload,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: async (payload) => {
        const replyToId = replyReference.use();
        await deliverDiscordReply({
          accountId,
          cfg: ctx.cfg,
          chunkMode: resolveChunkMode(ctx.cfg, "discord", accountId),
          maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
            cfg: ctx.cfg,
            discordConfig: ctx.discordConfig,
            accountId,
          }),
          mediaLocalRoots,
          replies: [payload],
          replyToId,
          replyToMode,
          rest: interaction.client.rest,
          runtime,
          tableMode,
          target: deliverTarget,
          textLimit,
          token,
        });
        replyReference.markSent();
      },
      humanDelay: resolveHumanDelayConfig(ctx.cfg, agentId),
      onError: (err) => {
        logError(`discord component dispatch failed: ${String(err)}`);
      },
      onReplyStart: async () => {
        try {
          const { sendTyping } = await loadTypingRuntime();
          await sendTyping({ channelId: typingChannelId, rest: feedbackRest });
        } catch (error) {
          logVerbose(`discord: typing failed for component reply: ${String(error)}`);
        }
      },
    },
    replyOptions: { onModelSelected },
  });
}

async function handleDiscordComponentEvent(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentMessageInteraction;
  data: ComponentData;
  componentLabel: string;
  values?: string[];
  label: string;
}): Promise<void> {
  const parsed = parseDiscordComponentData(
    params.data,
    resolveInteractionCustomId(params.interaction),
  );
  if (!parsed) {
    logError(`${params.label}: failed to parse component data`);
    try {
      await params.interaction.reply({
        content: "This component is no longer valid.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const entry = resolveDiscordComponentEntry({ consume: false, id: parsed.componentId });
  if (!entry) {
    try {
      await params.interaction.reply({
        content: "This component has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const interactionCtx = await resolveInteractionContextWithDmAuth({
    componentLabel: params.componentLabel,
    ctx: params.ctx,
    defer: false,
    interaction: params.interaction,
    label: params.label,
  });
  if (!interactionCtx) {
    return;
  }
  const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildEntries: params.ctx.guildEntries,
    guildId: rawGuildId,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const allowNameMatching = isDangerousNameMatchingEnabled(params.ctx.discordConfig);
  const channelConfig = resolveDiscordChannelConfigWithFallback({
    channelId,
    channelName: channelCtx.channelName,
    channelSlug: channelCtx.channelSlug,
    guildInfo,
    parentId: channelCtx.parentId,
    parentName: channelCtx.parentName,
    parentSlug: channelCtx.parentSlug,
    scope: channelCtx.isThread ? "thread" : "channel",
  });
  const unauthorizedReply = `You are not authorized to use this ${params.componentLabel}.`;
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    allowNameMatching,
    channelCtx,
    channelId,
    componentLabel: params.componentLabel,
    groupPolicy: resolveComponentGroupPolicy(params.ctx),
    guildInfo,
    interaction: params.interaction,
    memberRoleIds,
    rawGuildId,
    replyOpts,
    unauthorizedReply,
    user,
  });
  if (!memberAllowed) {
    return;
  }

  const componentAllowed = await ensureComponentUserAllowed({
    allowNameMatching,
    componentLabel: params.componentLabel,
    entry,
    interaction: params.interaction,
    replyOpts,
    unauthorizedReply,
    user,
  });
  if (!componentAllowed) {
    return;
  }
  const commandAuthorized = resolveComponentCommandAuthorized({
    allowNameMatching,
    channelConfig,
    ctx: params.ctx,
    guildInfo,
    interactionCtx,
  });

  const consumed = resolveDiscordComponentEntry({
    consume: !entry.reusable,
    id: parsed.componentId,
  });
  if (!consumed) {
    try {
      await params.interaction.reply({
        content: "This component has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  if (consumed.kind === "modal-trigger") {
    try {
      await params.interaction.reply({
        content: "This form is no longer available.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const values = params.values ? mapSelectValues(consumed, params.values) : undefined;
  if (consumed.callbackData) {
    const pluginDispatch = await dispatchPluginDiscordInteractiveEvent({
      channelCtx,
      ctx: params.ctx,
      data: consumed.callbackData,
      interaction: params.interaction,
      interactionCtx,
      isAuthorizedSender: commandAuthorized,
      kind: consumed.kind === "select" ? "select" : "button",
      messageId: consumed.messageId ?? params.interaction.message?.id,
      values,
    });
    if (pluginDispatch === "handled") {
      return;
    }
  }
  // Preserve explicit callback payloads for button fallbacks so Discord
  // Behaves like Telegram when buttons carry synthetic command text. Select
  // Fallbacks still need their chosen values in the synthesized event text.
  const eventText =
    (consumed.kind === "button" ? consumed.callbackData?.trim() : undefined) ||
    (await loadComponentsRuntime()).formatDiscordComponentEventText({
      kind: consumed.kind === "select" ? "select" : "button",
      label: consumed.label,
      values,
    });

  try {
    await params.interaction.reply({ content: "✓", ...replyOpts });
  } catch (error) {
    logError(`${params.label}: failed to acknowledge interaction: ${String(error)}`);
  }

  await dispatchDiscordComponentEvent({
    channelCtx,
    ctx: params.ctx,
    eventText,
    guildInfo,
    interaction: params.interaction,
    interactionCtx,
    replyToId: consumed.messageId ?? params.interaction.message?.id,
    routeOverrides: {
      accountId: consumed.accountId,
      agentId: consumed.agentId,
      sessionKey: consumed.sessionKey,
    },
  });
}

async function handleDiscordModalTrigger(params: {
  ctx: AgentComponentContext;
  interaction: ButtonInteraction;
  data: ComponentData;
  label: string;
  interactionCtx?: ComponentInteractionContext;
}): Promise<void> {
  const parsed = parseDiscordComponentData(
    params.data,
    resolveInteractionCustomId(params.interaction),
  );
  if (!parsed) {
    logError(`${params.label}: failed to parse modal trigger data`);
    try {
      await params.interaction.reply({
        content: "This button is no longer valid.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }
  const entry = resolveDiscordComponentEntry({ consume: false, id: parsed.componentId });
  if (!entry || entry.kind !== "modal-trigger") {
    try {
      await params.interaction.reply({
        content: "This button has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const modalId = entry.modalId ?? parsed.modalId;
  if (!modalId) {
    try {
      await params.interaction.reply({
        content: "This form is no longer available.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const interactionCtx =
    params.interactionCtx ??
    (await resolveInteractionContextWithDmAuth({
      componentLabel: "form",
      ctx: params.ctx,
      defer: false,
      interaction: params.interaction,
      label: params.label,
    }));
  if (!interactionCtx) {
    return;
  }
  const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildEntries: params.ctx.guildEntries,
    guildId: rawGuildId,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const unauthorizedReply = "You are not authorized to use this form.";
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    allowNameMatching: isDangerousNameMatchingEnabled(params.ctx.discordConfig),
    channelCtx,
    channelId,
    componentLabel: "form",
    groupPolicy: resolveComponentGroupPolicy(params.ctx),
    guildInfo,
    interaction: params.interaction,
    memberRoleIds,
    rawGuildId,
    replyOpts,
    unauthorizedReply,
    user,
  });
  if (!memberAllowed) {
    return;
  }

  const componentAllowed = await ensureComponentUserAllowed({
    allowNameMatching: isDangerousNameMatchingEnabled(params.ctx.discordConfig),
    componentLabel: "form",
    entry,
    interaction: params.interaction,
    replyOpts,
    unauthorizedReply,
    user,
  });
  if (!componentAllowed) {
    return;
  }

  const consumed = resolveDiscordComponentEntry({
    consume: !entry.reusable,
    id: parsed.componentId,
  });
  if (!consumed) {
    try {
      await params.interaction.reply({
        content: "This form has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const resolvedModalId = consumed.modalId ?? modalId;
  const modalEntry = resolveDiscordModalEntry({ consume: false, id: resolvedModalId });
  if (!modalEntry) {
    try {
      await params.interaction.reply({
        content: "This form has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  try {
    await params.interaction.showModal(
      (await loadComponentsRuntime()).createDiscordFormModal(modalEntry),
    );
  } catch (error) {
    logError(`${params.label}: failed to show modal: ${String(error)}`);
  }
}

export class AgentComponentButton extends Button {
  label = AGENT_BUTTON_KEY;
  customId = `${AGENT_BUTTON_KEY}:seed=1`;
  style = ButtonStyle.Primary;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    // Parse componentId from Carbon's parsed ComponentData
    const parsed = parseAgentComponentData(data);
    if (!parsed) {
      logError("agent button: failed to parse component data");
      try {
        await interaction.reply({
          content: "This button is no longer valid.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const { componentId } = parsed;

    const interactionCtx = await resolveInteractionContextWithDmAuth({
      componentLabel: "button",
      ctx: this.ctx,
      defer: false,
      interaction,
      label: "agent button",
    });
    if (!interactionCtx) {
      return;
    }
    const {
      channelId,
      user,
      username,
      userId,
      replyOpts,
      rawGuildId,
      isDirectMessage,
      isGroupDm,
      memberRoleIds,
    } = interactionCtx;

    // Check user allowlist before processing component interaction
    // This prevents unauthorized users from injecting system events.
    const allowed = await ensureAgentComponentInteractionAllowed({
      channelId,
      componentLabel: "button",
      ctx: this.ctx,
      interaction,
      memberRoleIds,
      rawGuildId,
      replyOpts,
      unauthorizedReply: "You are not authorized to use this button.",
      user,
    });
    if (!allowed) {
      return;
    }
    const { parentId } = allowed;

    const route = resolveAgentComponentRoute({
      channelId,
      ctx: this.ctx,
      isDirectMessage,
      isGroupDm,
      memberRoleIds,
      parentId,
      rawGuildId,
      userId,
    });

    const eventText = `[Discord component: ${componentId} clicked by ${username} (${userId})]`;

    logDebug(`agent button: enqueuing event for channel ${channelId}: ${eventText}`);

    enqueueSystemEvent(eventText, {
      contextKey: `discord:agent-button:${channelId}:${componentId}:${userId}`,
      sessionKey: route.sessionKey,
    });

    await ackComponentInteraction({ interaction, label: "agent button", replyOpts });
  }
}

export class AgentSelectMenu extends StringSelectMenu {
  customId = `${AGENT_SELECT_KEY}:seed=1`;
  options: APIStringSelectComponent["options"] = [];
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: StringSelectMenuInteraction, data: ComponentData): Promise<void> {
    // Parse componentId from Carbon's parsed ComponentData
    const parsed = parseAgentComponentData(data);
    if (!parsed) {
      logError("agent select: failed to parse component data");
      try {
        await interaction.reply({
          content: "This select menu is no longer valid.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const { componentId } = parsed;

    const interactionCtx = await resolveInteractionContextWithDmAuth({
      componentLabel: "select menu",
      ctx: this.ctx,
      defer: false,
      interaction,
      label: "agent select",
    });
    if (!interactionCtx) {
      return;
    }
    const {
      channelId,
      user,
      username,
      userId,
      replyOpts,
      rawGuildId,
      isDirectMessage,
      isGroupDm,
      memberRoleIds,
    } = interactionCtx;

    // Check user allowlist before processing component interaction.
    const allowed = await ensureAgentComponentInteractionAllowed({
      channelId,
      componentLabel: "select",
      ctx: this.ctx,
      interaction,
      memberRoleIds,
      rawGuildId,
      replyOpts,
      unauthorizedReply: "You are not authorized to use this select menu.",
      user,
    });
    if (!allowed) {
      return;
    }
    const { parentId } = allowed;

    // Extract selected values
    const values = interaction.values ?? [];
    const valuesText = values.length > 0 ? ` (selected: ${values.join(", ")})` : "";

    const route = resolveAgentComponentRoute({
      channelId,
      ctx: this.ctx,
      isDirectMessage,
      isGroupDm,
      memberRoleIds,
      parentId,
      rawGuildId,
      userId,
    });

    const eventText = `[Discord select menu: ${componentId} interacted by ${username} (${userId})${valuesText}]`;

    logDebug(`agent select: enqueuing event for channel ${channelId}: ${eventText}`);

    enqueueSystemEvent(eventText, {
      contextKey: `discord:agent-select:${channelId}:${componentId}:${userId}`,
      sessionKey: route.sessionKey,
    });

    await ackComponentInteraction({ interaction, label: "agent select", replyOpts });
  }
}

class DiscordComponentButton extends Button {
  label = "component";
  customId = "__openclaw_discord_component_button_wildcard__";
  style = ButtonStyle.Primary;
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    const parsed = parseDiscordComponentData(data, resolveInteractionCustomId(interaction));
    if (parsed?.modalId) {
      const interactionCtx = await resolveInteractionContextWithDmAuth({
        componentLabel: "form",
        ctx: this.ctx,
        defer: false,
        interaction,
        label: "discord component button",
      });
      if (!interactionCtx) {
        return;
      }
      await handleDiscordModalTrigger({
        ctx: this.ctx,
        data,
        interaction,
        interactionCtx,
        label: "discord component modal",
      });
      return;
    }
    await handleDiscordComponentEvent({
      componentLabel: "button",
      ctx: this.ctx,
      data,
      interaction,
      label: "discord component button",
    });
  }
}

class DiscordComponentStringSelect extends StringSelectMenu {
  customId = "__openclaw_discord_component_string_select_wildcard__";
  options: APIStringSelectComponent["options"] = [];
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: StringSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      componentLabel: "select menu",
      ctx: this.ctx,
      data,
      interaction,
      label: "discord component select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentUserSelect extends UserSelectMenu {
  customId = "__openclaw_discord_component_user_select_wildcard__";
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: UserSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      componentLabel: "user select",
      ctx: this.ctx,
      data,
      interaction,
      label: "discord component user select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentRoleSelect extends RoleSelectMenu {
  customId = "__openclaw_discord_component_role_select_wildcard__";
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: RoleSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      componentLabel: "role select",
      ctx: this.ctx,
      data,
      interaction,
      label: "discord component role select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentMentionableSelect extends MentionableSelectMenu {
  customId = "__openclaw_discord_component_mentionable_select_wildcard__";
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: MentionableSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      componentLabel: "mentionable select",
      ctx: this.ctx,
      data,
      interaction,
      label: "discord component mentionable select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentChannelSelect extends ChannelSelectMenu {
  customId = "__openclaw_discord_component_channel_select_wildcard__";
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ChannelSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      componentLabel: "channel select",
      ctx: this.ctx,
      data,
      interaction,
      label: "discord component channel select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentModal extends Modal {
  title = "OpenClaw form";
  customId = "__openclaw_discord_component_modal_wildcard__";
  components = [];
  customIdParser = parseDiscordModalCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ModalInteraction, data: ComponentData): Promise<void> {
    const modalId = parseDiscordModalId(data, resolveInteractionCustomId(interaction));
    if (!modalId) {
      logError("discord component modal: missing modal id");
      try {
        await interaction.reply({
          content: "This form is no longer valid.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const modalEntry = resolveDiscordModalEntry({ consume: false, id: modalId });
    if (!modalEntry) {
      try {
        await interaction.reply({
          content: "This form has expired.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const interactionCtx = await resolveInteractionContextWithDmAuth({
      componentLabel: "form",
      ctx: this.ctx,
      defer: false,
      interaction,
      label: "discord component modal",
    });
    if (!interactionCtx) {
      return;
    }
    const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
    const guildInfo = resolveDiscordGuildEntry({
      guild: interaction.guild ?? undefined,
      guildEntries: this.ctx.guildEntries,
      guildId: rawGuildId,
    });
    const channelCtx = resolveDiscordChannelContext(interaction);
    const allowNameMatching = isDangerousNameMatchingEnabled(this.ctx.discordConfig);
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      channelId,
      channelName: channelCtx.channelName,
      channelSlug: channelCtx.channelSlug,
      guildInfo,
      parentId: channelCtx.parentId,
      parentName: channelCtx.parentName,
      parentSlug: channelCtx.parentSlug,
      scope: channelCtx.isThread ? "thread" : "channel",
    });
    const memberAllowed = await ensureGuildComponentMemberAllowed({
      allowNameMatching,
      channelCtx,
      channelId,
      componentLabel: "form",
      groupPolicy: resolveComponentGroupPolicy(this.ctx),
      guildInfo,
      interaction,
      memberRoleIds,
      rawGuildId,
      replyOpts,
      unauthorizedReply: "You are not authorized to use this form.",
      user,
    });
    if (!memberAllowed) {
      return;
    }

    const modalAllowed = await ensureComponentUserAllowed({
      allowNameMatching,
      componentLabel: "form",
      entry: {
        allowedUsers: modalEntry.allowedUsers,
        id: modalEntry.id,
        kind: "button",
        label: modalEntry.title,
      },
      interaction,
      replyOpts,
      unauthorizedReply: "You are not authorized to use this form.",
      user,
    });
    if (!modalAllowed) {
      return;
    }
    const commandAuthorized = resolveComponentCommandAuthorized({
      allowNameMatching,
      channelConfig,
      ctx: this.ctx,
      guildInfo,
      interactionCtx,
    });

    const consumed = resolveDiscordModalEntry({
      consume: !modalEntry.reusable,
      id: modalId,
    });
    if (!consumed) {
      try {
        await interaction.reply({
          content: "This form has expired.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    if (consumed.callbackData) {
      const fields = consumed.fields.map((field) => ({
        id: field.id,
        name: field.name,
        values: resolveModalFieldValues(field, interaction),
      }));
      const pluginDispatch = await dispatchPluginDiscordInteractiveEvent({
        channelCtx,
        ctx: this.ctx,
        data: consumed.callbackData,
        fields,
        interaction,
        interactionCtx,
        isAuthorizedSender: commandAuthorized,
        kind: "modal",
        messageId: consumed.messageId,
      });
      if (pluginDispatch === "handled") {
        return;
      }
    }

    try {
      await interaction.acknowledge();
    } catch (error) {
      logError(`discord component modal: failed to acknowledge: ${String(error)}`);
    }

    const eventText = formatModalSubmissionText(consumed, interaction);
    await dispatchDiscordComponentEvent({
      channelCtx,
      ctx: this.ctx,
      eventText,
      guildInfo,
      interaction,
      interactionCtx,
      replyToId: consumed.messageId,
      routeOverrides: {
        accountId: consumed.accountId,
        agentId: consumed.agentId,
        sessionKey: consumed.sessionKey,
      },
    });
  }
}

export function createAgentComponentButton(ctx: AgentComponentContext): Button {
  return new AgentComponentButton(ctx);
}

export function createAgentSelectMenu(ctx: AgentComponentContext): StringSelectMenu {
  return new AgentSelectMenu(ctx);
}

export function createDiscordComponentButton(ctx: AgentComponentContext): Button {
  return new DiscordComponentButton(ctx);
}

export function createDiscordComponentStringSelect(ctx: AgentComponentContext): StringSelectMenu {
  return new DiscordComponentStringSelect(ctx);
}

export function createDiscordComponentUserSelect(ctx: AgentComponentContext): UserSelectMenu {
  return new DiscordComponentUserSelect(ctx);
}

export function createDiscordComponentRoleSelect(ctx: AgentComponentContext): RoleSelectMenu {
  return new DiscordComponentRoleSelect(ctx);
}

export function createDiscordComponentMentionableSelect(
  ctx: AgentComponentContext,
): MentionableSelectMenu {
  return new DiscordComponentMentionableSelect(ctx);
}

export function createDiscordComponentChannelSelect(ctx: AgentComponentContext): ChannelSelectMenu {
  return new DiscordComponentChannelSelect(ctx);
}

export function createDiscordComponentModal(ctx: AgentComponentContext): Modal {
  return new DiscordComponentModal(ctx);
}
