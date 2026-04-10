import { createAttachedChannelResultAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-runtime";
import { type ChannelOutboundAdapter, chunkTextForOutbound } from "../runtime-api.js";
import { createMSTeamsPollStoreFs } from "./polls.js";
import { sendMessageMSTeams, sendPollMSTeams } from "./send.js";

export const msteamsOutbound: ChannelOutboundAdapter = {
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  deliveryMode: "direct",
  pollMaxOptions: 12,
  textChunkLimit: 4000,
  ...createAttachedChannelResultAdapter({
    channel: "msteams",
    sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, mediaReadFile, deps }) => {
      type SendFn = (
        to: string,
        text: string,
        opts?: {
          mediaUrl?: string;
          mediaLocalRoots?: readonly string[];
          mediaReadFile?: (filePath: string) => Promise<Buffer>;
        },
      ) => Promise<{ messageId: string; conversationId: string }>;
      const send =
        resolveOutboundSendDep<SendFn>(deps, "msteams") ??
        ((to, text, opts) =>
          sendMessageMSTeams({
            cfg,
            mediaLocalRoots: opts?.mediaLocalRoots,
            mediaReadFile: opts?.mediaReadFile,
            mediaUrl: opts?.mediaUrl,
            text,
            to,
          }));
      return await send(to, text, { mediaLocalRoots, mediaReadFile, mediaUrl });
    },
    sendPoll: async ({ cfg, to, poll }) => {
      const maxSelections = poll.maxSelections ?? 1;
      const result = await sendPollMSTeams({
        cfg,
        maxSelections,
        options: poll.options,
        question: poll.question,
        to,
      });
      const pollStore = createMSTeamsPollStoreFs();
      await pollStore.createPoll({
        conversationId: result.conversationId,
        createdAt: new Date().toISOString(),
        id: result.pollId,
        maxSelections,
        messageId: result.messageId,
        options: poll.options,
        question: poll.question,
        votes: {},
      });
      return result;
    },
    sendText: async ({ cfg, to, text, deps }) => {
      type SendFn = (
        to: string,
        text: string,
      ) => Promise<{ messageId: string; conversationId: string }>;
      const send =
        resolveOutboundSendDep<SendFn>(deps, "msteams") ??
        ((to, text) => sendMessageMSTeams({ cfg, text, to }));
      return await send(to, text);
    },
  }),
};
