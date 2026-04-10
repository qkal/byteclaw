import { da, scot } from "@urbit/aura";
import { type Story, createImageBlock, isImageUrl, markdownToStory } from "./story.js";

export interface TlonPokeApi {
  poke: (params: { app: string; mark: string; json: unknown }) => Promise<unknown>;
}

interface SendTextParams {
  api: TlonPokeApi;
  fromShip: string;
  toShip: string;
  text: string;
}

interface SendStoryParams {
  api: TlonPokeApi;
  fromShip: string;
  toShip: string;
  story: Story;
}

export async function sendDm({ api, fromShip, toShip, text }: SendTextParams) {
  const story: Story = markdownToStory(text);
  return sendDmWithStory({ api, fromShip, story, toShip });
}

export async function sendDmWithStory({ api, fromShip, toShip, story }: SendStoryParams) {
  const sentAt = Date.now();
  const idUd = scot("ud", da.fromUnix(sentAt));
  const id = `${fromShip}/${idUd}`;

  const delta = {
    add: {
      kind: null,
      memo: {
        author: fromShip,
        content: story,
        sent: sentAt,
      },
      time: null,
    },
  };

  const action = {
    diff: { delta, id },
    ship: toShip,
  };

  await api.poke({
    app: "chat",
    json: action,
    mark: "chat-dm-action",
  });

  return { channel: "tlon", messageId: id };
}

interface SendGroupParams {
  api: TlonPokeApi;
  fromShip: string;
  hostShip: string;
  channelName: string;
  text: string;
  replyToId?: string | null;
}

interface SendGroupStoryParams {
  api: TlonPokeApi;
  fromShip: string;
  hostShip: string;
  channelName: string;
  story: Story;
  replyToId?: string | null;
}

export async function sendGroupMessage({
  api,
  fromShip,
  hostShip,
  channelName,
  text,
  replyToId,
}: SendGroupParams) {
  const story: Story = markdownToStory(text);
  return sendGroupMessageWithStory({ api, channelName, fromShip, hostShip, replyToId, story });
}

export async function sendGroupMessageWithStory({
  api,
  fromShip,
  hostShip,
  channelName,
  story,
  replyToId,
}: SendGroupStoryParams) {
  const sentAt = Date.now();

  // Format reply ID as @ud (with dots) - required for Tlon to recognize thread replies
  let formattedReplyId = replyToId;
  if (replyToId && /^\d+$/.test(replyToId)) {
    try {
      // Scot('ud', n) formats a number as @ud with dots
      formattedReplyId = scot("ud", BigInt(replyToId));
    } catch {
      // Fall back to raw ID if formatting fails
    }
  }

  const action = {
    channel: {
      action: formattedReplyId
        ? {
            // Thread reply - needs post wrapper around reply action
            // ReplyActionAdd takes Memo: {content, author, sent} - no kind/blob/meta
            post: {
              reply: {
                action: {
                  add: {
                    author: fromShip,
                    content: story,
                    sent: sentAt,
                  },
                },
                id: formattedReplyId,
              },
            },
          }
        : {
            // Regular post
            post: {
              add: {
                author: fromShip,
                blob: null,
                content: story,
                kind: "/chat",
                meta: null,
                sent: sentAt,
              },
            },
          },
      nest: `chat/${hostShip}/${channelName}`,
    },
  };

  await api.poke({
    app: "channels",
    json: action,
    mark: "channel-action-1",
  });

  return { channel: "tlon", messageId: `${fromShip}/${sentAt}` };
}

export function buildMediaText(text: string | undefined, mediaUrl: string | undefined): string {
  const cleanText = text?.trim() ?? "";
  const cleanUrl = mediaUrl?.trim() ?? "";
  if (cleanText && cleanUrl) {
    return `${cleanText}\n${cleanUrl}`;
  }
  if (cleanUrl) {
    return cleanUrl;
  }
  return cleanText;
}

/**
 * Build a story with text and optional media (image)
 */
export function buildMediaStory(text: string | undefined, mediaUrl: string | undefined): Story {
  const story: Story = [];
  const cleanText = text?.trim() ?? "";
  const cleanUrl = mediaUrl?.trim() ?? "";

  // Add text content if present
  if (cleanText) {
    story.push(...markdownToStory(cleanText));
  }

  // Add image block if URL looks like an image
  if (cleanUrl && isImageUrl(cleanUrl)) {
    story.push(createImageBlock(cleanUrl, ""));
  } else if (cleanUrl) {
    // For non-image URLs, add as a link
    story.push({ inline: [{ link: { content: cleanUrl, href: cleanUrl } }] });
  }

  return story.length > 0 ? story : [{ inline: [""] }];
}
