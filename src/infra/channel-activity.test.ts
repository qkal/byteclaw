import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getChannelActivity,
  recordChannelActivity,
  resetChannelActivityForTest,
} from "./channel-activity.js";

describe("channel activity", () => {
  beforeEach(() => {
    resetChannelActivityForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-08T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the default account for blank inputs and falls back to null timestamps", () => {
    expect(getChannelActivity({ channel: "telegram" })).toEqual({
      inboundAt: null,
      outboundAt: null,
    });

    recordChannelActivity({
      accountId: "  ",
      channel: "telegram",
      direction: "inbound",
    });

    expect(getChannelActivity({ accountId: null, channel: "telegram" })).toEqual({
      inboundAt: 1_767_830_400_000,
      outboundAt: null,
    });
  });

  it("keeps inbound and outbound timestamps independent and trims account ids", () => {
    recordChannelActivity({
      accountId: " team-a ",
      at: 10,
      channel: "whatsapp",
      direction: "inbound",
    });
    recordChannelActivity({
      accountId: "team-a",
      at: 20,
      channel: "whatsapp",
      direction: "outbound",
    });
    recordChannelActivity({
      accountId: "team-a",
      at: 30,
      channel: "whatsapp",
      direction: "inbound",
    });

    expect(getChannelActivity({ accountId: " team-a ", channel: "whatsapp" })).toEqual({
      inboundAt: 30,
      outboundAt: 20,
    });
  });

  it("keeps activity isolated per account on the same channel", () => {
    recordChannelActivity({
      accountId: "team-a",
      at: 10,
      channel: "telegram",
      direction: "inbound",
    });
    recordChannelActivity({
      accountId: "team-b",
      at: 20,
      channel: "telegram",
      direction: "outbound",
    });

    expect(getChannelActivity({ accountId: "team-a", channel: "telegram" })).toEqual({
      inboundAt: 10,
      outboundAt: null,
    });
    expect(getChannelActivity({ accountId: " team-b ", channel: "telegram" })).toEqual({
      inboundAt: null,
      outboundAt: 20,
    });
  });

  it("reset clears previously recorded activity", () => {
    recordChannelActivity({ at: 7, channel: "line", direction: "outbound" });
    resetChannelActivityForTest();

    expect(getChannelActivity({ channel: "line" })).toEqual({
      inboundAt: null,
      outboundAt: null,
    });
  });
});
