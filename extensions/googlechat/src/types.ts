export interface GoogleChatSpace {
  name?: string;
  displayName?: string;
  type?: string;
}

export interface GoogleChatUser {
  name?: string;
  displayName?: string;
  email?: string;
  type?: string;
}

export interface GoogleChatThread {
  name?: string;
  threadKey?: string;
}

export interface GoogleChatAttachmentDataRef {
  resourceName?: string;
  attachmentUploadToken?: string;
}

export interface GoogleChatAttachment {
  name?: string;
  contentName?: string;
  contentType?: string;
  thumbnailUri?: string;
  downloadUri?: string;
  source?: string;
  attachmentDataRef?: GoogleChatAttachmentDataRef;
  driveDataRef?: Record<string, unknown>;
}

export interface GoogleChatUserMention {
  user?: GoogleChatUser;
  type?: string;
}

export interface GoogleChatAnnotation {
  type?: string;
  startIndex?: number;
  length?: number;
  userMention?: GoogleChatUserMention;
  slashCommand?: Record<string, unknown>;
  richLinkMetadata?: Record<string, unknown>;
  customEmojiMetadata?: Record<string, unknown>;
}

export interface GoogleChatMessage {
  name?: string;
  text?: string;
  argumentText?: string;
  sender?: GoogleChatUser;
  thread?: GoogleChatThread;
  attachment?: GoogleChatAttachment[];
  annotations?: GoogleChatAnnotation[];
}

export interface GoogleChatEvent {
  type?: string;
  eventType?: string;
  eventTime?: string;
  space?: GoogleChatSpace;
  user?: GoogleChatUser;
  message?: GoogleChatMessage;
}

export interface GoogleChatReaction {
  name?: string;
  user?: GoogleChatUser;
  emoji?: { unicode?: string };
}
