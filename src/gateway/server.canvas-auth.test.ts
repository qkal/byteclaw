import type { Socket } from "node:net";
import { describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH } from "../canvas-host/a2ui.js";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { CANVAS_CAPABILITY_PATH_PREFIX } from "./canvas-capability.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { withTempConfig } from "./test-temp-config.js";

const WS_REJECT_TIMEOUT_MS = 2000;
const WS_CONNECT_TIMEOUT_MS = 2000;
async function listen(
  server: ReturnType<typeof createGatewayHttpServer>,
  host = "127.0.0.1",
): Promise<{
  host: string;
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
    host,
    port,
  };
}

async function expectWsRejected(
  url: string,
  headers: Record<string, string>,
  expectedStatus = 401,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => reject(new Error("timeout")), WS_REJECT_TIMEOUT_MS);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error("expected ws to reject"));
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      expect(res.statusCode).toBe(expectedStatus);
      resolve();
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function expectWsConnected(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("timeout")), WS_CONNECT_TIMEOUT_MS);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.terminate();
      resolve();
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`unexpected response ${res.statusCode}`));
    });
    ws.once("error", reject);
  });
}

function makeWsClient(params: {
  connId: string;
  clientIp: string;
  role: "node" | "operator";
  mode: "node" | "backend";
  canvasCapability?: string;
  canvasCapabilityExpiresAtMs?: number;
}): GatewayWsClient {
  return {
    canvasCapability: params.canvasCapability,
    canvasCapabilityExpiresAtMs: params.canvasCapabilityExpiresAtMs,
    clientIp: params.clientIp,
    connId: params.connId,
    connect: {
      client: {
        mode: params.mode,
      },
      role: params.role,
    } as GatewayWsClient["connect"],
    socket: {} as unknown as WebSocket,
    usesSharedGatewayAuth: false,
  };
}

function scopedCanvasPath(capability: string, path: string): string {
  return `${CANVAS_CAPABILITY_PATH_PREFIX}/${encodeURIComponent(capability)}${path}`;
}

const allowCanvasHostHttp: CanvasHostHandler["handleHttpRequest"] = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== CANVAS_HOST_PATH && !url.pathname.startsWith(`${CANVAS_HOST_PATH}/`)) {
    return false;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("ok");
  return true;
};
async function withCanvasGatewayHarness(params: {
  resolvedAuth: ResolvedGatewayAuth;
  listenHost?: string;
  rateLimiter?: ReturnType<typeof createAuthRateLimiter>;
  handleHttpRequest: CanvasHostHandler["handleHttpRequest"];
  run: (ctx: {
    listener: Awaited<ReturnType<typeof listen>>;
    clients: Set<GatewayWsClient>;
  }) => Promise<void>;
}) {
  const clients = new Set<GatewayWsClient>();
  const canvasWss = new WebSocketServer({ noServer: true });
  const canvasHost: CanvasHostHandler = {
    basePath: "/canvas",
    close: async () => {},
    handleHttpRequest: params.handleHttpRequest,
    handleUpgrade: (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== CANVAS_WS_PATH) {
        return false;
      }
      canvasWss.handleUpgrade(req, socket, head, (ws) => ws.close());
      return true;
    },
    rootDir: "test",
  };

  const httpServer = createGatewayHttpServer({
    canvasHost,
    clients,
    controlUiBasePath: "/__control__",
    controlUiEnabled: false,
    handleHooksRequest: async () => false,
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    rateLimiter: params.rateLimiter,
    resolvedAuth: params.resolvedAuth,
  });

  const wss = new WebSocketServer({ noServer: true });
  attachGatewayUpgradeHandler({
    canvasHost,
    clients,
    httpServer,
    preauthConnectionBudget: createPreauthConnectionBudget(8),
    rateLimiter: params.rateLimiter,
    resolvedAuth: params.resolvedAuth,
    wss,
  });

  const listener = await listen(httpServer, params.listenHost);
  try {
    await params.run({ clients, listener });
  } finally {
    for (const ws of canvasWss.clients) {
      ws.terminate();
    }
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => canvasWss.close(() => resolve()));
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await listener.close();
    params.rateLimiter?.dispose();
  }
}

