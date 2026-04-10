import { parseTelegramTopicConversation } from "./topic-conversation.js";

export function resolveTelegramSessionConversation(params: {
  kind: "group" | "channel";
  rawId: string;
}) {
  const parsed = parseTelegramTopicConversation({ conversationId: params.rawId });
  if (!parsed) {
    return null;
  }
  return {
    baseConversationId: parsed.chatId,
    id: parsed.chatId,
    parentConversationCandidates: [parsed.chatId],
    threadId: parsed.topicId,
  };
}
