import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { extractToolPayload } from "../../../src/infra/outbound/tool-payload.js";
import { createStartAccountContext } from "../../../test/helpers/plugins/start-account-context.js";
import { createQaBusState, startQaBusServer } from "../../qa-lab/api.js";
import { qaChannelPlugin } from "../api.js";
import { setQaChannelRuntime } from "../api.js";

function createMockQaRuntime(): PluginRuntime {
  const sessionUpdatedAt = new Map<string, number>();
  return {
    channel: {
      reply: {
        async dispatchReplyWithBufferedBlockDispatcher({
          ctx,
          dispatcherOptions,
        }: {
          ctx: { BodyForAgent?: string; Body?: string };
          dispatcherOptions: { deliver: (payload: { text: string }) => Promise<void> };
        }) {
          await dispatcherOptions.deliver({
            text: `qa-echo: ${String(ctx.BodyForAgent ?? ctx.Body ?? "")}`,
          });
        },
        finalizeInboundContext(ctx: Record<string, unknown>) {
          return ctx as typeof ctx & { CommandAuthorized: boolean };
        },
        formatAgentEnvelope({ body }: { body: string }) {
          return body;
        },
        resolveEnvelopeFormatOptions() {
          return {};
        },
      },
      routing: {
        resolveAgentRoute({
          accountId,
          peer,
        }: {
          accountId?: string | null;
          peer?: { kind?: string; id?: string } | null;
        }) {
          return {
            accountId: accountId ?? "default",
            agentId: "qa-agent",
            channel: "qa-channel",
            lastRoutePolicy: "session",
            mainSessionKey: "qa-agent:main",
            matchedBy: "default",
            sessionKey: `qa-agent:${peer?.kind ?? "direct"}:${peer?.id ?? "default"}`,
          };
        },
      },
      session: {
        readSessionUpdatedAt({ sessionKey }: { sessionKey: string }) {
          return sessionUpdatedAt.get(sessionKey);
        },
        recordInboundSession({ sessionKey }: { sessionKey: string }) {
          sessionUpdatedAt.set(sessionKey, Date.now());
        },
        resolveStorePath(_store: string | undefined, { agentId }: { agentId: string }) {
          return agentId;
        },
      },
    },
  } as unknown as PluginRuntime;
}

describe("qa-channel plugin", () => {
  it("roundtrips inbound DM traffic through the qa bus", { timeout: 20_000 }, async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    setQaChannelRuntime(createMockQaRuntime());

    const cfg = {
      channels: {
        "qa-channel": {
          allowFrom: ["*"],
          baseUrl: bus.baseUrl,
          botDisplayName: "OpenClaw QA",
          botUserId: "openclaw",
        },
      },
    };
    const account = qaChannelPlugin.config.resolveAccount(cfg, "default");
    const abort = new AbortController();
    const startAccount = qaChannelPlugin.gateway?.startAccount;
    expect(startAccount).toBeDefined();
    const task = startAccount!(
      createStartAccountContext({
        abortSignal: abort.signal,
        account,
        cfg,
      }),
    );

    try {
      state.addInboundMessage({
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        senderName: "Alice",
        text: "hello",
      });

      const outbound = await state.waitFor({
        direction: "outbound",
        kind: "message-text",
        textIncludes: "qa-echo: hello",
        timeoutMs: 15_000,
      });
      expect("text" in outbound && outbound.text).toContain("qa-echo: hello");
    } finally {
      abort.abort();
      await task;
      await bus.stop();
    }
  });

  it("exposes thread and message actions against the qa bus", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });

    try {
      const cfg = {
        channels: {
          "qa-channel": {
            baseUrl: bus.baseUrl,
            botDisplayName: "OpenClaw QA",
            botUserId: "openclaw",
          },
        },
      };

      const handleAction = qaChannelPlugin.actions?.handleAction;
      expect(handleAction).toBeDefined();

      const threadResult = await handleAction!({
        accountId: "default",
        action: "thread-create",
        cfg,
        channel: "qa-channel",
        params: {
          channelId: "qa-room",
          title: "QA thread",
        },
      });
      const threadPayload = extractToolPayload(threadResult) as {
        thread: { id: string };
        target: string;
      };
      expect(threadPayload.thread.id).toBeTruthy();
      expect(threadPayload.target).toContain(threadPayload.thread.id);

      const outbound = state.addOutboundMessage({
        text: "message",
        threadId: threadPayload.thread.id,
        to: threadPayload.target,
      });

      await handleAction!({
        accountId: "default",
        action: "react",
        cfg,
        channel: "qa-channel",
        params: {
          emoji: "white_check_mark",
          messageId: outbound.id,
        },
      });

      await handleAction!({
        accountId: "default",
        action: "edit",
        cfg,
        channel: "qa-channel",
        params: {
          messageId: outbound.id,
          text: "message (edited)",
        },
      });

      const readResult = await handleAction!({
        accountId: "default",
        action: "read",
        cfg,
        channel: "qa-channel",
        params: {
          messageId: outbound.id,
        },
      });
      const readPayload = extractToolPayload(readResult) as { message: { text: string } };
      expect(readPayload.message.text).toContain("(edited)");

      const searchResult = await handleAction!({
        accountId: "default",
        action: "search",
        cfg,
        channel: "qa-channel",
        params: {
          channelId: "qa-room",
          query: "edited",
          threadId: threadPayload.thread.id,
        },
      });
      const searchPayload = extractToolPayload(searchResult) as {
        messages: { id: string }[];
      };
      expect(searchPayload.messages.some((message) => message.id === outbound.id)).toBe(true);

      await handleAction!({
        accountId: "default",
        action: "delete",
        cfg,
        channel: "qa-channel",
        params: {
          messageId: outbound.id,
        },
      });
      expect(state.readMessage({ messageId: outbound.id }).deleted).toBe(true);
    } finally {
      await bus.stop();
    }
  });
});
