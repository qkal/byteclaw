import * as fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, test, vi } from "vitest";
import { defaultVoiceWakeTriggers } from "../infra/voicewake.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import {
  DEFAULT_DANGEROUS_NODE_COMMANDS,
  resolveNodeCommandAllowlist,
} from "./node-command-policy.js";
import type { RequestFrame } from "./protocol/index.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createChatRunRegistry } from "./server-chat.js";
import { handleNodeInvokeResult } from "./server-methods/nodes.handlers.invoke-result.js";
import type { GatewayClient as GatewayMethodClient } from "./server-methods/types.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";
import { formatError, normalizeVoiceWakeTriggers } from "./server-utils.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function makeControlUiResponse() {
  const res = {
    end: vi.fn(),
    setHeader: vi.fn(),
    statusCode: 200,
  } as unknown as ServerResponse;
  return { res };
}

const wsMockState = vi.hoisted(() => ({
  last: null as { url: unknown; opts: unknown } | null,
}));

vi.mock("ws", () => ({
  WebSocket: class MockWebSocket {
    on = vi.fn();
    close = vi.fn();
    send = vi.fn();

    constructor(url: unknown, opts: unknown) {
      wsMockState.last = { opts, url };
    }
  },
}));

let GatewayClient: typeof import("./client.js").GatewayClient;

async function loadFreshGatewayClientModuleForTest() {
  vi.resetModules();
  vi.doMock("ws", () => ({
    WebSocket: class MockWebSocket {
      on = vi.fn();
      close = vi.fn();
      send = vi.fn();

      constructor(url: unknown, opts: unknown) {
        wsMockState.last = { opts, url };
      }
    },
  }));
  ({ GatewayClient } = await import("./client.js"));
}

beforeEach(async () => {
  wsMockState.last = null;
  await loadFreshGatewayClientModuleForTest();
});

