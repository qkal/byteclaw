import { extractQaToolPayload } from "./extract-tool-payload.js";
import { type OpenClawConfig, qaChannelPlugin } from "./runtime-api.js";
import type { QaScenarioDefinition } from "./scenario.js";

export function createQaSelfCheckScenario(cfg: OpenClawConfig): QaScenarioDefinition {
  return {
    name: "Synthetic Slack-class roundtrip",
    steps: [
      {
        name: "DM echo roundtrip",
        async run({ state }) {
          state.addInboundMessage({
            conversation: { id: "alice", kind: "direct" },
            senderId: "alice",
            senderName: "Alice",
            text: "hello from qa",
          });
          await state.waitFor({
            direction: "outbound",
            kind: "message-text",
            textIncludes: "qa-echo: hello from qa",
            timeoutMs: 5000,
          });
        },
      },
      {
        name: "Thread create and threaded echo",
        async run({ state }) {
          const threadResult = await qaChannelPlugin.actions?.handleAction?.({
            accountId: "default",
            action: "thread-create",
            cfg,
            channel: "qa-channel",
            params: {
              channelId: "qa-room",
              title: "QA thread",
            },
          });
          const threadPayload = extractQaToolPayload(threadResult) as
            | { thread?: { id?: string } }
            | undefined;
          const threadId = threadPayload?.thread?.id;
          if (!threadId) {
            throw new Error("thread-create did not return thread id");
          }

          state.addInboundMessage({
            conversation: { id: "qa-room", kind: "channel", title: "QA Room" },
            senderId: "alice",
            senderName: "Alice",
            text: "inside thread",
            threadId,
            threadTitle: "QA thread",
          });
          await state.waitFor({
            direction: "outbound",
            kind: "message-text",
            textIncludes: "qa-echo: inside thread",
            timeoutMs: 5000,
          });
          return threadId;
        },
      },
      {
        name: "Reaction, edit, delete lifecycle",
        async run({ state }) {
          const outbound = state
            .searchMessages({ conversationId: "qa-room", query: "qa-echo: inside thread" })
            .at(-1);
          if (!outbound) {
            throw new Error("threaded outbound message not found");
          }

          await qaChannelPlugin.actions?.handleAction?.({
            accountId: "default",
            action: "react",
            cfg,
            channel: "qa-channel",
            params: {
              emoji: "white_check_mark",
              messageId: outbound.id,
            },
          });
          const reacted = state.readMessage({ messageId: outbound.id });
          if (reacted.reactions.length === 0) {
            throw new Error("reaction not recorded");
          }

          await qaChannelPlugin.actions?.handleAction?.({
            accountId: "default",
            action: "edit",
            cfg,
            channel: "qa-channel",
            params: {
              messageId: outbound.id,
              text: "qa-echo: inside thread (edited)",
            },
          });
          const edited = state.readMessage({ messageId: outbound.id });
          if (!edited.text.includes("(edited)")) {
            throw new Error("edit not recorded");
          }

          await qaChannelPlugin.actions?.handleAction?.({
            accountId: "default",
            action: "delete",
            cfg,
            channel: "qa-channel",
            params: {
              messageId: outbound.id,
            },
          });
          const deleted = state.readMessage({ messageId: outbound.id });
          if (!deleted.deleted) {
            throw new Error("delete not recorded");
          }
        },
      },
    ],
  };
}
