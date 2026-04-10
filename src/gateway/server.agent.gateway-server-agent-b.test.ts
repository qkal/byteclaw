import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { emitAgentEvent, registerAgentRunContext } from "../infra/agent-events.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import type { startServerWithClient } from "./test-helpers.js";
import {
  agentCommand,
  connectOk,
  connectWebchatClient,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startConnectedServerWithClient,
  testState,
  trackConnectChallengeNonce,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];
let port: number;

beforeAll(async () => {
  const started = await startConnectedServerWithClient();
  ({ server } = started);
  ({ ws } = started);
  ({ port } = started);
});

afterAll(async () => {
  ws.close();
  await server.close();
});

const createMSTeamsPlugin = (params?: { aliases?: string[] }): ChannelPlugin => ({
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
  id: "msteams",
  meta: {
    aliases: params?.aliases,
    blurb: "Teams SDK; enterprise support.",
    docsPath: "/channels/msteams",
    id: "msteams",
    label: "Microsoft Teams",
    selectionLabel: "Microsoft Teams (Bot Framework)",
  },
});

const createStubChannelPlugin = (params: {
  id: ChannelPlugin["id"];
  label: string;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
    id: params.id,
    label: params.label,
  }),
  outbound: {
    deliveryMode: "direct",
    sendMedia: async () => ({ channel: params.id, messageId: "msg-test" }),
    sendText: async () => ({ channel: params.id, messageId: "msg-test" }),
  },
});

const createConfiguredChannelPlugin = (params: {
  id: ChannelPlugin["id"];
  label: string;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    config: {
      isConfigured: async () => true,
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    id: params.id,
    label: params.label,
  }),
  outbound: {
    deliveryMode: "direct",
    sendMedia: async () => ({ channel: params.id, messageId: "msg-test" }),
    sendText: async () => ({ channel: params.id, messageId: "msg-test" }),
  },
});

const emptyRegistry = createRegistry([]);
const defaultRegistry = createRegistry([
  {
    plugin: createStubChannelPlugin({ id: "whatsapp", label: "WhatsApp" }),
    pluginId: "whatsapp",
    source: "test",
  },
]);

function expectChannels(call: Record<string, unknown>, channel: string) {
  expect(call.channel).toBe(channel);
  expect(call.messageChannel).toBe(channel);
}

function readAgentCommandCall(fromEnd = 1) {
  const { calls } = vi.mocked(agentCommand).mock;
  return (calls.at(-fromEnd)?.[0] ?? {}) as Record<string, unknown>;
}

function expectAgentRoutingCall(params: {
  channel: string;
  deliver: boolean;
  to?: string;
  fromEnd?: number;
}) {
  const call = readAgentCommandCall(params.fromEnd);
  expectChannels(call, params.channel);
  if ("to" in params) {
    expect(call.to).toBe(params.to);
  } else {
    expect(call.to).toBeUndefined();
  }
  expect(call.deliver).toBe(params.deliver);
  expect(call.bestEffortDeliver).toBe(true);
  expect(typeof call.sessionId).toBe("string");
}

async function writeMainSessionEntry(params: {
  sessionId: string;
  lastChannel?: string;
  lastTo?: string;
}) {
  await useTempSessionStorePath();
  await writeSessionStore({
    entries: {
      main: {
        lastChannel: params.lastChannel,
        lastTo: params.lastTo,
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    },
  });
}

function sendAgentWsRequest(
  socket: WebSocket,
  params: { reqId: string; message: string; idempotencyKey: string },
) {
  socket.send(
    JSON.stringify({
      id: params.reqId,
      method: "agent",
      params: { idempotencyKey: params.idempotencyKey, message: params.message },
      type: "req",
    }),
  );
}

async function sendAgentWsRequestAndWaitFinal(
  socket: WebSocket,
  params: { reqId: string; message: string; idempotencyKey: string; timeoutMs?: number },
) {
  const finalP = onceMessage(
    socket,
    (o) => o.type === "res" && o.id === params.reqId && o.payload?.status !== "accepted",
    params.timeoutMs,
  );
  sendAgentWsRequest(socket, params);
  return await finalP;
}

async function useTempSessionStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
  testState.sessionStorePath = path.join(dir, "sessions.json");
}

