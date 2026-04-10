import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import { PRUNED_HISTORY_IMAGE_MARKER, pruneProcessedHistoryImages } from "./history-image-prune.js";

function expectArrayMessageContent(
  message: AgentMessage | undefined,
  errorMessage: string,
): { type: string; text?: string; data?: string }[] {
  if (!message || !("content" in message) || !Array.isArray(message.content)) {
    throw new Error(errorMessage);
  }
  return message.content as { type: string; text?: string; data?: string }[];
}

function expectPrunedImageMessage(
  messages: AgentMessage[],
  errorMessage: string,
): { type: string; text?: string; data?: string }[] {
  const didMutate = pruneProcessedHistoryImages(messages);
  expect(didMutate).toBe(true);
  const content = expectArrayMessageContent(messages[0], errorMessage);
  expect(content).toHaveLength(2);
  expect(content[1]).toMatchObject({ text: PRUNED_HISTORY_IMAGE_MARKER, type: "text" });
  return content;
}

describe("pruneProcessedHistoryImages", () => {
  const image: ImageContent = { data: "abc", mimeType: "image/png", type: "image" };
  const assistantTurn = () => castAgentMessage({ content: "ack", role: "assistant" });
  const userText = () => castAgentMessage({ content: "more", role: "user" });

  it("prunes image blocks from user messages older than 3 assistant turns", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        content: [{ text: "See /tmp/photo.png", type: "text" }, { ...image }],
        role: "user",
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    const content = expectPrunedImageMessage(messages, "expected user array content");
    expect(content[0]?.type).toBe("text");
  });

  it("keeps image blocks that belong to the third-most-recent assistant turn", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        content: [{ text: "See /tmp/photo.png", type: "text" }, { ...image }],
        role: "user",
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(false);
    const content = expectArrayMessageContent(messages[0], "expected user array content");
    expect(content[1]).toMatchObject({ data: "abc", type: "image" });
  });

  it("does not count multiple assistant messages from one tool loop as separate turns", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        content: [{ text: "See /tmp/photo.png", type: "text" }, { ...image }],
        role: "user",
      }),
      castAgentMessage({
        content: [{ arguments: {}, id: "call_1", name: "read", type: "toolCall" }],
        role: "assistant",
      } as AgentMessage),
      castAgentMessage({
        content: [{ text: "bytes", type: "text" }],
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(false);
    const content = expectArrayMessageContent(messages[0], "expected user array content");
    expect(content[1]).toMatchObject({ data: "abc", type: "image" });
  });

  it("does not prune latest user message when no assistant response exists yet", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        content: [{ text: "See /tmp/photo.png", type: "text" }, { ...image }],
        role: "user",
      }),
    ];

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(false);
    const content = expectArrayMessageContent(messages[0], "expected user array content");
    expect(content).toHaveLength(2);
    expect(content[1]).toMatchObject({ data: "abc", type: "image" });
  });

  it("prunes image blocks from toolResult messages older than 3 assistant turns", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        content: [{ text: "screenshot bytes", type: "text" }, { ...image }],
        role: "toolResult",
        toolName: "read",
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    expectPrunedImageMessage(messages, "expected toolResult array content");
  });

  it("prunes only old images while preserving recent ones", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        content: [{ text: "old", type: "text" }, { ...image }],
        role: "user",
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
      castAgentMessage({
        content: [{ text: "recent", type: "text" }, { ...image }],
        role: "user",
      }),
      assistantTurn(),
    ];

    const didMutate = pruneProcessedHistoryImages(messages);
    expect(didMutate).toBe(true);

    const oldContent = expectArrayMessageContent(messages[0], "expected old user content");
    expect(oldContent[1]).toMatchObject({ text: PRUNED_HISTORY_IMAGE_MARKER, type: "text" });

    const recentContent = expectArrayMessageContent(messages[6], "expected recent user content");
    expect(recentContent[1]).toMatchObject({ data: "abc", type: "image" });
  });

  it("does not change messages when no assistant turn exists", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        content: "noop",
        role: "user",
      }),
    ];

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(false);
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe("noop");
  });
});
