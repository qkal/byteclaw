import {
  type PluginConversationBinding,
  type PluginConversationBindingRequestParams,
  type PluginConversationBindingRequestResult,
  type PluginInteractiveRegistration,
  createInteractiveConversationBindingHelpers,
  dispatchPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";

export type TelegramInteractiveButtons = { text: string; callback_data: string; style?: "danger" | "success" | "primary" }[][];

export interface TelegramInteractiveHandlerContext {
  channel: "telegram";
  accountId: string;
  callbackId: string;
  conversationId: string;
  parentConversationId?: string;
  senderId?: string;
  senderUsername?: string;
  threadId?: number;
  isGroup: boolean;
  isForum: boolean;
  auth: {
    isAuthorizedSender: boolean;
  };
  callback: {
    data: string;
    namespace: string;
    payload: string;
    messageId: number;
    chatId: string;
    messageText?: string;
  };
  respond: {
    reply: (params: { text: string; buttons?: TelegramInteractiveButtons }) => Promise<void>;
    editMessage: (params: { text: string; buttons?: TelegramInteractiveButtons }) => Promise<void>;
    editButtons: (params: { buttons: TelegramInteractiveButtons }) => Promise<void>;
    clearButtons: () => Promise<void>;
    deleteMessage: () => Promise<void>;
  };
  requestConversationBinding: (
    params?: PluginConversationBindingRequestParams,
  ) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding: () => Promise<{ removed: boolean }>;
  getCurrentConversationBinding: () => Promise<PluginConversationBinding | null>;
}

export type TelegramInteractiveHandlerRegistration = PluginInteractiveRegistration<
  TelegramInteractiveHandlerContext,
  "telegram"
>;

export type TelegramInteractiveDispatchContext = Omit<
  TelegramInteractiveHandlerContext,
  | "callback"
  | "respond"
  | "channel"
  | "requestConversationBinding"
  | "detachConversationBinding"
  | "getCurrentConversationBinding"
> & {
  callbackMessage: {
    messageId: number;
    chatId: string;
    messageText?: string;
  };
};

export async function dispatchTelegramPluginInteractiveHandler(params: {
  data: string;
  callbackId: string;
  ctx: TelegramInteractiveDispatchContext;
  respond: {
    reply: (params: { text: string; buttons?: TelegramInteractiveButtons }) => Promise<void>;
    editMessage: (params: { text: string; buttons?: TelegramInteractiveButtons }) => Promise<void>;
    editButtons: (params: { buttons: TelegramInteractiveButtons }) => Promise<void>;
    clearButtons: () => Promise<void>;
    deleteMessage: () => Promise<void>;
  };
  onMatched?: () => Promise<void> | void;
}) {
  return await dispatchPluginInteractiveHandler<TelegramInteractiveHandlerRegistration>({
    channel: "telegram",
    data: params.data,
    dedupeId: params.callbackId,
    invoke: ({ registration, namespace, payload }) => {
      const { callbackMessage, ...handlerContext } = params.ctx;
      return registration.handler({
        ...handlerContext,
        callback: {
          chatId: callbackMessage.chatId,
          data: params.data,
          messageId: callbackMessage.messageId,
          messageText: callbackMessage.messageText,
          namespace,
          payload,
        },
        channel: "telegram",
        respond: params.respond,
        ...createInteractiveConversationBindingHelpers({
          conversation: {
            accountId: handlerContext.accountId,
            channel: "telegram",
            conversationId: handlerContext.conversationId,
            parentConversationId: handlerContext.parentConversationId,
            threadId: handlerContext.threadId,
          },
          registration,
          senderId: handlerContext.senderId,
        }),
      });
    },
    onMatched: params.onMatched,
  });
}
