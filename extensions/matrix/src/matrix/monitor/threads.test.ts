import { describe, expect, it } from "vitest";
import { resolveMatrixThreadRouting } from "./threads.js";

describe("resolveMatrixThreadRouting", () => {
  it("keeps sessions flat when threadReplies is off", () => {
    expect(
      resolveMatrixThreadRouting({
        isDirectMessage: false,
        messageId: "$reply1",
        threadReplies: "off",
        threadRootId: "$root",
      }),
    ).toEqual({
      threadId: undefined,
    });
  });

  it("uses the inbound thread root when replies arrive inside an existing thread", () => {
    expect(
      resolveMatrixThreadRouting({
        isDirectMessage: false,
        messageId: "$reply1",
        threadReplies: "inbound",
        threadRootId: "$root",
      }),
    ).toEqual({
      threadId: "$root",
    });
  });

  it("keeps top-level inbound messages flat when threadReplies is inbound", () => {
    expect(
      resolveMatrixThreadRouting({
        isDirectMessage: false,
        messageId: "$root",
        threadReplies: "inbound",
      }),
    ).toEqual({
      threadId: undefined,
    });
  });

  it("uses the triggering message as the thread id when threadReplies is always", () => {
    expect(
      resolveMatrixThreadRouting({
        isDirectMessage: false,
        messageId: "$root",
        threadReplies: "always",
      }),
    ).toEqual({
      threadId: "$root",
    });
  });

  it("lets dm.threadReplies override room threading behavior", () => {
    expect(
      resolveMatrixThreadRouting({
        dmThreadReplies: "off",
        isDirectMessage: true,
        messageId: "$reply1",
        threadReplies: "always",
        threadRootId: "$root",
      }),
    ).toEqual({
      threadId: undefined,
    });
  });
});
