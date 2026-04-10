import { describe, expect, it } from "vitest";
import { selectAttachments } from "./attachments.js";
import type { MediaAttachment } from "./types.js";

describe("media-understanding selectAttachments guards", () => {
  it("does not throw when attachments is undefined", () => {
    const run = () =>
      selectAttachments({
        attachments: undefined as unknown as MediaAttachment[],
        capability: "image",
        policy: { prefer: "path" },
      });

    expect(run).not.toThrow();
    expect(run()).toEqual([]);
  });

  it("does not throw when attachments is not an array", () => {
    const run = () =>
      selectAttachments({
        attachments: { malformed: true } as unknown as MediaAttachment[],
        capability: "audio",
        policy: { prefer: "url" },
      });

    expect(run).not.toThrow();
    expect(run()).toEqual([]);
  });

  it("ignores malformed attachment entries inside an array", () => {
    const run = () =>
      selectAttachments({
        attachments: [
          null,
          { index: 1, path: 123 },
          { index: 2, url: true },
          { index: 3, mime: { nope: true } },
        ] as unknown as MediaAttachment[],
        capability: "audio",
        policy: { prefer: "path" },
      });

    expect(run).not.toThrow();
    expect(run()).toEqual([]);
  });
});
