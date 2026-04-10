import { randomUUID } from "node:crypto";
import {
  buildQaBusSnapshot,
  cloneMessage,
  normalizeAccountId,
  normalizeConversationFromTarget,
  pollQaBusEvents,
  readQaBusMessage,
  searchQaBusMessages,
} from "./bus-queries.js";
import { createQaBusWaiterStore } from "./bus-waiters.js";
import type {
  QaBusAttachment,
  QaBusConversation,
  QaBusCreateThreadInput,
  QaBusDeleteMessageInput,
  QaBusEditMessageInput,
  QaBusEvent,
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusOutboundMessageInput,
  QaBusPollInput,
  QaBusReactToMessageInput,
  QaBusReadMessageInput,
  QaBusSearchMessagesInput,
  QaBusThread,
  QaBusWaitForInput,
} from "./runtime-api.js";

const DEFAULT_BOT_ID = "openclaw";
const DEFAULT_BOT_NAME = "OpenClaw QA";

type QaBusEventSeed =
  | {
      kind: "inbound-message";
      accountId: string;
      message: QaBusMessage;
    }
  | {
      kind: "outbound-message";
      accountId: string;
      message: QaBusMessage;
    }
  | {
      kind: "thread-created";
      accountId: string;
      thread: QaBusThread;
    }
  | {
      kind: "message-edited";
      accountId: string;
      message: QaBusMessage;
    }
  | {
      kind: "message-deleted";
      accountId: string;
      message: QaBusMessage;
    }
  | {
      kind: "reaction-added";
      accountId: string;
      message: QaBusMessage;
      emoji: string;
      senderId: string;
    };

