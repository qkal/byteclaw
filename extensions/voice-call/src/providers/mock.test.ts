import { describe, expect, it } from "vitest";
import type { WebhookContext } from "../types.js";
import { MockProvider } from "./mock.js";

function createWebhookContext(rawBody: string): WebhookContext {
  return {
    headers: {},
    method: "POST",
    query: {},
    rawBody,
    url: "http://localhost/voice/webhook",
  };
}

describe("MockProvider", () => {
  it("preserves explicit falsy event values", () => {
    const provider = new MockProvider();
    const result = provider.parseWebhookEvent(
      createWebhookContext(
        JSON.stringify({
          events: [
            {
              callId: "call-1",
              error: "",
              id: "evt-error",
              retryable: false,
              timestamp: 0,
              type: "call.error",
            },
            {
              callId: "call-2",
              id: "evt-ended",
              reason: "",
              type: "call.ended",
            },
            {
              callId: "call-3",
              id: "evt-speech",
              isFinal: false,
              transcript: "",
              type: "call.speech",
            },
          ],
        }),
      ),
    );

    expect(result.events).toEqual([
      {
        callId: "call-1",
        error: "",
        id: "evt-error",
        providerCallId: undefined,
        retryable: false,
        timestamp: 0,
        type: "call.error",
      },
      {
        callId: "call-2",
        id: "evt-ended",
        providerCallId: undefined,
        reason: "",
        timestamp: expect.any(Number),
        type: "call.ended",
      },
      {
        callId: "call-3",
        confidence: undefined,
        id: "evt-speech",
        isFinal: false,
        providerCallId: undefined,
        timestamp: expect.any(Number),
        transcript: "",
        type: "call.speech",
      },
    ]);
  });
});
