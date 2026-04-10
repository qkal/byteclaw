import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeDirectoryLiveAdapter,
  createRuntimeOutboundDelegates,
} from "./runtime-forwarders.js";

describe("createRuntimeDirectoryLiveAdapter", () => {
  it("forwards live directory calls through the runtime getter", async () => {
    const listPeersLive = vi.fn(async (_ctx: unknown) => [{ id: "alice", kind: "user" as const }]);
    const adapter = createRuntimeDirectoryLiveAdapter({
      getRuntime: async () => ({ listPeersLive }),
      listPeersLive: (runtime) => runtime.listPeersLive,
    });

    await expect(
      adapter.listPeersLive?.({ cfg: {} as never, limit: 1, query: "a", runtime: {} as never }),
    ).resolves.toEqual([{ id: "alice", kind: "user" }]);
    expect(listPeersLive).toHaveBeenCalled();
  });
});

describe("createRuntimeOutboundDelegates", () => {
  it("forwards outbound methods through the runtime getter", async () => {
    const sendText = vi.fn(async () => ({ channel: "x", messageId: "1" }));
    const outbound = createRuntimeOutboundDelegates({
      getRuntime: async () => ({ outbound: { sendText } }),
      sendText: { resolve: (runtime) => runtime.outbound.sendText },
    });

    await expect(outbound.sendText?.({ cfg: {} as never, text: "hi", to: "a" })).resolves.toEqual({
      channel: "x",
      messageId: "1",
    });
    expect(sendText).toHaveBeenCalled();
  });

  it("throws the configured unavailable message", async () => {
    const outbound = createRuntimeOutboundDelegates({
      getRuntime: async () => ({ outbound: {} }),
      sendPoll: {
        resolve: () => undefined,
        unavailableMessage: "poll unavailable",
      },
    });

    await expect(
      outbound.sendPoll?.({
        cfg: {} as never,
        poll: { options: ["a"], question: "q" },
        to: "a",
      }),
    ).rejects.toThrow("poll unavailable");
  });
});
