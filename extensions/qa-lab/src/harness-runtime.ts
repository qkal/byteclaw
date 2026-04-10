import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

interface SessionRecord {
  sessionKey: string;
  body: string;
}

export function createQaRunnerRuntime(): PluginRuntime {
  const sessions = new Map<string, SessionRecord>();
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
          return sessions.has(sessionKey) ? Date.now() : undefined;
        },
        recordInboundSession({
          sessionKey,
          ctx,
        }: {
          sessionKey: string;
          ctx: { BodyForAgent?: string; Body?: string };
        }) {
          sessions.set(sessionKey, {
            body: String(ctx.BodyForAgent ?? ctx.Body ?? ""),
            sessionKey,
          });
        },
        resolveStorePath(_store: string | undefined, { agentId }: { agentId: string }) {
          return agentId;
        },
      },
    },
  } as unknown as PluginRuntime;
}
