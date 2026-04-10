import { describe, expect, it } from "vitest";
import {
  AUTH_NONE,
  AUTH_TOKEN,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import type { ReadinessChecker } from "./server/readiness.js";

describe("gateway probe endpoints", () => {
  it("returns detailed readiness payload for local /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      failing: [],
      ready: true,
      uptimeMs: 45_000,
    });

    await withGatewayServer({
      overrides: { getReadiness },
      prefix: "probe-ready",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual({ failing: [], ready: true, uptimeMs: 45_000 });
      },
    });
  });

  it("returns only readiness state for unauthenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      failing: ["discord", "telegram"],
      ready: false,
      uptimeMs: 8000,
    });

    await withGatewayServer({
      overrides: { getReadiness },
      prefix: "probe-not-ready",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({
          host: "gateway.test",
          path: "/ready",
          remoteAddress: "10.0.0.8",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false });
      },
    });
  });

  it("returns detailed readiness payload for authenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      failing: ["discord", "telegram"],
      ready: false,
      uptimeMs: 8000,
    });

    await withGatewayServer({
      overrides: { getReadiness },
      prefix: "probe-remote-authenticated",
      resolvedAuth: AUTH_TOKEN,
      run: async (server) => {
        const req = createRequest({
          authorization: "Bearer test-token",
          host: "gateway.test",
          path: "/ready",
          remoteAddress: "10.0.0.8",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({
          failing: ["discord", "telegram"],
          ready: false,
          uptimeMs: 8_000,
        });
      },
    });
  });

  it("returns typed internal error payload when readiness evaluation throws", async () => {
    const getReadiness: ReadinessChecker = () => {
      throw new Error("boom");
    };

    await withGatewayServer({
      overrides: { getReadiness },
      prefix: "probe-throws",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ failing: ["internal"], ready: false, uptimeMs: 0 });
      },
    });
  });

  it("keeps /healthz shallow even when readiness checker reports failing channels", async () => {
    const getReadiness: ReadinessChecker = () => ({
      failing: ["discord"],
      ready: false,
      uptimeMs: 999,
    });

    await withGatewayServer({
      overrides: { getReadiness },
      prefix: "probe-healthz-unaffected",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({ path: "/healthz" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe(JSON.stringify({ ok: true, status: "live" }));
      },
    });
  });

  it("reflects readiness status on HEAD /readyz without a response body", async () => {
    const getReadiness: ReadinessChecker = () => ({
      failing: ["discord"],
      ready: false,
      uptimeMs: 5000,
    });

    await withGatewayServer({
      overrides: { getReadiness },
      prefix: "probe-readyz-head",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({ method: "HEAD", path: "/readyz" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(getBody()).toBe("");
      },
    });
  });
});
