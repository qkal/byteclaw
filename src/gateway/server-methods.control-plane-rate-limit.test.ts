import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing as controlPlaneRateLimitTesting,
  resolveControlPlaneRateLimitKey,
} from "./control-plane-rate-limit.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const noWebchat = () => false;

describe("gateway control-plane write rate limit", () => {
  beforeEach(() => {
    controlPlaneRateLimitTesting.resetControlPlaneRateLimitState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-19T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    controlPlaneRateLimitTesting.resetControlPlaneRateLimitState();
  });

  function buildContext(logWarn = vi.fn()) {
    return {
      logGateway: {
        warn: logWarn,
      },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
  }

  function buildConnect(): NonNullable<
    Parameters<typeof handleGatewayRequest>[0]["client"]
  >["connect"] {
    return {
      client: {
        id: "openclaw-control-ui",
        mode: "ui",
        platform: "darwin",
        version: "1.0.0",
      },
      maxProtocol: 1,
      minProtocol: 1,
      role: "operator",
      scopes: ["operator.admin"],
    };
  }

  function buildClient() {
    return {
      clientIp: "10.0.0.5",
      connId: "conn-1",
      connect: buildConnect(),
    } as Parameters<typeof handleGatewayRequest>[0]["client"];
  }

  async function runRequest(params: {
    method: string;
    context: Parameters<typeof handleGatewayRequest>[0]["context"];
    client: Parameters<typeof handleGatewayRequest>[0]["client"];
    handler: GatewayRequestHandler;
  }) {
    const respond = vi.fn();
    await handleGatewayRequest({
      client: params.client,
      context: params.context,
      extraHandlers: {
        [params.method]: params.handler,
      },
      isWebchatConnect: noWebchat,
      req: {
        id: crypto.randomUUID(),
        method: params.method,
        type: "req",
      },
      respond,
    });
    return respond;
  }

  it("allows 3 control-plane writes and blocks the 4th in the same minute", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, undefined, undefined);
    };
    const logWarn = vi.fn();
    const context = buildContext(logWarn);
    const client = buildClient();

    await runRequest({ client, context, handler, method: "config.patch" });
    await runRequest({ client, context, handler, method: "config.patch" });
    await runRequest({ client, context, handler, method: "config.patch" });
    const blocked = await runRequest({ client, context, handler, method: "config.patch" });

    expect(handlerCalls).toHaveBeenCalledTimes(3);
    expect(blocked).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
      }),
    );
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("resets the control-plane write budget after 60 seconds", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, undefined, undefined);
    };
    const context = buildContext();
    const client = buildClient();

    await runRequest({ client, context, handler, method: "update.run" });
    await runRequest({ client, context, handler, method: "update.run" });
    await runRequest({ client, context, handler, method: "update.run" });

    const blocked = await runRequest({ client, context, handler, method: "update.run" });
    expect(blocked).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );

    vi.advanceTimersByTime(60_001);

    const allowed = await runRequest({ client, context, handler, method: "update.run" });
    expect(allowed).toHaveBeenCalledWith(true, undefined, undefined);
    expect(handlerCalls).toHaveBeenCalledTimes(4);
  });

  it("blocks startup-gated methods before dispatch", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, undefined, undefined);
    };
    const context = {
      ...buildContext(),
      unavailableGatewayMethods: new Set(["chat.history"]),
    } as Parameters<typeof handleGatewayRequest>[0]["context"];
    const client = buildClient();

    const blocked = await runRequest({ client, context, handler, method: "chat.history" });

    expect(handlerCalls).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
      }),
    );
  });

  it("uses connId fallback when both device and client IP are unknown", () => {
    const key = resolveControlPlaneRateLimitKey({
      connId: "conn-fallback",
      connect: buildConnect(),
    });
    expect(key).toBe("unknown-device|unknown-ip|conn=conn-fallback");
  });

  it("keeps device/IP-based key when identity is present", () => {
    const key = resolveControlPlaneRateLimitKey({
      clientIp: "10.0.0.10",
      connId: "conn-fallback",
      connect: buildConnect(),
    });
    expect(key).toBe("unknown-device|10.0.0.10");
  });
});
