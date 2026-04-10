import { describe, expect, it } from "vitest";
import { formatDecisionSummary } from "./runner.entries.js";
import type { MediaUnderstandingDecision } from "./types.js";

describe("media-understanding formatDecisionSummary guards", () => {
  it("does not throw when decision.attachments is undefined", () => {
    const run = () =>
      formatDecisionSummary({
        attachments: undefined as unknown as MediaUnderstandingDecision["attachments"],
        capability: "image",
        outcome: "skipped",
      });

    expect(run).not.toThrow();
    expect(run()).toBe("image: skipped");
  });

  it("does not throw when attachment attempts is malformed", () => {
    const run = () =>
      formatDecisionSummary({
        attachments: [{ attachmentIndex: 0, attempts: { bad: true } }],
        capability: "video",
        outcome: "skipped",
      } as unknown as MediaUnderstandingDecision);

    expect(run).not.toThrow();
    expect(run()).toBe("video: skipped (0/1)");
  });

  it("ignores non-string provider/model/reason fields", () => {
    const run = () =>
      formatDecisionSummary({
        attachments: [
          {
            attachmentIndex: 0,
            attempts: [{ reason: { malformed: true } }],
            chosen: {
              model: 42,
              outcome: "failed",
              provider: { bad: true },
            },
          },
        ],
        capability: "audio",
        outcome: "failed",
      } as unknown as MediaUnderstandingDecision);

    expect(run).not.toThrow();
    expect(run()).toBe("audio: failed (0/1)");
  });
});
