import { describe, expect, it } from "vitest";
import { resolveRunTypingPolicy } from "./typing-policy.js";

describe("resolveRunTypingPolicy", () => {
  it("forces heartbeat policy for heartbeat runs", () => {
    const resolved = resolveRunTypingPolicy({
      isHeartbeat: true,
      requestedPolicy: "user_message",
    });
    expect(resolved).toEqual({
      suppressTyping: true,
      typingPolicy: "heartbeat",
    });
  });

  it("forces internal webchat policy", () => {
    const resolved = resolveRunTypingPolicy({
      originatingChannel: "webchat",
      requestedPolicy: "user_message",
    });
    expect(resolved).toEqual({
      suppressTyping: true,
      typingPolicy: "internal_webchat",
    });
  });

  it("forces system event policy for routed turns", () => {
    const resolved = resolveRunTypingPolicy({
      originatingChannel: "telegram",
      requestedPolicy: "user_message",
      systemEvent: true,
    });
    expect(resolved).toEqual({
      suppressTyping: true,
      typingPolicy: "system_event",
    });
  });

  it("preserves requested policy for regular user turns", () => {
    const resolved = resolveRunTypingPolicy({
      originatingChannel: "telegram",
      requestedPolicy: "user_message",
    });
    expect(resolved).toEqual({
      suppressTyping: false,
      typingPolicy: "user_message",
    });
  });

  it("respects explicit suppressTyping", () => {
    const resolved = resolveRunTypingPolicy({
      originatingChannel: "telegram",
      requestedPolicy: "auto",
      suppressTyping: true,
    });
    expect(resolved).toEqual({
      suppressTyping: true,
      typingPolicy: "auto",
    });
  });
});