export function createQaBusState() {
  const conversations = new Map<string, QaBusConversation>();
  const threads = new Map<string, QaBusThread>();
  const messages = new Map<string, QaBusMessage>();
  const events: QaBusEvent[] = [];
  let cursor = 0;
  const waiters = createQaBusWaiterStore(() =>
    buildQaBusSnapshot({
      conversations,
      cursor,
      events,
      messages,
      threads,
    }),
  );

  const pushEvent = (event: QaBusEventSeed | ((cursor: number) => QaBusEventSeed)): QaBusEvent => {
    cursor += 1;
    const next = typeof event === "function" ? event(cursor) : event;
    const finalized = { cursor, ...next } as QaBusEvent;
    events.push(finalized);
    waiters.settle();
    return finalized;
  };

  const ensureConversation = (conversation: QaBusConversation): QaBusConversation => {
    const existing = conversations.get(conversation.id);
    if (existing) {
      if (!existing.title && conversation.title) {
        existing.title = conversation.title;
      }
      return existing;
    }
    const created = { ...conversation };
    conversations.set(created.id, created);
    return created;
  };

  const createMessage = (params: {
    direction: QaBusMessage["direction"];
    accountId: string;
    conversation: QaBusConversation;
    senderId: string;
    senderName?: string;
    text: string;
    timestamp?: number;
    threadId?: string;
    threadTitle?: string;
    replyToId?: string;
    attachments?: QaBusAttachment[];
  }): QaBusMessage => {
    const conversation = ensureConversation(params.conversation);
    const message: QaBusMessage = {
      accountId: params.accountId,
      attachments: params.attachments?.map((attachment) => ({ ...attachment })) ?? [],
      conversation,
      direction: params.direction,
      id: randomUUID(),
      reactions: [],
      replyToId: params.replyToId,
      senderId: params.senderId,
      senderName: params.senderName,
      text: params.text,
      threadId: params.threadId,
      threadTitle: params.threadTitle,
      timestamp: params.timestamp ?? Date.now(),
    };
    messages.set(message.id, message);
    return message;
  };

  return {
    addInboundMessage(input: QaBusInboundMessageInput) {
      const accountId = normalizeAccountId(input.accountId);
      const message = createMessage({
        accountId,
        attachments: input.attachments,
        conversation: input.conversation,
        direction: "inbound",
        replyToId: input.replyToId,
        senderId: input.senderId,
        senderName: input.senderName,
        text: input.text,
        threadId: input.threadId,
        threadTitle: input.threadTitle,
        timestamp: input.timestamp,
      });
      pushEvent({
        accountId,
        kind: "inbound-message",
        message: cloneMessage(message),
      });
      return cloneMessage(message);
    },
    addOutboundMessage(input: QaBusOutboundMessageInput) {
      const accountId = normalizeAccountId(input.accountId);
      const { conversation, threadId } = normalizeConversationFromTarget(input.to);
      const message = createMessage({
        accountId,
        attachments: input.attachments,
        conversation,
        direction: "outbound",
        replyToId: input.replyToId,
        senderId: input.senderId?.trim() || DEFAULT_BOT_ID,
        senderName: input.senderName?.trim() || DEFAULT_BOT_NAME,
        text: input.text,
        threadId: input.threadId ?? threadId,
        timestamp: input.timestamp,
      });
      pushEvent({
        accountId,
        kind: "outbound-message",
        message: cloneMessage(message),
      });
      return cloneMessage(message);
    },
    createThread(input: QaBusCreateThreadInput) {
      const accountId = normalizeAccountId(input.accountId);
      const thread: QaBusThread = {
        accountId,
        conversationId: input.conversationId,
        createdAt: input.timestamp ?? Date.now(),
        createdBy: input.createdBy?.trim() || DEFAULT_BOT_ID,
        id: `thread-${randomUUID()}`,
        title: input.title,
      };
      threads.set(thread.id, thread);
      ensureConversation({
        id: input.conversationId,
        kind: "channel",
      });
      pushEvent({
        accountId,
        kind: "thread-created",
        thread: { ...thread },
      });
      return { ...thread };
    },
    deleteMessage(input: QaBusDeleteMessageInput) {
      const accountId = normalizeAccountId(input.accountId);
      const message = messages.get(input.messageId);
      if (!message) {
        throw new Error(`qa-bus message not found: ${input.messageId}`);
      }
      message.deleted = true;
      pushEvent({
        accountId,
        kind: "message-deleted",
        message: cloneMessage(message),
      });
      return cloneMessage(message);
    },
    editMessage(input: QaBusEditMessageInput) {
      const accountId = normalizeAccountId(input.accountId);
      const message = messages.get(input.messageId);
      if (!message) {
        throw new Error(`qa-bus message not found: ${input.messageId}`);
      }
      message.text = input.text;
      message.editedAt = input.timestamp ?? Date.now();
      pushEvent({
        accountId,
        kind: "message-edited",
        message: cloneMessage(message),
      });
      return cloneMessage(message);
    },
    getSnapshot() {
      return buildQaBusSnapshot({
        conversations,
        cursor,
        events,
        messages,
        threads,
      });
    },
    poll(input: QaBusPollInput = {}) {
      return pollQaBusEvents({ cursor, events, input });
    },
    reactToMessage(input: QaBusReactToMessageInput) {
      const accountId = normalizeAccountId(input.accountId);
      const message = messages.get(input.messageId);
      if (!message) {
        throw new Error(`qa-bus message not found: ${input.messageId}`);
      }
      const reaction = {
        emoji: input.emoji,
        senderId: input.senderId?.trim() || DEFAULT_BOT_ID,
        timestamp: input.timestamp ?? Date.now(),
      };
      message.reactions.push(reaction);
      pushEvent({
        accountId,
        emoji: reaction.emoji,
        kind: "reaction-added",
        message: cloneMessage(message),
        senderId: reaction.senderId,
      });
      return cloneMessage(message);
    },
    readMessage(input: QaBusReadMessageInput) {
      return readQaBusMessage({ input, messages });
    },
    reset() {
      conversations.clear();
      threads.clear();
      messages.clear();
      events.length = 0;
      // Keep the cursor monotonic across resets so long-poll clients do not
      // Miss fresh events after the bus is cleared mid-session.
      waiters.reset();
    },
    searchMessages(input: QaBusSearchMessagesInput) {
      return searchQaBusMessages({ input, messages });
    },
    async waitFor(input: QaBusWaitForInput) {
      return await waiters.waitFor(input);
    },
  };
}

export type QaBusState = ReturnType<typeof createQaBusState>;
