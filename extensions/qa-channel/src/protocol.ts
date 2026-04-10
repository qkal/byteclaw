export type QaBusConversationKind = "direct" | "channel";

export interface QaBusConversation {
  id: string;
  kind: QaBusConversationKind;
  title?: string;
}

export interface QaBusAttachment {
  id: string;
  kind: "image" | "video" | "audio" | "file";
  mimeType: string;
  fileName?: string;
  inline?: boolean;
  url?: string;
  contentBase64?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
  transcript?: string;
}

export interface QaBusMessage {
  id: string;
  accountId: string;
  direction: "inbound" | "outbound";
  conversation: QaBusConversation;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: number;
  threadId?: string;
  threadTitle?: string;
  replyToId?: string;
  deleted?: boolean;
  editedAt?: number;
  attachments?: QaBusAttachment[];
  reactions: {
    emoji: string;
    senderId: string;
    timestamp: number;
  }[];
}

export interface QaBusThread {
  id: string;
  accountId: string;
  conversationId: string;
  title: string;
  createdAt: number;
  createdBy: string;
}

export type QaBusEvent =
  | {
      cursor: number;
      kind: "inbound-message";
      accountId: string;
      message: QaBusMessage;
    }
  | {
      cursor: number;
      kind: "outbound-message";
      accountId: string;
      message: QaBusMessage;
    }
  | {
      cursor: number;
      kind: "thread-created";
      accountId: string;
      thread: QaBusThread;
    }
  | {
      cursor: number;
      kind: "message-edited";
      accountId: string;
      message: QaBusMessage;
    }
  | {
      cursor: number;
      kind: "message-deleted";
      accountId: string;
      message: QaBusMessage;
    }
  | {
      cursor: number;
      kind: "reaction-added";
      accountId: string;
      message: QaBusMessage;
      emoji: string;
      senderId: string;
    };

export interface QaBusInboundMessageInput {
  accountId?: string;
  conversation: QaBusConversation;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp?: number;
  threadId?: string;
  threadTitle?: string;
  replyToId?: string;
  attachments?: QaBusAttachment[];
}

export interface QaBusOutboundMessageInput {
  accountId?: string;
  to: string;
  senderId?: string;
  senderName?: string;
  text: string;
  timestamp?: number;
  threadId?: string;
  replyToId?: string;
  attachments?: QaBusAttachment[];
}

export interface QaBusCreateThreadInput {
  accountId?: string;
  conversationId: string;
  title: string;
  createdBy?: string;
  timestamp?: number;
}

export interface QaBusReactToMessageInput {
  accountId?: string;
  messageId: string;
  emoji: string;
  senderId?: string;
  timestamp?: number;
}

export interface QaBusEditMessageInput {
  accountId?: string;
  messageId: string;
  text: string;
  timestamp?: number;
}

export interface QaBusDeleteMessageInput {
  accountId?: string;
  messageId: string;
  timestamp?: number;
}

export interface QaBusSearchMessagesInput {
  accountId?: string;
  query?: string;
  conversationId?: string;
  threadId?: string;
  limit?: number;
}

export interface QaBusReadMessageInput {
  accountId?: string;
  messageId: string;
}

export interface QaBusPollInput {
  accountId?: string;
  cursor?: number;
  timeoutMs?: number;
  limit?: number;
}

export interface QaBusPollResult {
  cursor: number;
  events: QaBusEvent[];
}

export interface QaBusStateSnapshot {
  cursor: number;
  conversations: QaBusConversation[];
  threads: QaBusThread[];
  messages: QaBusMessage[];
  events: QaBusEvent[];
}

export type QaBusWaitForInput =
  | {
      timeoutMs?: number;
      kind: "event-kind";
      eventKind: QaBusEvent["kind"];
    }
  | {
      timeoutMs?: number;
      kind: "message-text";
      textIncludes: string;
      direction?: QaBusMessage["direction"];
    }
  | {
      timeoutMs?: number;
      kind: "thread-id";
      threadId: string;
    };
