import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { sanitizeContentBlocksImages, sanitizeImageBlocks } from "./tool-images.js";

describe("tool image sanitizing", () => {
  const getImageBlock = (
    blocks: Awaited<ReturnType<typeof sanitizeContentBlocksImages>>,
  ): (typeof blocks)[number] & { type: "image"; data: string; mimeType?: string } => {
    const image = blocks.find((block) => block.type === "image");
    if (!image || image.type !== "image") {
      throw new Error("expected image block");
    }
    return image;
  };

  const createWidePng = async () => {
    const width = 2600;
    const height = 400;
    const raw = Buffer.alloc(width * height * 3, 0x7f);
    return sharp(raw, {
      raw: { channels: 3, height, width },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
  };

  it("shrinks oversized images to <=5MB", async () => {
    const width = 2800;
    const height = 2800;
    const raw = Buffer.alloc(width * height * 3, 0xff);
    const bigPng = await sharp(raw, {
      raw: { channels: 3, height, width },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(bigPng.byteLength).toBeGreaterThan(5 * 1024 * 1024);

    const blocks = [
      {
        data: bigPng.toString("base64"),
        mimeType: "image/png",
        type: "image" as const,
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    const image = getImageBlock(out);
    const size = Buffer.from(image.data, "base64").byteLength;
    expect(size).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(image.mimeType).toBe("image/jpeg");
  }, 20_000);

  it("sanitizes image arrays and reports drops", async () => {
    const png = await createWidePng();

    const images = [
      { data: png.toString("base64"), mimeType: "image/png", type: "image" as const },
    ];
    const { images: out, dropped } = await sanitizeImageBlocks(images, "test");
    expect(dropped).toBe(0);
    expect(out.length).toBe(1);
    const meta = await sharp(Buffer.from(out[0].data, "base64")).metadata();
    expect(meta.width).toBeLessThanOrEqual(1200);
    expect(meta.height).toBeLessThanOrEqual(1200);
  }, 20_000);

  it("shrinks images that exceed max dimension even if size is small", async () => {
    const png = await createWidePng();

    const blocks = [
      {
        data: png.toString("base64"),
        mimeType: "image/png",
        type: "image" as const,
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    const image = getImageBlock(out);
    const meta = await sharp(Buffer.from(image.data, "base64")).metadata();
    expect(meta.width).toBeLessThanOrEqual(1200);
    expect(meta.height).toBeLessThanOrEqual(1200);
    expect(image.mimeType).toBe("image/jpeg");
  }, 20_000);

  it("corrects mismatched jpeg mimeType", async () => {
    const jpeg = await sharp({
      create: {
        background: { b: 0, g: 0, r: 255 },
        channels: 3,
        height: 10,
        width: 10,
      },
    })
      .jpeg()
      .toBuffer();

    const blocks = [
      {
        data: jpeg.toString("base64"),
        mimeType: "image/png",
        type: "image" as const,
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    const image = getImageBlock(out);
    expect(image.mimeType).toBe("image/jpeg");
  });

  it("drops malformed image base64 payloads", async () => {
    const blocks = [
      {
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2N4j8AAAAASUVORK5CYII=" onerror="alert(1)',
        mimeType: "image/png",
        type: "image" as const,
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toEqual([
      {
        text: "[test] omitted image payload: invalid base64",
        type: "text",
      },
    ]);
  });
});
