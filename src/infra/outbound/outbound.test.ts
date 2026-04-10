import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { typedCases } from "../../test-utils/typed-cases.js";
import { DirectoryCache } from "./directory-cache.js";
import { buildOutboundResultEnvelope } from "./envelope.js";
import type { OutboundDeliveryJson } from "./format.js";

beforeEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
});

describe("DirectoryCache", () => {
  const cfg = {} as OpenClawConfig;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires entries after ttl", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const cache = new DirectoryCache<string>(1000, 10);

    cache.set("a", "value-a", cfg);
    expect(cache.get("a", cfg)).toBe("value-a");

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    expect(cache.get("a", cfg)).toBeUndefined();
  });

  it.each([
    {
      actions: [
        ["set", "a", "value-a"],
        ["set", "b", "value-b"],
        ["set", "c", "value-c"],
      ] as const,
      expected: { a: undefined, b: "value-b", c: "value-c" },
    },
    {
      actions: [
        ["set", "a", "value-a"],
        ["set", "b", "value-b"],
        ["set", "a", "value-a2"],
        ["set", "c", "value-c"],
      ] as const,
      expected: { a: "value-a2", b: undefined, c: "value-c" },
    },
  ])("evicts least-recent entries when capacity is exceeded for %j", ({ actions, expected }) => {
    const cache = new DirectoryCache<string>(60_000, 2);
    for (const [, key, value] of actions) {
      cache.set(key, value, cfg);
    }
    expect(cache.get("a", cfg)).toBe(expected.a);
    expect(cache.get("b", cfg)).toBe(expected.b);
    expect(cache.get("c", cfg)).toBe(expected.c);
  });
});

describe("buildOutboundResultEnvelope", () => {
  const whatsappDelivery: OutboundDeliveryJson = {
    channel: "whatsapp",
    mediaUrl: null,
    messageId: "m1",
    to: "+1",
    via: "gateway",
  };
  const telegramDelivery: OutboundDeliveryJson = {
    channel: "telegram",
    chatId: "c1",
    mediaUrl: null,
    messageId: "m2",
    to: "123",
    via: "direct",
  };
  const discordDelivery: OutboundDeliveryJson = {
    channel: "discord",
    channelId: "C1",
    mediaUrl: null,
    messageId: "m3",
    to: "channel:C1",
    via: "gateway",
  };

  it.each(
    typedCases<{
      name: string;
      input: Parameters<typeof buildOutboundResultEnvelope>[0];
      expected: unknown;
    }>([
      {
        expected: whatsappDelivery,
        input: { delivery: whatsappDelivery },
        name: "flatten delivery by default",
      },
      {
        expected: {
          meta: { foo: "bar" },
          payloads: [{ mediaUrl: null, mediaUrls: undefined, text: "hi" }],
        },
        input: {
          meta: { foo: "bar" },
          payloads: [{ mediaUrl: null, mediaUrls: undefined, text: "hi" }],
        },
        name: "keep payloads + meta",
      },
      {
        expected: {
          delivery: telegramDelivery,
          meta: { ok: true },
          payloads: [],
        },
        input: { delivery: telegramDelivery, meta: { ok: true }, payloads: [] },
        name: "include delivery when payloads exist",
      },
      {
        expected: { delivery: discordDelivery },
        input: { delivery: discordDelivery, flattenDelivery: false },
        name: "keep wrapped delivery when flatten disabled",
      },
    ]),
  )("$name", ({ input, expected }) => {
    expect(buildOutboundResultEnvelope(input)).toEqual(expected);
  });
});
