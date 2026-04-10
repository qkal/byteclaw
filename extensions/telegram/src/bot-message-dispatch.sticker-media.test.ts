import { describe, expect, it } from "vitest";
import { pruneStickerMediaFromContext } from "./bot-message-dispatch.js";

interface MediaCtx {
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
}

function expectSingleImageMedia(ctx: MediaCtx, mediaPath: string) {
  expect(ctx.MediaPath).toBe(mediaPath);
  expect(ctx.MediaUrl).toBe(mediaPath);
  expect(ctx.MediaType).toBe("image/jpeg");
  expect(ctx.MediaPaths).toEqual([mediaPath]);
  expect(ctx.MediaUrls).toEqual([mediaPath]);
  expect(ctx.MediaTypes).toEqual(["image/jpeg"]);
}

describe("pruneStickerMediaFromContext", () => {
  it("preserves appended reply media while removing primary sticker media", () => {
    const ctx: MediaCtx = {
      MediaPath: "/tmp/sticker.webp",
      MediaPaths: ["/tmp/sticker.webp", "/tmp/replied.jpg"],
      MediaType: "image/webp",
      MediaTypes: ["image/webp", "image/jpeg"],
      MediaUrl: "/tmp/sticker.webp",
      MediaUrls: ["/tmp/sticker.webp", "/tmp/replied.jpg"],
    };

    pruneStickerMediaFromContext(ctx);

    expectSingleImageMedia(ctx, "/tmp/replied.jpg");
  });

  it("clears media fields when sticker is the only media", () => {
    const ctx: MediaCtx = {
      MediaPath: "/tmp/sticker.webp",
      MediaPaths: ["/tmp/sticker.webp"],
      MediaType: "image/webp",
      MediaTypes: ["image/webp"],
      MediaUrl: "/tmp/sticker.webp",
      MediaUrls: ["/tmp/sticker.webp"],
    };

    pruneStickerMediaFromContext(ctx);

    expect(ctx.MediaPath).toBeUndefined();
    expect(ctx.MediaUrl).toBeUndefined();
    expect(ctx.MediaType).toBeUndefined();
    expect(ctx.MediaPaths).toBeUndefined();
    expect(ctx.MediaUrls).toBeUndefined();
    expect(ctx.MediaTypes).toBeUndefined();
  });

  it("does not prune when sticker media is already omitted from context", () => {
    const ctx: MediaCtx = {
      MediaPath: "/tmp/replied.jpg",
      MediaPaths: ["/tmp/replied.jpg"],
      MediaType: "image/jpeg",
      MediaTypes: ["image/jpeg"],
      MediaUrl: "/tmp/replied.jpg",
      MediaUrls: ["/tmp/replied.jpg"],
    };

    pruneStickerMediaFromContext(ctx, { stickerMediaIncluded: false });

    expectSingleImageMedia(ctx, "/tmp/replied.jpg");
  });
});
