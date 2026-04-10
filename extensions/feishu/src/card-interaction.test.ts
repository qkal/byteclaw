import { describe, expect, it } from "vitest";
import {
  buildFeishuCardActionTextFallback,
  createFeishuCardInteractionEnvelope,
  decodeFeishuCardAction,
} from "./card-interaction.js";

describe("feishu card interaction decoder", () => {
  it("decodes valid structured payloads", () => {
    const result = decodeFeishuCardAction({
      event: {
        action: {
          value: createFeishuCardInteractionEnvelope({
            a: "feishu.quick_actions.help",
            c: { e: 1_700_000_060_000, h: "chat1", t: "group", u: "u123" },
            k: "quick",
            q: "/help",
          }),
        },
        context: { chat_id: "chat1" },
        operator: { open_id: "u123" },
      },
      now: 1_700_000_000_000,
    });

    expect(result).toEqual(
      expect.objectContaining({
        envelope: expect.objectContaining({
          q: "/help",
        }),
        kind: "structured",
      }),
    );
  });

  it("falls back for legacy text-like payloads", () => {
    const result = decodeFeishuCardAction({
      event: {
        action: { value: { text: "/ping" } },
        context: { chat_id: "chat1" },
        operator: { open_id: "u123" },
      },
    });

    expect(result).toEqual({ kind: "legacy", text: "/ping" });
    expect(
      buildFeishuCardActionTextFallback({
        action: { value: { command: "/new" } },
        context: { chat_id: "chat1" },
        operator: { open_id: "u123" },
      }),
    ).toBe("/new");
  });

  it("rejects malformed structured payloads", () => {
    const result = decodeFeishuCardAction({
      event: {
        action: {
          value: {
            a: "broken",
            k: "quick",
            m: { bad: { nested: true } },
            oc: "ocf1",
          },
        },
        context: { chat_id: "chat1" },
        operator: { open_id: "u123" },
      },
    });

    expect(result).toEqual({ kind: "invalid", reason: "malformed" });
  });

  it("rejects stale payloads", () => {
    const result = decodeFeishuCardAction({
      event: {
        action: {
          value: createFeishuCardInteractionEnvelope({
            a: "stale",
            c: { e: 99, t: "group" },
            k: "button",
          }),
        },
        context: { chat_id: "chat1" },
        operator: { open_id: "u123" },
      },
      now: 100,
    });

    expect(result).toEqual({ kind: "invalid", reason: "stale" });
  });

  it("rejects wrong-conversation payloads when chat context is enforced", () => {
    const result = decodeFeishuCardAction({
      event: {
        action: {
          value: createFeishuCardInteractionEnvelope({
            a: "scoped",
            c: { e: Date.now() + 60_000, h: "chat1", t: "group", u: "u123" },
            k: "button",
          }),
        },
        context: { chat_id: "chat2" },
        operator: { open_id: "u123" },
      },
    });

    expect(result).toEqual({ kind: "invalid", reason: "wrong_conversation" });
  });

  it("rejects malformed chat-type context", () => {
    const result = decodeFeishuCardAction({
      event: {
        action: {
          value: {
            a: "bad",
            c: { t: "private" },
            k: "button",
            oc: "ocf1",
          },
        },
        context: { chat_id: "chat1" },
        operator: { open_id: "u123" },
      },
    });

    expect(result).toEqual({ kind: "invalid", reason: "malformed" });
  });
});
