/**
 * HTTP callback handler for Mattermost slash commands.
 *
 * Receives POST requests from Mattermost when a slash command is invoked,
 * validates the token, and routes the command through the standard inbound pipeline.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqualSecret } from "openclaw/plugin-sdk/browser-security-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedMattermostAccount } from "../mattermost/accounts.js";
import { getMattermostRuntime } from "../runtime.js";
import {
  type MattermostChannel,
  createMattermostClient,
  fetchMattermostChannel,
  sendMattermostTyping,
} from "./client.js";
import {
  renderMattermostModelSummaryView,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerCurrentModel,
  resolveMattermostModelPickerEntry,
} from "./model-picker.js";
import {
  authorizeMattermostCommandInvocation,
  normalizeMattermostAllowList,
} from "./monitor-auth.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import {
  type OpenClawConfig,
  type ReplyPayload,
  type RuntimeEnv,
  buildModelsProviderData,
  createChannelReplyPipeline,
  isRequestBodyLimitError,
  logTypingFailure,
  readRequestBodyWithLimit,
} from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";
import {
  type MattermostSlashCommandResponse,
  parseSlashCommandPayload,
  resolveCommandText,
} from "./slash-commands.js";

interface SlashHttpHandlerParams {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  /** Expected token from registered commands (for validation). */
  commandTokens: Set<string>;
  /** Map from trigger to original command name (for skill commands that start with oc_). */
  triggerMap?: ReadonlyMap<string, string>;
  log?: (msg: string) => void;
}

const MAX_BODY_BYTES = 64 * 1024;
const BODY_READ_TIMEOUT_MS = 5000;

/**
 * Read the full request body as a string.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return readRequestBodyWithLimit(req, {
    maxBytes,
    timeoutMs: BODY_READ_TIMEOUT_MS,
  });
}

function sendJsonResponse(
  res: ServerResponse,
  status: number,
  body: MattermostSlashCommandResponse,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function matchesRegisteredCommandToken(
  commandTokens: ReadonlySet<string>,
  candidate: string,
): boolean {
  for (const token of commandTokens) {
    if (safeEqualSecret(candidate, token)) {
      return true;
    }
  }
  return false;
}

interface SlashInvocationAuth {
  ok: boolean;
  denyResponse?: MattermostSlashCommandResponse;
  commandAuthorized: boolean;
  channelInfo: MattermostChannel | null;
  kind: "direct" | "group" | "channel";
  chatType: "direct" | "group" | "channel";
  channelName: string;
  channelDisplay: string;
  roomLabel: string;
}

async function authorizeSlashInvocation(params: {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  client: ReturnType<typeof createMattermostClient>;
  commandText: string;
  channelId: string;
  senderId: string;
  senderName: string;
  log?: (msg: string) => void;
}): Promise<SlashInvocationAuth> {
  const { account, cfg, client, commandText, channelId, senderId, senderName, log } = params;
  const core = getMattermostRuntime();

  // Resolve channel info so we can enforce DM vs group/channel policies.
  let channelInfo: MattermostChannel | null = null;
  try {
    channelInfo = await fetchMattermostChannel(client, channelId);
  } catch (error) {
    log?.(`mattermost: slash channel lookup failed for ${channelId}: ${String(error)}`);
  }

  if (!channelInfo) {
    return {
      channelDisplay: "",
      channelInfo: null,
      channelName: "",
      chatType: "channel",
      commandAuthorized: false,
      denyResponse: {
        response_type: "ephemeral",
        text: "Temporary error: unable to determine channel type. Please try again.",
      },
      kind: "channel",
      ok: false,
      roomLabel: `#${channelId}`,
    };
  }

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg,
    surface: "mattermost",
  });
  const hasControlCommand = core.channel.text.hasControlCommand(commandText, cfg);
  const storeAllowFrom = normalizeMattermostAllowList(
    await core.channel.pairing
      .readAllowFromStore({
        accountId: account.accountId,
        channel: "mattermost",
      })
      .catch(() => []),
  );
  const decision = authorizeMattermostCommandInvocation({
    account,
    allowTextCommands,
    cfg,
    channelId,
    channelInfo,
    hasControlCommand,
    senderId,
    senderName,
    storeAllowFrom,
  });

  if (!decision.ok) {
    if (decision.denyReason === "dm-pairing") {
      const { code } = await core.channel.pairing.upsertPairingRequest({
        accountId: account.accountId,
        channel: "mattermost",
        id: senderId,
        meta: { name: senderName },
      });
      return {
        ...decision,
        denyResponse: {
          response_type: "ephemeral",
          text: core.channel.pairing.buildPairingReply({
            channel: "mattermost",
            code,
            idLine: `Your Mattermost user id: ${senderId}`,
          }),
        },
      };
    }

    const denyText =
      decision.denyReason === "unknown-channel"
        ? "Temporary error: unable to determine channel type. Please try again."
        : decision.denyReason === "dm-disabled"
          ? "This bot is not accepting direct messages."
          : decision.denyReason === "channels-disabled"
            ? "Slash commands are disabled in channels."
            : decision.denyReason === "channel-no-allowlist"
              ? "Slash commands are not configured for this channel (no allowlist)."
              : "Unauthorized.";
    return {
      ...decision,
      denyResponse: {
        response_type: "ephemeral",
        text: denyText,
      },
    };
  }

  return {
    ...decision,
    denyResponse: undefined,
  };
}

/**
 * Create the HTTP request handler for Mattermost slash command callbacks.
 *
 * This handler is registered as a plugin HTTP route and receives POSTs
 * from the Mattermost server when a user invokes a registered slash command.
 */
