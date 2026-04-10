import { describe, expect, test, vi } from "vitest";
import { SessionHistorySseState, buildSessionHistorySnapshot } from "./session-history-state.js";
import * as sessionUtils from "./session-utils.js";

describe("SessionHistorySseState", () => {
  test("uses the initial raw snapshot for both first history and seq seeding", () => {
    const readSpy = vi.spyOn(sessionUtils, "readSessionMessages").mockReturnValue([
      {
        __openclaw: { seq: 1 },
        content: [{ text: "stale disk message", type: "text" }],
        role: "assistant",
      },
    ]);
    try {
      const state = SessionHistorySseState.fromRawSnapshot({
        rawMessages: [
          {
            __openclaw: { seq: 2 },
            content: [{ type: "text", text: "fresh snapshot message" }],
            role: "assistant",
          },
        ],
        target: { sessionId: "sess-main" },
      });

      expect(state.snapshot().messages).toHaveLength(1);
      expect(
        (
          state.snapshot().messages[0] as {
            content?: { text?: string }[];
            __openclaw?: { seq?: number };
          }
        ).content?.[0]?.text,
      ).toBe("fresh snapshot message");
      expect(
        (
          state.snapshot().messages[0] as {
            __openclaw?: { seq?: number };
          }
        ).__openclaw?.seq,
      ).toBe(2);

      const appended = state.appendInlineMessage({
        message: {
          content: [{ text: "next message", type: "text" }],
          role: "assistant",
        },
      });

      expect(appended?.messageSeq).toBe(3);
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  test("reuses one canonical array for items and messages", () => {
    const snapshot = buildSessionHistorySnapshot({
      limit: 1,
      rawMessages: [
        {
          __openclaw: { seq: 1 },
          content: [{ type: "text", text: "first" }],
          role: "assistant",
        },
        {
          __openclaw: { seq: 2 },
          content: [{ type: "text", text: "second" }],
          role: "assistant",
        },
      ],
    });

    expect(snapshot.history.items).toBe(snapshot.history.messages);
    expect(snapshot.history.messages[0]?.__openclaw?.seq).toBe(2);
    expect(snapshot.rawTranscriptSeq).toBe(2);
  });
});
