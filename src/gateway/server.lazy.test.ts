import { beforeEach, describe, expect, it, vi } from "vitest";

const lazyState = vi.hoisted(() => ({
  loads: 0,
  resetCalls: 0,
  startCalls: [] as unknown[][],
}));

vi.mock("./server.impl.js", () => {
  lazyState.loads += 1;
  return {
    __resetModelCatalogCacheForTest: vi.fn(() => {
      lazyState.resetCalls += 1;
    }),
    startGatewayServer: vi.fn(async (...args: unknown[]) => {
      lazyState.startCalls.push(args);
      return { close: vi.fn(async () => undefined) };
    }),
  };
});

describe("gateway server boundary", () => {
  beforeEach(() => {
    lazyState.loads = 0;
    lazyState.startCalls = [];
    lazyState.resetCalls = 0;
  });

  it("lazy-loads server.impl on demand", async () => {
    const mod = await import("./server.js");

    expect(lazyState.loads).toBe(0);

    await mod.__resetModelCatalogCacheForTest();
    expect(lazyState.loads).toBe(1);
    expect(lazyState.resetCalls).toBe(1);

    await mod.startGatewayServer(4321, { bind: "loopback" });
    expect(lazyState.loads).toBe(1);
    expect(lazyState.startCalls).toEqual([[4321, { bind: "loopback" }]]);
  });
});
