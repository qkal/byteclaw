import { describe, expect, it } from "vitest";
import {
  filterHeartbeatPairs,
  isHeartbeatOkResponse,
  isHeartbeatUserMessage,
} from "./heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "./heartbeat.js";

describe("isHeartbeatUserMessage", () => {
  it("matches heartbeat prompts", () => {
    expect(
      isHeartbeatUserMessage(
        {
          content: `${HEARTBEAT_PROMPT}\nWhen reading HEARTBEAT.md, use workspace file /tmp/HEARTBEAT.md (exact case). Do not read docs/heartbeat.md.`,
          role: "user",
        },
        HEARTBEAT_PROMPT,
      ),
    ).toBe(true);

    expect(
      isHeartbeatUserMessage({
        content:
          "Run the following periodic tasks (only those due based on their intervals):\n\n- email-check: Check for urgent unread emails\n\nAfter completing all due tasks, reply HEARTBEAT_OK.",
        role: "user",
      }),
    ).toBe(true);
  });

  it("ignores quoted or non-user token mentions", () => {
    expect(
      isHeartbeatUserMessage({
        content: "Please reply HEARTBEAT_OK so I can test something.",
        role: "user",
      }),
    ).toBe(false);

    expect(
      isHeartbeatUserMessage({
        content: "HEARTBEAT_OK",
        role: "assistant",
      }),
    ).toBe(false);
  });
});

describe("isHeartbeatOkResponse", () => {
  it("matches no-op heartbeat acknowledgements", () => {
    expect(
      isHeartbeatOkResponse({
        content: "**HEARTBEAT_OK**",
        role: "assistant",
      }),
    ).toBe(true);

    expect(
      isHeartbeatOkResponse({
        content: "You have 3 unread urgent emails. HEARTBEAT_OK",
        role: "assistant",
      }),
    ).toBe(true);
  });

  it("preserves meaningful or non-text responses", () => {
    expect(
      isHeartbeatOkResponse({
        content: "Status HEARTBEAT_OK due to watchdog failure",
        role: "assistant",
      }),
    ).toBe(false);

    expect(
      isHeartbeatOkResponse({
        content: [{ id: "tool-1", input: {}, name: "search", type: "tool_use" }],
        role: "assistant",
      }),
    ).toBe(false);
  });

  it("respects ackMaxChars overrides", () => {
    expect(
      isHeartbeatOkResponse(
        {
          content: "HEARTBEAT_OK all good",
          role: "assistant",
        },
        0,
      ),
    ).toBe(false);
  });
});

describe("filterHeartbeatPairs", () => {
  it("removes no-op heartbeat pairs", () => {
    const messages = [
      { content: "Hello", role: "user" },
      { content: "Hi there!", role: "assistant" },
      { content: HEARTBEAT_PROMPT, role: "user" },
      { content: "HEARTBEAT_OK", role: "assistant" },
      { content: "What time is it?", role: "user" },
      { content: "It is 3pm.", role: "assistant" },
    ];

    expect(filterHeartbeatPairs(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { content: "Hello", role: "user" },
      { content: "Hi there!", role: "assistant" },
      { content: "What time is it?", role: "user" },
      { content: "It is 3pm.", role: "assistant" },
    ]);
  });

  it("keeps meaningful heartbeat results and non-text assistant turns", () => {
    const meaningfulMessages = [
      { content: HEARTBEAT_PROMPT, role: "user" },
      { content: "Status HEARTBEAT_OK due to watchdog failure", role: "assistant" },
    ];
    expect(filterHeartbeatPairs(meaningfulMessages, undefined, HEARTBEAT_PROMPT)).toEqual(
      meaningfulMessages,
    );

    const nonTextMessages = [
      { content: HEARTBEAT_PROMPT, role: "user" },
      {
        content: [{ id: "tool-1", input: {}, name: "search", type: "tool_use" }],
        role: "assistant",
      },
    ];
    expect(filterHeartbeatPairs(nonTextMessages, undefined, HEARTBEAT_PROMPT)).toEqual(
      nonTextMessages,
    );
  });

  it("keeps ordinary chats that mention the token", () => {
    const messages = [
      { content: "Please reply HEARTBEAT_OK so I can test something.", role: "user" },
      { content: "HEARTBEAT_OK", role: "assistant" },
    ];

    expect(filterHeartbeatPairs(messages, undefined, HEARTBEAT_PROMPT)).toEqual(messages);
  });
});