describe("GatewayClient", () => {
  async function withControlUiRoot(
    params: { faviconSvg?: string; indexHtml?: string },
    run: (tmp: string) => Promise<void>,
  ) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), params.indexHtml ?? "<html></html>\n");
      if (typeof params.faviconSvg === "string") {
        await fs.writeFile(path.join(tmp, "favicon.svg"), params.faviconSvg);
      }
      await run(tmp);
    } finally {
      await fs.rm(tmp, { force: true, recursive: true });
    }
  }

  test("uses a large maxPayload for node snapshots", () => {
    const client = new GatewayClient({ url: "ws://127.0.0.1:1" });
    client.start();
    const last = wsMockState.last as { url: unknown; opts: unknown } | null;

    expect(last?.url).toBe("ws://127.0.0.1:1");
    expect(last?.opts).toEqual(expect.objectContaining({ maxPayload: 25 * 1024 * 1024 }));
  });

  it("returns 404 for missing static asset paths instead of SPA fallback", async () => {
    await withControlUiRoot({ faviconSvg: "<svg/>" }, async (tmp) => {
      const { res } = makeControlUiResponse();
      const handled = handleControlUiHttpRequest(
        { method: "GET", url: "/webchat/favicon.svg" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    });
  });

  it("returns 404 for missing static assets with query strings", async () => {
    await withControlUiRoot({}, async (tmp) => {
      const { res } = makeControlUiResponse();
      const handled = handleControlUiHttpRequest(
        { method: "GET", url: "/webchat/favicon.svg?v=1" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    });
  });

  it("still serves SPA fallback for extensionless paths", async () => {
    await withControlUiRoot({}, async (tmp) => {
      const { res } = makeControlUiResponse();
      const handled = handleControlUiHttpRequest(
        { method: "GET", url: "/webchat/chat" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    });
  });

  it("HEAD returns 404 for missing static assets consistent with GET", async () => {
    await withControlUiRoot({}, async (tmp) => {
      const { res } = makeControlUiResponse();
      const handled = handleControlUiHttpRequest(
        { method: "HEAD", url: "/webchat/favicon.svg" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    });
  });

  it("serves SPA fallback for dotted path segments that are not static assets", async () => {
    await withControlUiRoot({}, async (tmp) => {
      for (const route of ["/webchat/user/jane.doe", "/webchat/v2.0", "/settings/v1.2"]) {
        const { res } = makeControlUiResponse();
        const handled = handleControlUiHttpRequest(
          { method: "GET", url: route } as IncomingMessage,
          res,
          { root: { kind: "resolved", path: tmp } },
        );
        expect(handled).toBe(true);
        expect(res.statusCode, `expected 200 for ${route}`).toBe(200);
      }
    });
  });

  it("serves SPA fallback for .html paths that do not exist on disk", async () => {
    await withControlUiRoot({}, async (tmp) => {
      const { res } = makeControlUiResponse();
      const handled = handleControlUiHttpRequest(
        { method: "GET", url: "/webchat/foo.html" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    });
  });
});

interface TestSocket {
  bufferedAmount: number;
  send: (payload: string) => void;
  close: (code: number, reason: string) => void;
}

describe("gateway broadcaster", () => {
  it("filters approval and pairing events by scope", () => {
    const approvalsSocket: TestSocket = {
      bufferedAmount: 0,
      close: vi.fn(),
      send: vi.fn(),
    };
    const pairingSocket: TestSocket = {
      bufferedAmount: 0,
      close: vi.fn(),
      send: vi.fn(),
    };
    const readSocket: TestSocket = {
      bufferedAmount: 0,
      close: vi.fn(),
      send: vi.fn(),
    };

    const clients = new Set<GatewayWsClient>([
      {
        connId: "c-approvals",
        connect: { role: "operator", scopes: ["operator.approvals"] } as GatewayWsClient["connect"],
        socket: approvalsSocket as unknown as GatewayWsClient["socket"],
        usesSharedGatewayAuth: false,
      },
      {
        connId: "c-pairing",
        connect: { role: "operator", scopes: ["operator.pairing"] } as GatewayWsClient["connect"],
        socket: pairingSocket as unknown as GatewayWsClient["socket"],
        usesSharedGatewayAuth: false,
      },
      {
        connId: "c-read",
        connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
        socket: readSocket as unknown as GatewayWsClient["socket"],
        usesSharedGatewayAuth: false,
      },
    ]);

    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    broadcast("exec.approval.requested", { id: "1" });
    broadcast("device.pair.requested", { requestId: "r1" });

    expect(approvalsSocket.send).toHaveBeenCalledTimes(1);
    expect(pairingSocket.send).toHaveBeenCalledTimes(1);
    expect(readSocket.send).toHaveBeenCalledTimes(0);

    broadcastToConnIds("tick", { ts: 1 }, new Set(["c-read"]));
    expect(readSocket.send).toHaveBeenCalledTimes(1);
    expect(approvalsSocket.send).toHaveBeenCalledTimes(1);
    expect(pairingSocket.send).toHaveBeenCalledTimes(1);
  });
});

describe("chat run registry", () => {
  test("queues and removes runs per session", () => {
    const registry = createChatRunRegistry();

    registry.add("s1", { clientRunId: "c1", sessionKey: "main" });
    registry.add("s1", { clientRunId: "c2", sessionKey: "main" });

    expect(registry.peek("s1")?.clientRunId).toBe("c1");
    expect(registry.shift("s1")?.clientRunId).toBe("c1");
    expect(registry.peek("s1")?.clientRunId).toBe("c2");

    expect(registry.remove("s1", "c2")?.clientRunId).toBe("c2");
    expect(registry.peek("s1")).toBeUndefined();
  });
});

describe("late-arriving invoke results", () => {
  test("returns success for unknown invoke ids for both success and error payloads", async () => {
    const nodeId = "node-123";
    const cases = [
      {
        id: "unknown-invoke-id-12345",
        ok: true,
        payloadJSON: JSON.stringify({ result: "late" }),
      },
      {
        error: { code: "FAILED", message: "test error" },
        id: "another-unknown-invoke-id",
        ok: false,
      },
    ] as const;

    for (const params of cases) {
      const respond = vi.fn<RespondFn>();
      const context = {
        logGateway: { debug: vi.fn() },
        nodeRegistry: { handleInvokeResult: () => false },
      } as unknown as GatewayRequestContext;
      const client = {
        connect: { device: { id: nodeId } },
      } as unknown as GatewayMethodClient;

      await handleNodeInvokeResult({
        client,
        context,
        isWebchatConnect: () => false,
        params: { ...params, nodeId } as unknown as Record<string, unknown>,
        req: { method: "node.invoke.result" } as unknown as RequestFrame,
        respond,
      });

      const [ok, rawPayload, error] = respond.mock.lastCall ?? [];
      const payload = rawPayload as { ok?: boolean; ignored?: boolean } | undefined;

      // Late-arriving results return success instead of error to reduce log noise.
      expect(ok).toBe(true);
      expect(error).toBeUndefined();
      expect(payload?.ok).toBe(true);
      expect(payload?.ignored).toBe(true);
    }
  });
});

describe("node subscription manager", () => {
  test("routes events to subscribed nodes", () => {
    const manager = createNodeSubscriptionManager();
    const sent: {
      nodeId: string;
      event: string;
      payloadJSON?: string | null;
    }[] = [];
    const sendEvent = (evt: { nodeId: string; event: string; payloadJSON?: string | null }) =>
      sent.push(evt);

    manager.subscribe("node-a", "main");
    manager.subscribe("node-b", "main");
    manager.sendToSession("main", "chat", { ok: true }, sendEvent);

    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.nodeId).toSorted()).toEqual(["node-a", "node-b"]);
    expect(sent[0].event).toBe("chat");
  });

  test("unsubscribeAll clears session mappings", () => {
    const manager = createNodeSubscriptionManager();
    const sent: string[] = [];
    const sendEvent = (evt: { nodeId: string; event: string }) =>
      sent.push(`${evt.nodeId}:${evt.event}`);

    manager.subscribe("node-a", "main");
    manager.subscribe("node-a", "secondary");
    manager.unsubscribeAll("node-a");
    manager.sendToSession("main", "tick", {}, sendEvent);
    manager.sendToSession("secondary", "tick", {}, sendEvent);

    expect(sent).toEqual([]);
  });
});

describe("resolveNodeCommandAllowlist", () => {
  it("includes iOS service commands by default", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        deviceFamily: "iPhone",
        platform: "ios 26.0",
      },
    );

    expect(allow.has("device.info")).toBe(true);
    expect(allow.has("device.status")).toBe(true);
    expect(allow.has("system.notify")).toBe(true);
    expect(allow.has("contacts.search")).toBe(true);
    expect(allow.has("calendar.events")).toBe(true);
    expect(allow.has("reminders.list")).toBe(true);
    expect(allow.has("photos.latest")).toBe(true);
    expect(allow.has("motion.activity")).toBe(true);

    for (const cmd of DEFAULT_DANGEROUS_NODE_COMMANDS) {
      expect(allow.has(cmd)).toBe(false);
    }
  });

  it("includes Android notifications and device diagnostics commands by default", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        deviceFamily: "Android",
        platform: "android 16",
      },
    );

    expect(allow.has("notifications.list")).toBe(true);
    expect(allow.has("notifications.actions")).toBe(true);
    expect(allow.has("device.permissions")).toBe(true);
    expect(allow.has("device.health")).toBe(true);
    expect(allow.has("callLog.search")).toBe(true);
    expect(allow.has("system.notify")).toBe(true);
    expect(allow.has("sms.search")).toBe(false);
  });

  it("treats sms.search as dangerous by default", () => {
    expect(DEFAULT_DANGEROUS_NODE_COMMANDS).toContain("sms.search");
  });

  it("can explicitly allow dangerous commands via allowCommands", () => {
    const allow = resolveNodeCommandAllowlist(
      {
        gateway: {
          nodes: {
            allowCommands: ["camera.snap", "screen.record"],
          },
        },
      },
      { deviceFamily: "iPhone", platform: "ios" },
    );
    expect(allow.has("camera.snap")).toBe(true);
    expect(allow.has("screen.record")).toBe(true);
    expect(allow.has("camera.clip")).toBe(false);
  });

  it("treats unknown/confusable metadata as fail-safe for system.run defaults", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        deviceFamily: "iPhοne",
        platform: "iPhοne",
      },
    );

    expect(allow.has("system.run")).toBe(false);
    expect(allow.has("system.which")).toBe(false);
    expect(allow.has("system.notify")).toBe(true);
  });

  it("normalizes dotted-I platform values to iOS classification", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        deviceFamily: "iPhone",
        platform: "İOS",
      },
    );

    expect(allow.has("system.run")).toBe(false);
    expect(allow.has("system.which")).toBe(false);
    expect(allow.has("device.info")).toBe(true);
  });
});

describe("normalizeVoiceWakeTriggers", () => {
  test("returns defaults when input is empty", () => {
    expect(normalizeVoiceWakeTriggers([])).toEqual(defaultVoiceWakeTriggers());
    expect(normalizeVoiceWakeTriggers(null)).toEqual(defaultVoiceWakeTriggers());
  });

  test("trims and limits entries", () => {
    const result = normalizeVoiceWakeTriggers(["  hello  ", "", "world"]);
    expect(result).toEqual(["hello", "world"]);
  });
});

describe("formatError", () => {
  test("prefers message for Error", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  test("handles status/code", () => {
    expect(formatError({ code: "EPIPE", status: 500 })).toBe("status=500 code=EPIPE");
    expect(formatError({ status: 404 })).toBe("status=404 code=unknown");
    expect(formatError({ code: "ENOENT" })).toBe("status=unknown code=ENOENT");
  });
});
