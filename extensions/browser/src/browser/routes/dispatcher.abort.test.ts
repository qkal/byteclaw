import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";

let createBrowserRouteDispatcher: typeof import("./dispatcher.js").createBrowserRouteDispatcher;

describe("browser route dispatcher (abort)", () => {
  beforeAll(async () => {
    vi.doMock("./index.js", () => ({
      registerBrowserRoutes(app: { get: (path: string, handler: unknown) => void }) {
        app.get(
          "/slow",
          async (req: { signal?: AbortSignal }, res: { json: (body: unknown) => void }) => {
            const { signal } = req;
            await new Promise<void>((resolve, reject) => {
              if (signal?.aborted) {
                reject(signal.reason ?? new Error("aborted"));
                return;
              }
              const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
              signal?.addEventListener("abort", onAbort, { once: true });
              queueMicrotask(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
              });
            });
            res.json({ ok: true });
          },
        );
        app.get(
          "/echo/:id",
          async (
            req: { params?: Record<string, string> },
            res: { json: (body: unknown) => void },
          ) => {
            res.json({ id: req.params?.id ?? null });
          },
        );
      },
    }));
    ({ createBrowserRouteDispatcher } = await import("./dispatcher.js"));
  });

  it("propagates AbortSignal and lets handlers observe abort", async () => {
    const dispatcher = createBrowserRouteDispatcher({} as BrowserRouteContext);

    const ctrl = new AbortController();
    const promise = dispatcher.dispatch({
      method: "GET",
      path: "/slow",
      signal: ctrl.signal,
    });

    ctrl.abort(new Error("timed out"));

    await expect(promise).resolves.toMatchObject({
      body: { error: expect.stringContaining("timed out") },
      status: 500,
    });
  });

  it("returns 400 for malformed percent-encoding in route params", async () => {
    const dispatcher = createBrowserRouteDispatcher({} as BrowserRouteContext);

    await expect(
      dispatcher.dispatch({
        method: "GET",
        path: "/echo/%E0%A4%A",
      }),
    ).resolves.toMatchObject({
      body: { error: expect.stringContaining("invalid path parameter encoding") },
      status: 400,
    });
  });
});
