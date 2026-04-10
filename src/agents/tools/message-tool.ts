import { type TSchema, Type } from "@sinclair/typebox";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import {
  channelSupportsMessageCapability,
  channelSupportsMessageCapabilityForChannel,
  listChannelMessageActions,
  resolveChannelMessageToolSchemaProperties,
} from "../../channels/plugins/message-action-discovery.js";
import type { ChannelMessageCapability } from "../../channels/plugins/message-capabilities.js";
import {
  CHANNEL_MESSAGE_ACTION_NAMES,
  type ChannelMessageActionName,
} from "../../channels/plugins/types.js";
import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import { getScopedChannelsCommandSecretTargets } from "../../cli/command-secret-targets.js";
import { resolveMessageSecretScope } from "../../cli/message-secret-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../gateway/protocol/client-info.js";
import { getToolResult, runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { POLL_CREATION_PARAM_DEFS, SHARED_POLL_CREATION_PARAM_NAMES } from "../../poll-params.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { stripReasoningTagsFromText } from "../../shared/text/reasoning-tags.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { listChannelSupportedActions } from "../channel-tools.js";
import { channelTargetSchema, channelTargetsSchema, stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { resolveGatewayOptions } from "./gateway.js";

const AllMessageActions = CHANNEL_MESSAGE_ACTION_NAMES;
const MESSAGE_TOOL_THREAD_READ_HINT =
  ' Use action="read" with threadId to fetch prior messages in a thread when you need conversation context you do not have yet.';
const EXPLICIT_TARGET_ACTIONS = new Set<ChannelMessageActionName>([
  "send",
  "sendWithEffect",
  "sendAttachment",
  "upload-file",
  "reply",
  "thread-reply",
  "broadcast",
]);

function actionNeedsExplicitTarget(action: ChannelMessageActionName): boolean {
  return EXPLICIT_TARGET_ACTIONS.has(action);
}
function buildRoutingSchema() {
  return {
    accountId: Type.Optional(Type.String()),
    channel: Type.Optional(Type.String()),
    dryRun: Type.Optional(Type.Boolean()),
    target: Type.Optional(channelTargetSchema({ description: "Target channel/user id or name." })),
    targets: Type.Optional(channelTargetsSchema()),
  };
}

const interactiveOptionSchema = Type.Object({
  label: Type.String(),
  value: Type.String(),
});

const interactiveButtonSchema = Type.Object({
  label: Type.String(),
  style: Type.Optional(stringEnum(["primary", "secondary", "success", "danger"])),
  value: Type.String(),
});

const interactiveBlockSchema = Type.Object({
  buttons: Type.Optional(Type.Array(interactiveButtonSchema)),
  options: Type.Optional(Type.Array(interactiveOptionSchema)),
  placeholder: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  type: stringEnum(["text", "buttons", "select"]),
});

const interactiveMessageSchema = Type.Object(
  {
    blocks: Type.Array(interactiveBlockSchema),
  },
  {
    description:
      "Shared interactive message payload for buttons and selects. Channels render this into their native components when supported.",
  },
);

function buildSendSchema(options: { includeInteractive: boolean }) {
  const props: Record<string, TSchema> = {
    asDocument: Type.Optional(
      Type.Boolean({
        description:
          "Send image/GIF as document to avoid Telegram compression. Alias for forceDocument (Telegram only).",
      }),
    ),
    asVoice: Type.Optional(Type.Boolean()),
    bestEffort: Type.Optional(Type.Boolean()),
    buffer: Type.Optional(
      Type.String({
        description: "Base64 payload for attachments (optionally a data: URL).",
      }),
    ),
    caption: Type.Optional(Type.String()),
    contentType: Type.Optional(Type.String()),
    effect: Type.Optional(
      Type.String({ description: "Alias for effectId (e.g., invisible-ink, balloons)." }),
    ),
    effectId: Type.Optional(
      Type.String({
        description: "Message effect name/id for sendWithEffect (e.g., invisible ink).",
      }),
    ),
    filePath: Type.Optional(Type.String()),
    filename: Type.Optional(Type.String()),
    forceDocument: Type.Optional(
      Type.Boolean({
        description: "Send image/GIF as document to avoid Telegram compression (Telegram only).",
      }),
    ),
    gifPlayback: Type.Optional(Type.Boolean()),
    interactive: Type.Optional(interactiveMessageSchema),
    media: Type.Optional(
      Type.String({
        description: "Media URL or local path. data: URLs are not supported here, use buffer.",
      }),
    ),
    message: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    quoteText: Type.Optional(
      Type.String({ description: "Quote text for Telegram reply_parameters" }),
    ),
    replyTo: Type.Optional(Type.String()),
    silent: Type.Optional(Type.Boolean()),
    threadId: Type.Optional(Type.String()),
  };
  if (!options.includeInteractive) {
    delete props.interactive;
  }
  return props;
}

function buildReactionSchema() {
  return {
    emoji: Type.Optional(Type.String()),
    groupId: Type.Optional(Type.String()),
    messageId: Type.Optional(
      Type.String({
        description:
          "Target message id for reaction. If omitted, defaults to the current inbound message id when available.",
      }),
    ),
    message_id: Type.Optional(
      Type.String({
        // Intentional duplicate alias for tool-schema discoverability in LLMs.
        description:
          "snake_case alias of messageId. If omitted, defaults to the current inbound message id when available.",
      }),
    ),
    remove: Type.Optional(Type.Boolean()),
    targetAuthor: Type.Optional(Type.String()),
    targetAuthorUuid: Type.Optional(Type.String()),
  };
}

function buildFetchSchema() {
  return {
    after: Type.Optional(Type.String()),
    around: Type.Optional(Type.String()),
    before: Type.Optional(Type.String()),
    fromMe: Type.Optional(Type.Boolean()),
    includeArchived: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Number()),
    pageSize: Type.Optional(Type.Number()),
    pageToken: Type.Optional(Type.String()),
  };
}

function buildPollSchema() {
  const props: Record<string, TSchema> = {
    pollId: Type.Optional(Type.String()),
    pollOptionId: Type.Optional(
      Type.String({
        description: "Poll answer id to vote for. Use when the channel exposes stable answer ids.",
      }),
    ),
    pollOptionIds: Type.Optional(
      Type.Array(
        Type.String({
          description:
            "Poll answer ids to vote for in a multiselect poll. Use when the channel exposes stable answer ids.",
        }),
      ),
    ),
    pollOptionIndex: Type.Optional(
      Type.Number({
        description:
          "1-based poll option number to vote for, matching the rendered numbered poll choices.",
      }),
    ),
    pollOptionIndexes: Type.Optional(
      Type.Array(
        Type.Number({
          description:
            "1-based poll option numbers to vote for in a multiselect poll, matching the rendered numbered poll choices.",
        }),
      ),
    ),
  };
  for (const name of SHARED_POLL_CREATION_PARAM_NAMES) {
    const def = POLL_CREATION_PARAM_DEFS[name];
    switch (def.kind) {
      case "string": {
        props[name] = Type.Optional(Type.String());
        break;
      }
      case "stringArray": {
        props[name] = Type.Optional(Type.Array(Type.String()));
        break;
      }
      case "number": {
        props[name] = Type.Optional(Type.Number());
        break;
      }
      case "boolean": {
        props[name] = Type.Optional(Type.Boolean());
        break;
      }
    }
  }
  return props;
}

function buildChannelTargetSchema() {
  return {
    authorId: Type.Optional(Type.String()),
    authorIds: Type.Optional(Type.Array(Type.String())),
    channelId: Type.Optional(
      Type.String({ description: "Channel id filter (search/thread list/event create)." }),
    ),
    channelIds: Type.Optional(
      Type.Array(Type.String({ description: "Channel id filter (repeatable)." })),
    ),
    chatId: Type.Optional(
      Type.String({ description: "Chat id for chat-scoped metadata actions." }),
    ),
    guildId: Type.Optional(Type.String()),
    includeMembers: Type.Optional(Type.Boolean()),
    kind: Type.Optional(Type.String()),
    memberId: Type.Optional(Type.String()),
    memberIdType: Type.Optional(Type.String()),
    members: Type.Optional(Type.Boolean()),
    openId: Type.Optional(Type.String()),
    participant: Type.Optional(Type.String()),
    roleId: Type.Optional(Type.String()),
    roleIds: Type.Optional(Type.Array(Type.String())),
    scope: Type.Optional(Type.String()),
    unionId: Type.Optional(Type.String()),
    userId: Type.Optional(Type.String()),
  };
}

function buildStickerSchema() {
  return {
    emojiName: Type.Optional(Type.String()),
    stickerDesc: Type.Optional(Type.String()),
    stickerId: Type.Optional(Type.Array(Type.String())),
    stickerName: Type.Optional(Type.String()),
    stickerTags: Type.Optional(Type.String()),
  };
}

function buildThreadSchema() {
  return {
    appliedTags: Type.Optional(Type.Array(Type.String())),
    autoArchiveMin: Type.Optional(Type.Number()),
    threadName: Type.Optional(Type.String()),
  };
}

function buildEventSchema() {
  return {
    desc: Type.Optional(Type.String()),
    durationMin: Type.Optional(Type.Number()),
    endTime: Type.Optional(Type.String()),
    eventName: Type.Optional(Type.String()),
    eventType: Type.Optional(Type.String()),
    image: Type.Optional(
      Type.String({ description: "Cover image URL or local file path for the event." }),
    ),
    location: Type.Optional(Type.String()),
    query: Type.Optional(Type.String()),
    startTime: Type.Optional(Type.String()),
    until: Type.Optional(Type.String()),
  };
}

function buildModerationSchema() {
  return {
    deleteDays: Type.Optional(Type.Number()),
    reason: Type.Optional(Type.String()),
  };
}

function buildGatewaySchema() {
  return {
    gatewayToken: Type.Optional(Type.String()),
    gatewayUrl: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  };
}

function buildPresenceSchema() {
  return {
    activityName: Type.Optional(
      Type.String({
        description: "Activity name shown in sidebar (e.g. 'with fire'). Ignored for custom type.",
      }),
    ),
    activityState: Type.Optional(
      Type.String({
        description:
          "State text. For custom type this is the status text; for others it shows in the flyout.",
      }),
    ),
    activityType: Type.Optional(
      Type.String({
        description: "Activity type: playing, streaming, listening, watching, competing, custom.",
      }),
    ),
    activityUrl: Type.Optional(
      Type.String({
        description:
          "Streaming URL (Twitch or YouTube). Only used with streaming type; may not render for bots.",
      }),
    ),
    status: Type.Optional(
      Type.String({ description: "Bot status: online, dnd, idle, invisible." }),
    ),
  };
}

function buildChannelManagementSchema() {
  return {
    categoryId: Type.Optional(Type.String()),
    clearParent: Type.Optional(
      Type.Boolean({
        description: "Clear the parent/category when supported by the provider.",
      }),
    ),
    name: Type.Optional(Type.String()),
    nsfw: Type.Optional(Type.Boolean()),
    parentId: Type.Optional(Type.String()),
    position: Type.Optional(Type.Number()),
    rateLimitPerUser: Type.Optional(Type.Number()),
    topic: Type.Optional(Type.String()),
    type: Type.Optional(Type.Number()),
  };
}

function buildMessageToolSchemaProps(options: {
  includeInteractive: boolean;
  extraProperties?: Record<string, TSchema>;
}) {
  return {
    ...buildRoutingSchema(),
    ...buildSendSchema(options),
    ...buildReactionSchema(),
    ...buildFetchSchema(),
    ...buildPollSchema(),
    ...buildChannelTargetSchema(),
    ...buildStickerSchema(),
    ...buildThreadSchema(),
    ...buildEventSchema(),
    ...buildModerationSchema(),
    ...buildGatewaySchema(),
    ...buildChannelManagementSchema(),
    ...buildPresenceSchema(),
    ...options.extraProperties,
  };
}

function buildMessageToolSchemaFromActions(
  actions: readonly string[],
  options: {
    includeInteractive: boolean;
    extraProperties?: Record<string, TSchema>;
  },
) {
  const props = buildMessageToolSchemaProps(options);
  return Type.Object({
    action: stringEnum(actions),
    ...props,
  });
}

const MessageToolSchema = buildMessageToolSchemaFromActions(AllMessageActions, {
  includeInteractive: true,
});

interface MessageToolOptions {
  agentAccountId?: string;
  agentSessionKey?: string;
  sessionId?: string;
  config?: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
  resolveCommandSecretRefsViaGateway?: typeof resolveCommandSecretRefsViaGateway;
  runMessageAction?: typeof runMessageAction;
  currentChannelId?: string;
  currentChannelProvider?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
  sandboxRoot?: string;
  requireExplicitTarget?: boolean;
  requesterSenderId?: string;
}

function resolveMessageToolSchemaActions(params: {
  cfg: OpenClawConfig;
  currentChannelProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentAccountId?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  requesterSenderId?: string;
}): string[] {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  if (currentChannel) {
    const scopedActions = listChannelSupportedActions({
      accountId: params.currentAccountId,
      agentId: params.agentId,
      cfg: params.cfg,
      channel: currentChannel,
      currentChannelId: params.currentChannelId,
      currentMessageId: params.currentMessageId,
      currentThreadTs: params.currentThreadTs,
      requesterSenderId: params.requesterSenderId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
    const allActions = new Set<string>(["send", ...scopedActions]);
    // Include actions from other configured channels so isolated/cron agents
    // Can invoke cross-channel actions without validation errors.
    for (const plugin of listChannelPlugins()) {
      if (plugin.id === currentChannel) {
        continue;
      }
      for (const action of listChannelSupportedActions({
        accountId: params.currentAccountId,
        agentId: params.agentId,
        cfg: params.cfg,
        channel: plugin.id,
        currentChannelId: params.currentChannelId,
        currentMessageId: params.currentMessageId,
        currentThreadTs: params.currentThreadTs,
        requesterSenderId: params.requesterSenderId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      })) {
        allActions.add(action);
      }
    }
    return [...allActions];
  }
  const actions = listChannelMessageActions(params.cfg);
  return actions.length > 0 ? actions : ["send"];
}

function resolveIncludeCapability(
  params: {
    cfg: OpenClawConfig;
    currentChannelProvider?: string;
    currentChannelId?: string;
    currentThreadTs?: string;
    currentMessageId?: string | number;
    currentAccountId?: string;
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    requesterSenderId?: string;
  },
  capability: ChannelMessageCapability,
): boolean {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  if (currentChannel) {
    return channelSupportsMessageCapabilityForChannel(
      {
        accountId: params.currentAccountId,
        agentId: params.agentId,
        cfg: params.cfg,
        channel: currentChannel,
        currentChannelId: params.currentChannelId,
        currentMessageId: params.currentMessageId,
        currentThreadTs: params.currentThreadTs,
        requesterSenderId: params.requesterSenderId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      },
      capability,
    );
  }
  return channelSupportsMessageCapability(params.cfg, capability);
}

function resolveIncludeInteractive(params: {
  cfg: OpenClawConfig;
  currentChannelProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentAccountId?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  requesterSenderId?: string;
}): boolean {
  return resolveIncludeCapability(params, "interactive");
}

function buildMessageToolSchema(params: {
  cfg: OpenClawConfig;
  currentChannelProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentAccountId?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  requesterSenderId?: string;
}) {
  const actions = resolveMessageToolSchemaActions(params);
  const includeInteractive = resolveIncludeInteractive(params);
  const extraProperties = resolveChannelMessageToolSchemaProperties({
    accountId: params.currentAccountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: normalizeMessageChannel(params.currentChannelProvider),
    currentChannelId: params.currentChannelId,
    currentMessageId: params.currentMessageId,
    currentThreadTs: params.currentThreadTs,
    requesterSenderId: params.requesterSenderId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });
  return buildMessageToolSchemaFromActions(actions.length > 0 ? actions : ["send"], {
    extraProperties,
    includeInteractive,
  });
}

function resolveAgentAccountId(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return normalizeAccountId(trimmed);
}

function buildMessageToolDescription(options?: {
  config?: OpenClawConfig;
  currentChannel?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentAccountId?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  requesterSenderId?: string;
}): string {
  const baseDescription = "Send, delete, and manage messages via channel plugins.";
  const resolvedOptions = options ?? {};
  const currentChannel = normalizeMessageChannel(resolvedOptions.currentChannel);

  // If we have a current channel, show its actions and list other configured channels
  if (currentChannel) {
    const channelActions = listChannelSupportedActions({
      accountId: resolvedOptions.currentAccountId,
      agentId: resolvedOptions.agentId,
      cfg: resolvedOptions.config,
      channel: currentChannel,
      currentChannelId: resolvedOptions.currentChannelId,
      currentMessageId: resolvedOptions.currentMessageId,
      currentThreadTs: resolvedOptions.currentThreadTs,
      requesterSenderId: resolvedOptions.requesterSenderId,
      sessionId: resolvedOptions.sessionId,
      sessionKey: resolvedOptions.sessionKey,
    });
    if (channelActions.length > 0) {
      // Always include "send" as a base action
      const allActions = new Set<ChannelMessageActionName | "send">(["send", ...channelActions]);
      const actionList = [...allActions].toSorted().join(", ");
      let desc = `${baseDescription} Current channel (${currentChannel}) supports: ${actionList}.`;

      // Include other configured channels so cron/isolated agents can discover them
      const otherChannels: string[] = [];
      for (const plugin of listChannelPlugins()) {
        if (plugin.id === currentChannel) {
          continue;
        }
        const actions = listChannelSupportedActions({
          accountId: resolvedOptions.currentAccountId,
          agentId: resolvedOptions.agentId,
          cfg: resolvedOptions.config,
          channel: plugin.id,
          currentChannelId: resolvedOptions.currentChannelId,
          currentMessageId: resolvedOptions.currentMessageId,
          currentThreadTs: resolvedOptions.currentThreadTs,
          requesterSenderId: resolvedOptions.requesterSenderId,
          sessionId: resolvedOptions.sessionId,
          sessionKey: resolvedOptions.sessionKey,
        });
        if (actions.length > 0) {
          const all = new Set<ChannelMessageActionName | "send">(["send", ...actions]);
          otherChannels.push(`${plugin.id} (${[...all].toSorted().join(", ")})`);
        }
      }
      if (otherChannels.length > 0) {
        desc += ` Other configured channels: ${otherChannels.join(", ")}.`;
      }

      return appendMessageToolReadHint(
        desc,
        [...allActions] as Iterable<ChannelMessageActionName | "send">,
      );
    }
  }

  // Fallback to generic description with all configured actions
  if (resolvedOptions.config) {
    const actions = listChannelMessageActions(resolvedOptions.config);
    if (actions.length > 0) {
      return appendMessageToolReadHint(
        `${baseDescription} Supports actions: ${actions.join(", ")}.`,
        actions,
      );
    }
  }

  return `${baseDescription} Supports actions: send, delete, react, poll, pin, threads, and more.`;
}

function appendMessageToolReadHint(
  description: string,
  actions: Iterable<ChannelMessageActionName | "send">,
): string {
  for (const action of actions) {
    if (action === "read") {
      return `${description}${MESSAGE_TOOL_THREAD_READ_HINT}`;
    }
  }
  return description;
}

export function createMessageTool(options?: MessageToolOptions): AnyAgentTool {
  const loadConfigForTool = options?.loadConfig ?? loadConfig;
  const resolveSecretRefsForTool =
    options?.resolveCommandSecretRefsViaGateway ?? resolveCommandSecretRefsViaGateway;
  const runMessageActionForTool = options?.runMessageAction ?? runMessageAction;
  const agentAccountId = resolveAgentAccountId(options?.agentAccountId);
  const resolvedAgentId = options?.agentSessionKey
    ? resolveSessionAgentId({
        config: options?.config,
        sessionKey: options.agentSessionKey,
      })
    : undefined;
  const schema = options?.config
    ? buildMessageToolSchema({
        agentId: resolvedAgentId,
        cfg: options.config,
        currentAccountId: agentAccountId,
        currentChannelId: options.currentChannelId,
        currentChannelProvider: options.currentChannelProvider,
        currentMessageId: options.currentMessageId,
        currentThreadTs: options.currentThreadTs,
        requesterSenderId: options.requesterSenderId,
        sessionId: options.sessionId,
        sessionKey: options.agentSessionKey,
      })
    : MessageToolSchema;
  const description = buildMessageToolDescription({
    agentId: resolvedAgentId,
    config: options?.config,
    currentAccountId: agentAccountId,
    currentChannel: options?.currentChannelProvider,
    currentChannelId: options?.currentChannelId,
    currentMessageId: options?.currentMessageId,
    currentThreadTs: options?.currentThreadTs,
    requesterSenderId: options?.requesterSenderId,
    sessionId: options?.sessionId,
    sessionKey: options?.agentSessionKey,
  });

  return {
    description,
    displaySummary: "Send and manage messages across configured channels.",
    execute: async (_toolCallId, args, signal) => {
      // Check if already aborted before doing any work
      if (signal?.aborted) {
        const err = new Error("Message send aborted");
        err.name = "AbortError";
        throw err;
      }
      // Shallow-copy so we don't mutate the original event args (used for logging/dedup).
      const params = { ...(args as Record<string, unknown>) };

      // Strip reasoning tags from text fields — models may include <think>…</think>
      // In tool arguments, and the messaging tool send path has no other tag filtering.
      for (const field of ["text", "content", "message", "caption"]) {
        if (typeof params[field] === "string") {
          params[field] = stripReasoningTagsFromText(params[field]);
        }
      }

      const action = readStringParam(params, "action", {
        required: true,
      }) as ChannelMessageActionName;
      let cfg = options?.config;
      if (!cfg) {
        const loadedRaw = loadConfigForTool();
        const scope = resolveMessageSecretScope({
          accountId: params.accountId,
          channel: params.channel,
          fallbackAccountId: agentAccountId,
          fallbackChannel: options?.currentChannelProvider,
          target: params.target,
          targets: params.targets,
        });
        const scopedTargets = getScopedChannelsCommandSecretTargets({
          accountId: scope.accountId,
          channel: scope.channel,
          config: loadedRaw,
        });
        cfg = (
          await resolveSecretRefsForTool({
            config: loadedRaw,
            commandName: "tools.message",
            targetIds: scopedTargets.targetIds,
            ...(scopedTargets.allowedPaths ? { allowedPaths: scopedTargets.allowedPaths } : {}),
            mode: "enforce_resolved",
          })
        ).resolvedConfig;
      }
      const requireExplicitTarget = options?.requireExplicitTarget === true;
      if (requireExplicitTarget && actionNeedsExplicitTarget(action)) {
        const explicitTarget =
          (typeof params.target === "string" && params.target.trim().length > 0) ||
          (typeof params.to === "string" && params.to.trim().length > 0) ||
          (typeof params.channelId === "string" && params.channelId.trim().length > 0) ||
          (Array.isArray(params.targets) &&
            params.targets.some((value) => typeof value === "string" && value.trim().length > 0));
        if (!explicitTarget) {
          throw new Error(
            "Explicit message target required for this run. Provide target/targets (and channel when needed).",
          );
        }
      }

      const accountId = readStringParam(params, "accountId") ?? agentAccountId;
      if (accountId) {
        params.accountId = accountId;
      }

      const gatewayResolved = resolveGatewayOptions({
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        timeoutMs: readNumberParam(params, "timeoutMs"),
      });
      const gateway = {
        clientDisplayName: "agent",
        clientName: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        timeoutMs: gatewayResolved.timeoutMs,
        token: gatewayResolved.token,
        url: gatewayResolved.url,
      };
      const hasCurrentMessageId =
        typeof options?.currentMessageId === "number" ||
        (typeof options?.currentMessageId === "string" &&
          options.currentMessageId.trim().length > 0);

      const toolContext =
        options?.currentChannelId ||
        options?.currentChannelProvider ||
        options?.currentThreadTs ||
        hasCurrentMessageId ||
        options?.replyToMode ||
        options?.hasRepliedRef
          ? {
              currentChannelId: options?.currentChannelId,
              currentChannelProvider: options?.currentChannelProvider,
              currentThreadTs: options?.currentThreadTs,
              currentMessageId: options?.currentMessageId,
              replyToMode: options?.replyToMode,
              hasRepliedRef: options?.hasRepliedRef,
              // Direct tool invocations should not add cross-context decoration.
              // The agent is composing a message, not forwarding from another chat.
              skipCrossContextDecoration: true,
            }
          : undefined;

      const result = await runMessageActionForTool({
        abortSignal: signal,
        action,
        agentId: resolvedAgentId,
        cfg,
        defaultAccountId: accountId ?? undefined,
        gateway,
        params,
        requesterSenderId: options?.requesterSenderId,
        sandboxRoot: options?.sandboxRoot,
        sessionId: options?.sessionId,
        sessionKey: options?.agentSessionKey,
        toolContext,
      });

      const toolResult = getToolResult(result);
      if (toolResult) {
        return toolResult;
      }
      return jsonResult(result.payload);
    },
    label: "Message",
    name: "message",
    parameters: schema,
  };
}
