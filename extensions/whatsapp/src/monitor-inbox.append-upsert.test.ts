import "./monitor-inbox.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import {
  installWebMonitorInboxUnitTestHooks,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";

describe("append upsert handling (#20952)", () => {
  installWebMonitorInboxUnitTestHooks();

  it("processes recent append messages (within 60s of connect)", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    // Timestamp ~5 seconds ago — recent, should be processed.
    const recentTs = Math.floor(Date.now() / 1000) - 5;
    sock.ev.emit("messages.upsert", {
      messages: [
        {
          key: { fromMe: false, id: "recent-1", remoteJid: "120363@g.us" },
          message: { conversation: "hello from group" },
          messageTimestamp: recentTs,
          pushName: "Tester",
        },
      ],
      type: "append",
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("skips stale append messages (older than 60s before connect)", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    // Timestamp 5 minutes ago — stale history sync, should be skipped.
    const staleTs = Math.floor(Date.now() / 1000) - 300;
    sock.ev.emit("messages.upsert", {
      messages: [
        {
          key: { fromMe: false, id: "stale-1", remoteJid: "120363@g.us" },
          message: { conversation: "old history sync" },
          messageTimestamp: staleTs,
          pushName: "OldTester",
        },
      ],
      type: "append",
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("skips append messages with NaN/non-finite timestamps", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    // NaN timestamp should be treated as 0 (stale) and skipped.
    sock.ev.emit("messages.upsert", {
      messages: [
        {
          key: { fromMe: false, id: "nan-1", remoteJid: "120363@g.us" },
          message: { conversation: "bad timestamp" },
          messageTimestamp: Number.NaN,
          pushName: "BadTs",
        },
      ],
      type: "append",
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("handles Long-like protobuf timestamps correctly", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    // Baileys can deliver messageTimestamp as a Long object (from protobufjs).
    // Number(longObj) calls valueOf() and returns the numeric value.
    const recentTs = Math.floor(Date.now() / 1000) - 5;
    const longLike = { high: 0, low: recentTs, unsigned: true, valueOf: () => recentTs };
    sock.ev.emit("messages.upsert", {
      messages: [
        {
          key: { fromMe: false, id: "long-1", remoteJid: "120363@g.us" },
          message: { conversation: "long timestamp" },
          messageTimestamp: longLike,
          pushName: "LongTs",
        },
      ],
      type: "append",
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("always processes notify messages regardless of timestamp", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    // Very old timestamp but type=notify — should always be processed.
    const oldTs = Math.floor(Date.now() / 1000) - 86_400;
    sock.ev.emit("messages.upsert", {
      messages: [
        {
          key: { fromMe: false, id: "notify-1", remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "normal message" },
          messageTimestamp: oldTs,
          pushName: "User",
        },
      ],
      type: "notify",
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });
});
