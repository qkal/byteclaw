import { describe, expect, it, vi } from "vitest";
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "./inbound-debounce-policy.js";

describe("shouldDebounceTextInbound", () => {
  it("rejects blank text, media, and control commands", () => {
    const cfg = {} as Parameters<typeof shouldDebounceTextInbound>[0]["cfg"];

    expect(shouldDebounceTextInbound({ cfg, text: "   " })).toBe(false);
    expect(shouldDebounceTextInbound({ cfg, hasMedia: true, text: "hello" })).toBe(false);
    expect(shouldDebounceTextInbound({ cfg, text: "/status" })).toBe(false);
  });

  it("accepts normal text when debounce is allowed", () => {
    const cfg = {} as Parameters<typeof shouldDebounceTextInbound>[0]["cfg"];
    expect(shouldDebounceTextInbound({ cfg, text: "hello there" })).toBe(true);
    expect(shouldDebounceTextInbound({ allowDebounce: false, cfg, text: "hello there" })).toBe(
      false,
    );
  });
});

describe("createChannelInboundDebouncer", () => {
  it("resolves per-channel debounce and forwards callbacks", async () => {
    vi.useFakeTimers();
    try {
      const flushed: string[][] = [];
      const cfg = {
        messages: {
          inbound: {
            byChannel: {
              "demo-channel": 25,
            },
            debounceMs: 10,
          },
        },
      } as Parameters<typeof createChannelInboundDebouncer<{ id: string }>>[0]["cfg"];

      const { debounceMs, debouncer } = createChannelInboundDebouncer<{ id: string }>({
        buildKey: (item) => item.id,
        cfg,
        channel: "demo-channel",
        onFlush: async (items) => {
          flushed.push(items.map((entry) => entry.id));
        },
      });

      expect(debounceMs).toBe(25);

      await debouncer.enqueue({ id: "a" });
      await debouncer.enqueue({ id: "a" });
      await vi.advanceTimersByTimeAsync(30);

      expect(flushed).toEqual([["a", "a"]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