describe("gateway canvas host auth", () => {
  const tokenResolvedAuth: ResolvedGatewayAuth = {
    allowTailscale: false,
    mode: "token",
    password: undefined,
    token: "test-token",
  };

  const withLoopbackTrustedProxy = async (run: () => Promise<void>, prefix?: string) => {
    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: ["127.0.0.1"],
        },
      },
      ...(prefix ? { prefix } : {}),
      run,
    });
  };

  test("authorizes canvas HTTP/WS via node-scoped capability and rejects misuse", async () => {
    await withLoopbackTrustedProxy(async () => {
      await withCanvasGatewayHarness({
        handleHttpRequest: allowCanvasHostHttp,
        resolvedAuth: tokenResolvedAuth,
        run: async ({ listener, clients }) => {
          const host = "127.0.0.1";
          const operatorOnlyCapability = "operator-only";
          const expiredNodeCapability = "expired-node";
          const activeNodeCapability = "active-node";
          const activeCanvasPath = scopedCanvasPath(activeNodeCapability, `${CANVAS_HOST_PATH}/`);
          const activeWsPath = scopedCanvasPath(activeNodeCapability, CANVAS_WS_PATH);

          const unauthCanvas = await fetch(`http://${host}:${listener.port}${CANVAS_HOST_PATH}/`);
          expect(unauthCanvas.status).toBe(401);

          const malformedScoped = await fetch(
            `http://${host}:${listener.port}${CANVAS_CAPABILITY_PATH_PREFIX}/broken`,
          );
          expect(malformedScoped.status).toBe(401);

          clients.add(
            makeWsClient({
              canvasCapability: operatorOnlyCapability,
              canvasCapabilityExpiresAtMs: Date.now() + 60_000,
              clientIp: "192.168.1.10",
              connId: "c-operator",
              mode: "backend",
              role: "operator",
            }),
          );

          const operatorCapabilityBlocked = await fetch(
            `http://${host}:${listener.port}${scopedCanvasPath(operatorOnlyCapability, `${CANVAS_HOST_PATH}/`)}`,
          );
          expect(operatorCapabilityBlocked.status).toBe(401);

          clients.add(
            makeWsClient({
              canvasCapability: expiredNodeCapability,
              canvasCapabilityExpiresAtMs: Date.now() - 1,
              clientIp: "192.168.1.20",
              connId: "c-expired-node",
              mode: "node",
              role: "node",
            }),
          );

          const expiredCapabilityBlocked = await fetch(
            `http://${host}:${listener.port}${scopedCanvasPath(expiredNodeCapability, `${CANVAS_HOST_PATH}/`)}`,
          );
          expect(expiredCapabilityBlocked.status).toBe(401);

          const activeNodeClient = makeWsClient({
            canvasCapability: activeNodeCapability,
            canvasCapabilityExpiresAtMs: Date.now() + 60_000,
            clientIp: "192.168.1.30",
            connId: "c-active-node",
            mode: "node",
            role: "node",
          });
          clients.add(activeNodeClient);

          const scopedCanvas = await fetch(`http://${host}:${listener.port}${activeCanvasPath}`);
          expect(scopedCanvas.status).toBe(200);
          expect(await scopedCanvas.text()).toBe("ok");

          const scopedA2ui = await fetch(
            `http://${host}:${listener.port}${scopedCanvasPath(activeNodeCapability, `${A2UI_PATH}/`)}`,
          );
          expect([200, 503]).toContain(scopedA2ui.status);

          await expectWsConnected(`ws://${host}:${listener.port}${activeWsPath}`);

          clients.delete(activeNodeClient);

          const disconnectedNodeBlocked = await fetch(
            `http://${host}:${listener.port}${activeCanvasPath}`,
          );
          expect(disconnectedNodeBlocked.status).toBe(401);
          await expectWsRejected(`ws://${host}:${listener.port}${activeWsPath}`, {});
        },
      });
    }, "openclaw-canvas-auth-test-");
  }, 60_000);

  test("denies canvas auth when trusted proxy omits forwarded client headers", async () => {
    await withLoopbackTrustedProxy(async () => {
      await withCanvasGatewayHarness({
        handleHttpRequest: allowCanvasHostHttp,
        resolvedAuth: tokenResolvedAuth,
        run: async ({ listener, clients }) => {
          clients.add(
            makeWsClient({
              canvasCapability: "unused",
              canvasCapabilityExpiresAtMs: Date.now() + 60_000,
              clientIp: "127.0.0.1",
              connId: "c-loopback-node",
              mode: "node",
              role: "node",
            }),
          );

          const res = await fetch(`http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`);
          expect(res.status).toBe(401);

          await expectWsRejected(`ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`, {});
        },
      });
    });
  }, 60_000);

  test("denies canvas HTTP/WS on loopback without bearer or capability by default", async () => {
    await withCanvasGatewayHarness({
      handleHttpRequest: allowCanvasHostHttp,
      resolvedAuth: tokenResolvedAuth,
      run: async ({ listener }) => {
        const res = await fetch(`http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`);
        expect(res.status).toBe(401);

        const a2ui = await fetch(`http://127.0.0.1:${listener.port}${A2UI_PATH}/`);
        expect(a2ui.status).toBe(401);

        await expectWsRejected(`ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`, {});
      },
    });
  }, 60_000);

  test("accepts capability-scoped paths over IPv6 loopback", async () => {
    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: ["::1"],
        },
      },
      run: async () => {
        try {
          await withCanvasGatewayHarness({
            handleHttpRequest: allowCanvasHostHttp,
            listenHost: "::1",
            resolvedAuth: tokenResolvedAuth,
            run: async ({ listener, clients }) => {
              const capability = "ipv6-node";
              clients.add(
                makeWsClient({
                  canvasCapability: capability,
                  canvasCapabilityExpiresAtMs: Date.now() + 60_000,
                  clientIp: "fd12:3456:789a::2",
                  connId: "c-ipv6-node",
                  mode: "node",
                  role: "node",
                }),
              );

              const canvasPath = scopedCanvasPath(capability, `${CANVAS_HOST_PATH}/`);
              const wsPath = scopedCanvasPath(capability, CANVAS_WS_PATH);
              const scopedCanvas = await fetch(`http://[::1]:${listener.port}${canvasPath}`);
              expect(scopedCanvas.status).toBe(200);

              await expectWsConnected(`ws://[::1]:${listener.port}${wsPath}`);
            },
          });
        } catch (error) {
          const message = String(error);
          if (message.includes("EAFNOSUPPORT") || message.includes("EADDRNOTAVAIL")) {
            return;
          }
          throw error;
        }
      },
    });
  }, 60_000);

  test("returns 429 for repeated failed canvas auth attempts (HTTP + WS upgrade)", async () => {
    await withLoopbackTrustedProxy(async () => {
      const rateLimiter = createAuthRateLimiter({
        exemptLoopback: false,
        lockoutMs: 60_000,
        maxAttempts: 1,
        windowMs: 60_000,
      });
      await withCanvasGatewayHarness({
        handleHttpRequest: async () => false,
        rateLimiter,
        resolvedAuth: tokenResolvedAuth,
        run: async ({ listener }) => {
          const headers = {
            authorization: "Bearer wrong",
            "x-forwarded-for": "203.0.113.99",
          };
          const first = await fetch(`http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`, {
            headers,
          });
          expect(first.status).toBe(401);

          const second = await fetch(`http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`, {
            headers,
          });
          expect(second.status).toBe(429);
          expect(second.headers.get("retry-after")).toBeTruthy();

          await expectWsRejected(`ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`, headers, 429);
        },
      });
    });
  }, 60_000);

  test("rejects spoofed loopback forwarding headers from trusted proxies", async () => {
    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: ["127.0.0.1"],
        },
      },
      run: async () => {
        const rateLimiter = createAuthRateLimiter({
          exemptLoopback: true,
          lockoutMs: 60_000,
          maxAttempts: 1,
          windowMs: 60_000,
        });
        await withCanvasGatewayHarness({
          handleHttpRequest: async () => false,
          listenHost: "0.0.0.0",
          rateLimiter,
          resolvedAuth: tokenResolvedAuth,
          run: async ({ listener }) => {
            const headers = {
              authorization: "Bearer wrong",
              host: "localhost",
              "x-forwarded-for": "127.0.0.1, 203.0.113.24",
            };
            const first = await fetch(`http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`, {
              headers,
            });
            expect(first.status).toBe(401);

            const second = await fetch(`http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`, {
              headers,
            });
            expect(second.status).toBe(429);
          },
        });
      },
    });
  }, 60_000);
});
