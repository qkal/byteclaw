import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  formatAgentEnvelope,
  formatEnvelopeTimestamp,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "./envelope.js";

describe("formatAgentEnvelope", () => {
  it("includes channel, from, ip, host, and timestamp", () => {
    withEnv({ TZ: "UTC" }, () => {
      const ts = Date.UTC(2025, 0, 2, 3, 4); // 2025-01-02T03:04:00Z
      const body = formatAgentEnvelope({
        body: "hello",
        channel: "WebChat",
        envelope: { timezone: "utc" },
        from: "user1",
        host: "mac-mini",
        ip: "10.0.0.5",
        timestamp: ts,
      });

      expect(body).toBe("[WebChat user1 mac-mini 10.0.0.5 Thu 2025-01-02T03:04Z] hello");
    });
  });

  it("formats timestamps in local timezone by default", () => {
    const ts = Date.UTC(2025, 0, 2, 3, 4);
    const expectedTimestamp = formatEnvelopeTimestamp(ts, { timezone: "local" });
    const body = formatAgentEnvelope({
      body: "hello",
      channel: "WebChat",
      timestamp: ts,
    });

    expect(body).toBe(`[WebChat ${expectedTimestamp}] hello`);
  });

  it("formats timestamps in UTC when configured", () => {
    withEnv({ TZ: "America/Los_Angeles" }, () => {
      const ts = Date.UTC(2025, 0, 2, 3, 4); // 2025-01-02T03:04:00Z (19:04 PST)
      const body = formatAgentEnvelope({
        body: "hello",
        channel: "WebChat",
        envelope: { timezone: "utc" },
        timestamp: ts,
      });

      expect(body).toBe("[WebChat Thu 2025-01-02T03:04Z] hello");
    });
  });

  it("formats timestamps in user timezone when configured", () => {
    const ts = Date.UTC(2025, 0, 2, 3, 4); // 2025-01-02T03:04:00Z (04:04 CET)
    const body = formatAgentEnvelope({
      body: "hello",
      channel: "WebChat",
      envelope: { timezone: "user", userTimezone: "Europe/Vienna" },
      timestamp: ts,
    });

    expect(body).toMatch(/\[WebChat Thu 2025-01-02 04:04 [^\]]+\] hello/);
  });

  it("omits timestamps when configured", () => {
    const ts = Date.UTC(2025, 0, 2, 3, 4);
    const body = formatAgentEnvelope({
      body: "hello",
      channel: "WebChat",
      envelope: { includeTimestamp: false },
      timestamp: ts,
    });
    expect(body).toBe("[WebChat] hello");
  });

  it("handles missing optional fields", () => {
    const body = formatAgentEnvelope({ body: "hi", channel: "Telegram" });
    expect(body).toBe("[Telegram] hi");
  });
});

describe("formatInboundEnvelope", () => {
  it("prefixes sender for non-direct chats", () => {
    const body = formatInboundEnvelope({
      body: "hi",
      channel: "Discord",
      chatType: "channel",
      from: "Guild #general",
      senderLabel: "Alice",
    });
    expect(body).toBe("[Discord Guild #general] Alice: hi");
  });

  it("uses sender fields when senderLabel is missing", () => {
    const body = formatInboundEnvelope({
      body: "ping",
      channel: "Signal",
      chatType: "group",
      from: "Signal Group id:123",
      sender: { id: "42", name: "Bob" },
    });
    expect(body).toBe("[Signal Signal Group id:123] Bob (42): ping");
  });

  it("keeps direct messages unprefixed", () => {
    const body = formatInboundEnvelope({
      body: "hello",
      channel: "iMessage",
      chatType: "direct",
      from: "+1555",
      senderLabel: "Alice",
    });
    expect(body).toBe("[iMessage +1555] hello");
  });

  it("includes elapsed time when previousTimestamp is provided", () => {
    const now = Date.now();
    const twoMinutesAgo = now - 2 * 60 * 1000;
    const body = formatInboundEnvelope({
      body: "follow-up message",
      channel: "Telegram",
      chatType: "direct",
      envelope: { includeTimestamp: false },
      from: "Alice",
      previousTimestamp: twoMinutesAgo,
      timestamp: now,
    });
    expect(body).toContain("Alice +2m");
    expect(body).toContain("follow-up message");
  });

  it("omits elapsed time when disabled", () => {
    const now = Date.now();
    const body = formatInboundEnvelope({
      body: "follow-up message",
      channel: "Telegram",
      chatType: "direct",
      envelope: { includeElapsed: false, includeTimestamp: false },
      from: "Alice",
      previousTimestamp: now - 2 * 60 * 1000,
      timestamp: now,
    });
    expect(body).toBe("[Telegram Alice] follow-up message");
  });

  it("prefixes DM body with (self) when fromMe is true", () => {
    const body = formatInboundEnvelope({
      body: "outbound msg",
      channel: "WhatsApp",
      chatType: "direct",
      from: "+1555",
      fromMe: true,
    });
    expect(body).toBe("[WhatsApp +1555] (self): outbound msg");
  });

  it("does not prefix group messages with (self) when fromMe is true", () => {
    const body = formatInboundEnvelope({
      body: "hello",
      channel: "WhatsApp",
      chatType: "group",
      from: "Family Chat",
      fromMe: true,
      senderLabel: "Alice",
    });
    expect(body).toBe("[WhatsApp Family Chat] Alice: hello");
  });

  it("resolves envelope options from config", () => {
    const options = resolveEnvelopeFormatOptions({
      agents: {
        defaults: {
          envelopeElapsed: "off",
          envelopeTimestamp: "off",
          envelopeTimezone: "user",
          userTimezone: "Europe/Vienna",
        },
      },
    });
    expect(options).toEqual({
      includeElapsed: false,
      includeTimestamp: false,
      timezone: "user",
      userTimezone: "Europe/Vienna",
    });
  });
});
