import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { createFeishuCommentReplyDispatcher } from "./comment-dispatcher.js";
import {
  type ClawdbotConfig,
  type RuntimeEnv,
  createChannelPairingController,
} from "./comment-handler-runtime-api.js";
import { buildFeishuCommentTarget } from "./comment-target.js";
import { deliverCommentThreadText } from "./drive.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";
import {
  type FeishuDriveCommentNoticeEvent,
  resolveDriveCommentEventTurn,
} from "./monitor.comment.js";
import { resolveFeishuAllowlistMatch } from "./policy.js";
import { getFeishuRuntime } from "./runtime.js";
import type { DynamicAgentCreationConfig } from "./types.js";

interface HandleFeishuCommentEventParams {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  event: FeishuDriveCommentNoticeEvent;
  botOpenId?: string;
}

function buildCommentSessionKey(params: {
  core: ReturnType<typeof getFeishuRuntime>;
  route: ResolvedAgentRoute;
  commentTarget: string;
}): string {
  return params.core.channel.routing.buildAgentSessionKey({
    accountId: params.route.accountId,
    agentId: params.route.agentId,
    channel: "feishu",
    dmScope: "per-account-channel-peer",
    peer: {
      id: params.commentTarget,
      kind: "direct",
    },
  });
}

function parseTimestampMs(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export async function handleFeishuCommentEvent(
  params: HandleFeishuCommentEventParams,
): Promise<void> {
  const account = resolveFeishuRuntimeAccount({ accountId: params.accountId, cfg: params.cfg });
  const feishuCfg = account.config;
  const core = getFeishuRuntime();
  const log = params.runtime?.log ?? console.log;
  const error = params.runtime?.error ?? console.error;
  const runtime = (params.runtime ?? { error, log }) as RuntimeEnv;

  const turn = await resolveDriveCommentEventTurn({
    accountId: account.accountId,
    botOpenId: params.botOpenId,
    cfg: params.cfg,
    event: params.event,
    logger: log,
  });
  if (!turn) {
    log(
      `feishu[${account.accountId}]: drive comment notice skipped ` +
        `event=${params.event.event_id ?? "unknown"} comment=${params.event.comment_id ?? "unknown"}`,
    );
    return;
  }

  const commentTarget = buildFeishuCommentTarget({
    commentId: turn.commentId,
    fileToken: turn.fileToken,
    fileType: turn.fileType,
  });
  const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
  const configAllowFrom = feishuCfg?.allowFrom ?? [];
  const pairing = createChannelPairingController({
    accountId: account.accountId,
    channel: "feishu",
    core,
  });
  const storeAllowFrom =
    dmPolicy !== "allowlist" && dmPolicy !== "open"
      ? await pairing.readAllowFromStore().catch(() => [])
      : [];
  const effectiveDmAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const senderAllowed = resolveFeishuAllowlistMatch({
    allowFrom: effectiveDmAllowFrom,
    senderId: turn.senderId,
    senderIds: [turn.senderUserId],
  }).allowed;
  if (dmPolicy !== "open" && !senderAllowed) {
    if (dmPolicy === "pairing") {
      const client = createFeishuClient(account);
      await pairing.issueChallenge({
        meta: { name: turn.senderId },
        onCreated: ({ code }) => {
          log(
            `feishu[${account.accountId}]: comment pairing request sender=${turn.senderId} code=${code}`,
          );
        },
        onReplyError: (err) => {
          log(
            `feishu[${account.accountId}]: comment pairing reply failed for ${turn.senderId}: ${String(err)}`,
          );
        },
        sendPairingReply: async (text) => {
          await deliverCommentThreadText(client, {
            comment_id: turn.commentId,
            content: text,
            file_token: turn.fileToken,
            file_type: turn.fileType,
            is_whole_comment: turn.isWholeComment,
          });
        },
        senderId: turn.senderId,
        senderIdLine: `Your Feishu user id: ${turn.senderId}`,
      });
    } else {
      log(
        `feishu[${account.accountId}]: blocked unauthorized comment sender ${turn.senderId} ` +
          `(dmPolicy=${dmPolicy}, comment=${turn.commentId})`,
      );
    }
    return;
  }

  let effectiveCfg = params.cfg;
  let route = core.channel.routing.resolveAgentRoute({
    accountId: account.accountId,
    cfg: params.cfg,
    channel: "feishu",
    peer: {
      id: turn.senderId,
      kind: "direct",
    },
  });
  if (route.matchedBy === "default") {
    const dynamicCfg = feishuCfg?.dynamicAgentCreation as DynamicAgentCreationConfig | undefined;
    if (dynamicCfg?.enabled) {
      const dynamicResult = await maybeCreateDynamicAgent({
        cfg: params.cfg,
        dynamicCfg,
        log: (message) => log(message),
        runtime: core,
        senderOpenId: turn.senderId,
      });
      if (dynamicResult.created) {
        effectiveCfg = dynamicResult.updatedCfg;
        route = core.channel.routing.resolveAgentRoute({
          accountId: account.accountId,
          cfg: dynamicResult.updatedCfg,
          channel: "feishu",
          peer: {
            id: turn.senderId,
            kind: "direct",
          },
        });
        log(
          `feishu[${account.accountId}]: dynamic agent created for comment flow, route=${route.sessionKey}`,
        );
      }
    }
  }

  const commentSessionKey = buildCommentSessionKey({
    commentTarget,
    core,
    route,
  });
  const bodyForAgent = `[message_id: ${turn.messageId}]\n${turn.prompt}`;
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    AccountId: route.accountId,
    Body: bodyForAgent,
    BodyForAgent: bodyForAgent,
    ChatType: "direct",
    CommandAuthorized: false,
    CommandBody: turn.targetReplyText ?? turn.rootCommentText ?? turn.prompt,
    ConversationLabel: turn.documentTitle
      ? `Feishu comment · ${turn.documentTitle}`
      : "Feishu comment",
    From: `feishu:${turn.senderId}`,
    MessageSid: turn.messageId,
    OriginatingChannel: "feishu",
    OriginatingTo: commentTarget,
    Provider: "feishu",
    RawBody: turn.targetReplyText ?? turn.rootCommentText ?? turn.prompt,
    SenderId: turn.senderId,
    SenderName: turn.senderId,
    SessionKey: commentSessionKey,
    Surface: "feishu-comment",
    Timestamp: parseTimestampMs(turn.timestamp),
    To: commentTarget,
    WasMentioned: turn.isMentioned,
  });

  const storePath = core.channel.session.resolveStorePath(effectiveCfg.session?.store, {
    agentId: route.agentId,
  });
  await core.channel.session.recordInboundSession({
    ctx: ctxPayload,
    onRecordError: (err) => {
      error(
        `feishu[${account.accountId}]: failed to record comment inbound session ${commentSessionKey}: ${String(err)}`,
      );
    },
    sessionKey: commentSessionKey,
    storePath,
  });

  const { dispatcher, replyOptions, markDispatchIdle } = createFeishuCommentReplyDispatcher({
    accountId: account.accountId,
    agentId: route.agentId,
    cfg: effectiveCfg,
    commentId: turn.commentId,
    fileToken: turn.fileToken,
    fileType: turn.fileType,
    isWholeComment: turn.isWholeComment,
    runtime,
  });

  log(
    `feishu[${account.accountId}]: dispatching drive comment to agent ` +
      `(session=${commentSessionKey} comment=${turn.commentId} type=${turn.noticeType})`,
  );
  const { queuedFinal, counts } = await core.channel.reply.withReplyDispatcher({
    dispatcher,
    onSettled: () => {
      markDispatchIdle();
    },
    run: () =>
      core.channel.reply.dispatchReplyFromConfig({
        cfg: effectiveCfg,
        ctx: ctxPayload,
        dispatcher,
        replyOptions,
      }),
  });
  log(
    `feishu[${account.accountId}]: drive comment dispatch complete ` +
      `(queuedFinal=${queuedFinal}, replies=${counts.final}, session=${commentSessionKey})`,
  );
}