describe("gateway server agent", () => {
  beforeEach(() => {
    setRegistry(defaultRegistry);
  });

  afterEach(() => {
    setRegistry(emptyRegistry);
  });

  test("agent reuses the last plugin delivery route when channel=last", async () => {
    const registry = createRegistry([
      {
        plugin: createMSTeamsPlugin(),
        pluginId: "msteams",
        source: "test",
      },
    ]);
    setRegistry(registry);
    await writeMainSessionEntry({
      lastChannel: "msteams",
      lastTo: "conversation:teams-123",
      sessionId: "sess-teams",
    });
    const res = await rpcReq(ws, "agent", {
      channel: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-msteams",
      message: "hi",
      sessionKey: "main",
    });
    expect(res.ok).toBe(true);
    expectAgentRoutingCall({
      channel: "msteams",
      deliver: true,
      fromEnd: 1,
      to: "conversation:teams-123",
    });
  });

  test("agent accepts built-in channel alias (imsg)", async () => {
    const registry = createRegistry([
      {
        plugin: createMSTeamsPlugin({ aliases: ["teams"] }),
        pluginId: "msteams",
        source: "test",
      },
    ]);
    setRegistry(registry);
    await writeMainSessionEntry({
      lastChannel: "imessage",
      lastTo: "chat_id:123",
      sessionId: "sess-alias",
    });
    const resIMessage = await rpcReq(ws, "agent", {
      channel: "imsg",
      deliver: true,
      idempotencyKey: "idem-agent-imsg",
      message: "hi",
      sessionKey: "main",
    });
    expect(resIMessage.ok).toBe(true);

    expectAgentRoutingCall({ channel: "imessage", deliver: true, fromEnd: 1 });
  });

  test("agent accepts plugin channel alias (teams)", async () => {
    const registry = createRegistry([
      {
        plugin: createMSTeamsPlugin({ aliases: ["teams"] }),
        pluginId: "msteams",
        source: "test",
      },
    ]);
    setRegistry(registry);

    const resTeams = await rpcReq(ws, "agent", {
      channel: "teams",
      deliver: false,
      idempotencyKey: "idem-agent-teams",
      message: "hi",
      sessionKey: "main",
      to: "conversation:teams-abc",
    });
    expect(resTeams.ok).toBe(true);
    expectAgentRoutingCall({
      channel: "msteams",
      deliver: false,
      fromEnd: 1,
      to: "conversation:teams-abc",
    });
  });

  test("agent rejects unknown channel", async () => {
    const res = await rpcReq(ws, "agent", {
      channel: "sms",
      idempotencyKey: "idem-agent-bad-channel",
      message: "hi",
      sessionKey: "main",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_REQUEST");
  });

  test("agent errors when deliver=true and last channel is webchat", async () => {
    testState.allowFrom = ["+1555"];
    await writeMainSessionEntry({
      lastChannel: "webchat",
      lastTo: "+1555",
      sessionId: "sess-main-webchat",
    });
    const res = await rpcReq(ws, "agent", {
      bestEffortDeliver: false,
      channel: "last",
      deliver: true,
      idempotencyKey: "idem-agent-webchat",
      message: "hi",
      sessionKey: "main",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_REQUEST");
    expect(res.error?.message).toMatch(/Channel is required|runtime not initialized/);
    expect(vi.mocked(agentCommand)).not.toHaveBeenCalled();
  });

  test("agent downgrades to session-only delivery when best-effort is enabled and last channel is webchat", async () => {
    testState.allowFrom = ["+1555"];
    await writeMainSessionEntry({
      lastChannel: "webchat",
      lastTo: "+1555",
      sessionId: "sess-main-webchat-best-effort",
    });
    const res = await rpcReq(ws, "agent", {
      bestEffortDeliver: true,
      channel: "last",
      deliver: true,
      idempotencyKey: "idem-agent-webchat-best-effort",
      message: "hi",
      sessionKey: "main",
    });
    expect(res.ok).toBe(true);
    expectAgentRoutingCall({ channel: "webchat", deliver: false });
  });

  test("agent downgrades to session-only when multiple channels are configured but no external target resolves", async () => {
    const registry = createRegistry([
      {
        plugin: createConfiguredChannelPlugin({ id: "discord", label: "Discord" }),
        pluginId: "discord",
        source: "test",
      },
      {
        plugin: createConfiguredChannelPlugin({ id: "telegram", label: "Telegram" }),
        pluginId: "telegram",
        source: "test",
      },
    ]);
    setRegistry(registry);
    await writeMainSessionEntry({
      sessionId: "sess-main-multi-configured-best-effort",
    });
    const res = await rpcReq(ws, "agent", {
      bestEffortDeliver: true,
      deliver: true,
      idempotencyKey: "idem-agent-multi-configured-best-effort",
      message: "hi",
      sessionKey: "main",
    });
    expect(res.ok).toBe(true);
    expectAgentRoutingCall({ channel: "webchat", deliver: false });
  });

  test("agent uses webchat for internal runs when last provider is webchat", async () => {
    await writeMainSessionEntry({
      lastChannel: "webchat",
      lastTo: "+1555",
      sessionId: "sess-main-webchat-internal",
    });
    const res = await rpcReq(ws, "agent", {
      channel: "last",
      deliver: false,
      idempotencyKey: "idem-agent-webchat-internal",
      message: "hi",
      sessionKey: "main",
    });
    expect(res.ok).toBe(true);

    expectAgentRoutingCall({ channel: "webchat", deliver: false });
  });

  test(
    "agent routes bare /new through session reset before running greeting prompt",
    {
      timeout: 45_000,
    },
    async () => {
      await writeMainSessionEntry({ sessionId: "sess-main-before-reset" });
      const spy = vi.mocked(agentCommand);
      const { calls } = spy.mock;
      const callsBefore = calls.length;
      const res = await rpcReq(
        ws,
        "agent",
        {
          idempotencyKey: "idem-agent-new",
          message: "/new",
          sessionKey: "main",
        },
        30_000,
      );
      expect(res.ok).toBe(true);

      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(callsBefore));
      const call = (calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
      expect(call.message).toBeTypeOf("string");
      expect(call.message).toContain("Run your Session Startup sequence");
      expect(call.message).toContain("Current time:");
      expect(typeof call.sessionId).toBe("string");
      expect(call.sessionId).not.toBe("sess-main-before-reset");
    },
  );

  test("write-scoped callers cannot reset conversations via agent", async () => {
    await withGatewayServer(async ({ port }) => {
      await useTempSessionStorePath();
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("missing session store path");
      }

      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main-before-write-reset",
            updatedAt: Date.now(),
          },
        },
      });

      const writeWs = new WebSocket(`ws://127.0.0.1:${port}`);
      trackConnectChallengeNonce(writeWs);
      await new Promise<void>((resolve) => writeWs.once("open", resolve));
      await connectOk(writeWs, { scopes: ["operator.write"] });

      const directReset = await rpcReq(writeWs, "sessions.reset", { key: "main" });
      expect(directReset.ok).toBe(false);
      expect(directReset.error?.message).toContain("missing scope: operator.admin");

      vi.mocked(agentCommand).mockClear();
      const viaAgent = await rpcReq(writeWs, "agent", {
        idempotencyKey: "idem-agent-write-reset",
        message: "/reset",
        sessionKey: "main",
      });
      expect(viaAgent.ok).toBe(false);
      expect(viaAgent.error?.message).toContain("missing scope: operator.admin");

      const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
        string,
        { sessionId?: string }
      >;
      expect(store["agent:main:main"]?.sessionId).toBeDefined();
      expect(store["agent:main:main"]?.sessionId).toBe("sess-main-before-write-reset");
      expect(vi.mocked(agentCommand)).not.toHaveBeenCalled();

      writeWs.close();
    });
  });

  test("agent ack response then final response", { timeout: 8000 }, async () => {
    const ackP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "ag1" && o.payload?.status === "accepted",
    );
    const finalP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "ag1" && o.payload?.status !== "accepted",
    );
    sendAgentWsRequest(ws, {
      idempotencyKey: "idem-ag",
      message: "hi",
      reqId: "ag1",
    });

    const ack = await ackP;
    const final = await finalP;
    const ackPayload = ack.payload;
    const finalPayload = final.payload;
    if (!ackPayload || !finalPayload) {
      throw new Error("missing websocket payload");
    }
    expect(ackPayload.runId).toBeDefined();
    expect(finalPayload.runId).toBe(ackPayload.runId);
    expect(finalPayload.status).toBe("ok");
  });

  test("agent dedupes by idempotencyKey after completion", async () => {
    const firstFinal = await sendAgentWsRequestAndWaitFinal(ws, {
      idempotencyKey: "same-agent",
      message: "hi",
      reqId: "ag1",
    });

    const secondP = onceMessage(ws, (o) => o.type === "res" && o.id === "ag2");
    sendAgentWsRequest(ws, {
      idempotencyKey: "same-agent",
      message: "hi again",
      reqId: "ag2",
    });
    const second = await secondP;
    expect(second.payload).toEqual(firstFinal.payload);
  });

  test("agent dedupe survives reconnect", { timeout: 20_000 }, async () => {
    await withGatewayServer(async ({ port }) => {
      const dial = async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        trackConnectChallengeNonce(ws);
        await new Promise<void>((resolve) => ws.once("open", resolve));
        await connectOk(ws);
        return ws;
      };

      const idem = "reconnect-agent";
      const ws1 = await dial();
      const final1 = await sendAgentWsRequestAndWaitFinal(ws1, {
        idempotencyKey: idem,
        message: "hi",
        reqId: "ag1",
        timeoutMs: 6000,
      });
      ws1.close();

      const ws2 = await dial();
      const res = await sendAgentWsRequestAndWaitFinal(ws2, {
        idempotencyKey: idem,
        message: "hi again",
        reqId: "ag2",
        timeoutMs: 6000,
      });
      expect(res.payload).toEqual(final1.payload);
      ws2.close();
    });
  });

  test("agent events stream to webchat clients when run context is registered", async () => {
    await writeMainSessionEntry({ sessionId: "sess-main" });

    const webchatWs = await connectWebchatClient({ port });

    registerAgentRunContext("run-auto-1", { sessionKey: "main" });

    const finalChatP = onceMessage(
      webchatWs,
      (o) => {
        if (o.type !== "event" || o.event !== "chat") {
          return false;
        }
        const payload = o.payload as { state?: unknown; runId?: unknown } | undefined;
        return payload?.state === "final" && payload.runId === "run-auto-1";
      },
      8000,
    );

    emitAgentEvent({
      data: { text: "hi from agent" },
      runId: "run-auto-1",
      stream: "assistant",
    });
    emitAgentEvent({
      data: { phase: "end" },
      runId: "run-auto-1",
      stream: "lifecycle",
    });

    const evt = await finalChatP;
    const payload = evt.payload && typeof evt.payload === "object" ? evt.payload : {};
    expect(payload.sessionKey).toBe("main");
    expect(payload.runId).toBe("run-auto-1");

    webchatWs.close();
  });
});
