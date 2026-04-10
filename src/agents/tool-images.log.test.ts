import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { infoMock, warnMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => {
  const makeLogger = () => ({
    child: () => makeLogger(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: infoMock,
    isEnabled: () => true,
    raw: vi.fn(),
    subsystem: "agents/tool-images",
    trace: vi.fn(),
    warn: warnMock,
  });
  return { createSubsystemLogger: () => makeLogger() };
});

import { sanitizeContentBlocksImages } from "./tool-images.js";

async function createLargePng(): Promise<Buffer> {
  const width = 2400;
  const height = 680;
  const raw = Buffer.alloc(width * height * 3, 0x7f);
  return await sharp(raw, {
    raw: { channels: 3, height, width },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

describe("tool-images log context", () => {
  beforeEach(() => {
    infoMock.mockClear();
    warnMock.mockClear();
  });

  it("includes filename from MEDIA text", async () => {
    const png = await createLargePng();
    const blocks = [
      { text: "MEDIA:/tmp/snapshots/camera-front.png", type: "text" as const },
      { data: png.toString("base64"), mimeType: "image/png", type: "image" as const },
    ];
    await sanitizeContentBlocksImages(blocks, "nodes:camera_snap");
    const messages = infoMock.mock.calls.map((call) => String(call[0] ?? ""));
    expect(messages.some((message) => message.includes("camera-front.png"))).toBe(true);
  });

  it("includes filename from read label", async () => {
    const png = await createLargePng();
    const blocks = [
      { data: png.toString("base64"), mimeType: "image/png", type: "image" as const },
    ];
    await sanitizeContentBlocksImages(blocks, "read:/tmp/images/sample-diagram.png");
    const messages = infoMock.mock.calls.map((call) => String(call[0] ?? ""));
    expect(messages.some((message) => message.includes("sample-diagram.png"))).toBe(true);
  });
});