export function createSlashCommandHttpHandler(params: SlashHttpHandlerParams) {
  const { account, cfg, runtime, commandTokens, triggerMap, log } = params;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }

    let body: string;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT")) {
        res.statusCode = 408;
        res.end("Request body timeout");
        return;
      }
      res.statusCode = 413;
      res.end("Payload Too Large");
      return;
    }

    const contentType = req.headers["content-type"] ?? "";
    const payload = parseSlashCommandPayload(body, contentType);
    if (!payload) {
      sendJsonResponse(res, 400, {
        response_type: "ephemeral",
        text: "Invalid slash command payload.",
      });
      return;
    }

    // Validate token — fail closed: reject when no tokens are registered
    // (e.g. registration failed or startup was partial)
    if (commandTokens.size === 0 || !matchesRegisteredCommandToken(commandTokens, payload.token)) {
      sendJsonResponse(res, 401, {
        response_type: "ephemeral",
        text: "Unauthorized: invalid command token.",
      });
      return;
    }

    // Extract command info
    const trigger = payload.command.replace(/^\//, "").trim();
    const commandText = resolveCommandText(trigger, payload.text, triggerMap);
    const channelId = payload.channel_id;
    const senderId = payload.user_id;
    const senderName = payload.user_name ?? senderId;

    const client = createMattermostClient({
      allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
      baseUrl: account.baseUrl ?? "",
      botToken: account.botToken ?? "",
    });

    const auth = await authorizeSlashInvocation({
      account,
      cfg,
      channelId,
      client,
      commandText,
      log,
      senderId,
      senderName,
    });

    if (!auth.ok) {
      sendJsonResponse(
        res,
        200,
        auth.denyResponse ?? { response_type: "ephemeral", text: "Unauthorized." },
      );
      return;
    }

    log?.(`mattermost: slash command /${trigger} from ${senderName} in ${channelId}`);

    // Acknowledge immediately — we'll send the actual reply asynchronously
    sendJsonResponse(res, 200, {
      response_type: "ephemeral",
      text: "Processing...",
    });

    // Now handle the command asynchronously (post reply as a message)
    try {
      await handleSlashCommandAsync({
        account,
        cfg,
        channelDisplay: auth.channelDisplay,
        channelId,
        channelName: auth.channelName,
        chatType: auth.chatType,
        client,
        commandAuthorized: auth.commandAuthorized,
        commandText,
        kind: auth.kind,
        log,
        roomLabel: auth.roomLabel,
        runtime,
        senderId,
        senderName,
        teamId: payload.team_id,
        triggerId: payload.trigger_id,
      });
    } catch (error) {
      log?.(`mattermost: slash command handler error: ${String(error)}`);
      try {
        const to = `channel:${channelId}`;
        await sendMessageMattermost(to, "Sorry, something went wrong processing that command.", {
          accountId: account.accountId,
          cfg,
        });
      } catch {
        // Best-effort error reply
      }
    }
  };
}

