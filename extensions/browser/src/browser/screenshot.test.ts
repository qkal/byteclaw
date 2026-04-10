import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { normalizeBrowserScreenshot } from "./screenshot.js";

describe("browser screenshot normalization", () => {
  it("shrinks oversized images to <=2000x2000 and <=5MB", async () => {
    const bigPng = await sharp({
      create: {
        background: { b: 56, g: 34, r: 12 },
        channels: 3,
        height: 2100,
        width: 2100,
      },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    const normalized = await normalizeBrowserScreenshot(bigPng, {
      maxBytes: 5 * 1024 * 1024,
      maxSide: 2000,
    });

    expect(normalized.buffer.byteLength).toBeLessThanOrEqual(5 * 1024 * 1024);
    const meta = await sharp(normalized.buffer).metadata();
    expect(Number(meta.width)).toBeLessThanOrEqual(2000);
    expect(Number(meta.height)).toBeLessThanOrEqual(2000);
    expect(normalized.buffer[0]).toBe(0xFF);
    expect(normalized.buffer[1]).toBe(0xD8);
  }, 120_000);

  it("keeps already-small screenshots unchanged", async () => {
    const jpeg = await sharp({
      create: {
        background: { b: 0, g: 0, r: 255 },
        channels: 3,
        height: 600,
        width: 800,
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    const normalized = await normalizeBrowserScreenshot(jpeg, {
      maxBytes: 5 * 1024 * 1024,
      maxSide: 2000,
    });

    expect(normalized.buffer.equals(jpeg)).toBe(true);
  });
});
