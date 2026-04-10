import { sendMessageMatrix, sendPollMatrix } from "./matrix/send.js";
import {
  type ChannelOutboundAdapter,
  chunkTextForOutbound,
  resolveOutboundSendDep,
} from "./runtime-api.js";

export const matrixOutbound: ChannelOutboundAdapter = {
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  deliveryMode: "direct",
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    mediaReadFile,
    deps,
    replyToId,
    threadId,
    accountId,
    audioAsVoice,
  }) => {
    const send =
      resolveOutboundSendDep<typeof sendMessageMatrix>(deps, "matrix") ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, text, {
      accountId: accountId ?? undefined,
      audioAsVoice,
      cfg,
      mediaLocalRoots,
      mediaReadFile,
      mediaUrl,
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
  },
  sendPoll: async ({ cfg, to, poll, threadId, accountId }) => {
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await sendPollMatrix(to, poll, {
      accountId: accountId ?? undefined,
      cfg,
      threadId: resolvedThreadId,
    });
    return {
      channel: "matrix",
      messageId: result.eventId,
      pollId: result.eventId,
      roomId: result.roomId,
    };
  },
  sendText: async ({ cfg, to, text, deps, replyToId, threadId, accountId, audioAsVoice }) => {
    const send =
      resolveOutboundSendDep<typeof sendMessageMatrix>(deps, "matrix") ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, text, {
      accountId: accountId ?? undefined,
      audioAsVoice,
      cfg,
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
  },
  textChunkLimit: 4000,
};