async function handleSlashCommandAsync(params: {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  client: ReturnType<typeof createMattermostClient>;
  commandText: string;
  channelId: string;
  senderId: string;
  senderName: string;
  teamId: string;
  kind: "direct" | "group" | "channel";
  chatType: "direct" | "group" | "channel";
  channelName: string;
  channelDisplay: string;
  roomLabel: string;
  commandAuthorized: boolean;
  triggerId?: string;
  log?: (msg: string) => void;
}) {
  const {
    account,
    cfg,
    runtime,
    client,
    commandText,
    channelId,
    senderId,
    senderName,
    teamId,
    kind,
    chatType,
    channelName: _channelName,
    channelDisplay,
    roomLabel,
    commandAuthorized,
    triggerId,
    log,
  } = params;
  const core = getMattermostRuntime();

  const route = core.channel.routing.resolveAgentRoute({
    accountId: account.accountId,
    cfg,
    channel: "mattermost",
    peer: {
      id: kind === "direct" ? senderId : channelId,
      kind,
    },
    teamId,
  });

  const fromLabel =
    kind === "direct"
      ? `Mattermost DM from ${senderName}`
      : `Mattermost message in ${roomLabel} from ${senderName}`;

  const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;
  const pickerEntry = resolveMattermostModelPickerEntry(commandText);
  if (pickerEntry) {
    const data = await buildModelsProviderData(cfg, route.agentId);
    if (data.providers.length === 0) {
      await sendMessageMattermost(to, "No models available.", {
        accountId: account.accountId,
        cfg,
      });
      return;
    }

    const currentModel = resolveMattermostModelPickerCurrentModel({
      cfg,
      data,
      route,
    });
    const view =
      pickerEntry.kind === "summary"
        ? renderMattermostModelSummaryView({
            currentModel,
            ownerUserId: senderId,
          })
        : pickerEntry.kind === "providers"
          ? renderMattermostProviderPickerView({
              currentModel,
              data,
              ownerUserId: senderId,
            })
          : renderMattermostModelsPickerView({
              currentModel,
              data,
              ownerUserId: senderId,
              page: 1,
              provider: pickerEntry.provider,
            });

    await sendMessageMattermost(to, view.text, {
      accountId: account.accountId,
      buttons: view.buttons,
      cfg,
    });
    runtime.log?.(`delivered model picker to ${to}`);
    return;
  }

  // Build inbound context — the command text is the body
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    AccountId: route.accountId,
    Body: commandText,
    BodyForAgent: commandText,
    ChatType: chatType,
    CommandAuthorized: commandAuthorized,
    CommandBody: commandText,
    CommandSource: "native" as const,
    ConversationLabel: fromLabel,
    From:
      kind === "direct"
        ? `mattermost:${senderId}`
        : kind === "group"
          ? `mattermost:group:${channelId}`
          : `mattermost:channel:${channelId}`,
    GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : undefined,
    MessageSid: triggerId ?? `slash-${Date.now()}`,
    OriginatingChannel: "mattermost" as const,
    OriginatingTo: to,
    Provider: "mattermost" as const,
    RawBody: commandText,
    SenderId: senderId,
    SenderName: senderName,
    SessionKey: route.sessionKey,
    Surface: "mattermost" as const,
    Timestamp: Date.now(),
    To: to,
    WasMentioned: true,
  });

  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "mattermost", account.accountId, {
    fallbackLimit: account.textChunkLimit ?? 4000,
  });
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    accountId: account.accountId,
    cfg,
    channel: "mattermost",
  });

  const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
    accountId: account.accountId,
    agentId: route.agentId,
    cfg,
    channel: "mattermost",
    typing: {
      onStartError: (err) => {
        logTypingFailure({
          channel: "mattermost",
          error: err,
          log: (message) => log?.(message),
          target: channelId,
        });
      },
      start: () => sendMattermostTyping(client, { channelId }),
    },
  });
  const humanDelay = core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId);

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...replyPipeline,
      deliver: async (payload: ReplyPayload) => {
        await deliverMattermostReplyPayload({
          accountId: account.accountId,
          agentId: route.agentId,
          cfg,
          core,
          payload,
          sendMessage: sendMessageMattermost,
          tableMode,
          textLimit,
          to,
        });
        runtime.log?.(`delivered slash reply to ${to}`);
      },
      humanDelay,
      onError: (err, info) => {
        runtime.error?.(`mattermost slash ${info.kind} reply failed: ${String(err)}`);
      },
      onReplyStart: typingCallbacks?.onReplyStart,
    });

  await core.channel.reply.withReplyDispatcher({
    dispatcher,
    onSettled: () => {
      markDispatchIdle();
    },
    run: () =>
      core.channel.reply.dispatchReplyFromConfig({
        cfg,
        ctx: ctxPayload,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          disableBlockStreaming:
            typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
          onModelSelected,
        },
      }),
  });
}
