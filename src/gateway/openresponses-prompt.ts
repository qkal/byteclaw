import {
  type ConversationEntry,
  buildAgentMessageFromConversationEntries,
} from "./agent-prompt.js";
import type { ContentPart, ItemParam } from "./open-responses.schema.js";

function extractTextContent(content: string | ContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === "input_text") {
        return part.text;
      }
      if (part.type === "output_text") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function buildAgentPrompt(input: string | ItemParam[]): {
  message: string;
  extraSystemPrompt?: string;
} {
  if (typeof input === "string") {
    return { message: input };
  }

  const systemParts: string[] = [];
  const conversationEntries: ConversationEntry[] = [];

  for (const item of input) {
    if (item.type === "message") {
      const content = extractTextContent(item.content).trim();
      if (!content) {
        continue;
      }

      if (item.role === "system" || item.role === "developer") {
        systemParts.push(content);
        continue;
      }

      const normalizedRole = item.role === "assistant" ? "assistant" : "user";
      const sender = normalizedRole === "assistant" ? "Assistant" : "User";

      conversationEntries.push({
        entry: { body: content, sender },
        role: normalizedRole,
      });
    } else if (item.type === "function_call_output") {
      conversationEntries.push({
        entry: { body: item.output, sender: `Tool:${item.call_id}` },
        role: "tool",
      });
    }
    // Skip reasoning and item_reference for prompt building (Phase 1)
  }

  const message = buildAgentMessageFromConversationEntries(conversationEntries);

  return {
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    message,
  };
}
