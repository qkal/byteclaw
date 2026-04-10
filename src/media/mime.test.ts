import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { mediaKindFromMime } from "./constants.js";
import {
  detectMime,
  extensionForMime,
  imageMimeFromFormat,
  isAudioFileName,
  kindFromMime,
  normalizeMimeType,
} from "./mime.js";

async function makeOoxmlZip(opts: { mainMime: string; partPath: string }): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<Types><Override PartName="${opts.partPath}" ContentType="${opts.mainMime}.main+xml"/></Types>`,
  );
  zip.file(opts.partPath.slice(1), "<xml/>");
  return await zip.generateAsync({ type: "nodebuffer" });
}

describe("mime detection", () => {
  async function expectDetectedMime(params: {
    input: Parameters<typeof detectMime>[0];
    expected: string;
  }) {
    expect(await detectMime(params.input)).toBe(params.expected);
  }

  it.each([
    { expected: "image/jpeg", format: "jpg" },
    { expected: "image/jpeg", format: "jpeg" },
    { expected: "image/png", format: "png" },
    { expected: "image/webp", format: "webp" },
    { expected: "image/gif", format: "gif" },
    { expected: undefined, format: "unknown" },
  ])("maps $format image format", ({ format, expected }) => {
    expect(imageMimeFromFormat(format)).toBe(expected);
  });

  it.each([
    {
      expected: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      mainMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "detects docx from buffer",
      partPath: "/word/document.xml",
    },
    {
      expected: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      mainMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      name: "detects pptx from buffer",
      partPath: "/ppt/presentation.xml",
    },
  ] as const)("$name", async ({ mainMime, partPath, expected }) => {
    await expectDetectedMime({
      expected,
      input: {
        buffer: await makeOoxmlZip({ mainMime, partPath }),
        filePath: "/tmp/file.bin",
      },
    });
  });

  it.each([
    {
      expected: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      input: async () => {
        const zip = new JSZip();
        zip.file("hello.txt", "hi");
        return {
          buffer: await zip.generateAsync({ type: "nodebuffer" }),
          filePath: "/tmp/file.xlsx",
        };
      },
      name: "prefers extension mapping over generic zip",
    },
    {
      expected: "text/javascript",
      input: async () => ({
        filePath: "/tmp/a2ui.bundle.js",
      }),
      name: "uses extension mapping for JavaScript assets",
    },
  ] as const)("$name", async ({ input, expected }) => {
    await expectDetectedMime({
      expected,
      input: await input(),
    });
  });

  it("detects HTML files by extension (no magic bytes)", async () => {
    const buf = Buffer.from("<!DOCTYPE html><html><body>test</body></html>");
    const mime = await detectMime({ buffer: buf, filePath: "/tmp/report.html" });
    expect(mime).toBe("text/html");
  });

  it("detects .htm files by extension", async () => {
    const buf = Buffer.from("<html><body>test</body></html>");
    const mime = await detectMime({ buffer: buf, filePath: "/tmp/page.htm" });
    expect(mime).toBe("text/html");
  });

  it("detects XML files by extension", async () => {
    const mime = await detectMime({ filePath: "/tmp/data.xml" });
    expect(mime).toBe("text/xml");
  });

  it("detects CSS files by extension", async () => {
    const mime = await detectMime({ filePath: "/tmp/style.css" });
    expect(mime).toBe("text/css");
  });
});

describe("extensionForMime", () => {
  function expectMimeExtensionCase(
    mime: Parameters<typeof extensionForMime>[0],
    expected: ReturnType<typeof extensionForMime>,
  ) {
    expect(extensionForMime(mime)).toBe(expected);
  }

  it.each([
    { expected: ".jpg", mime: "image/jpeg" },
    { expected: ".png", mime: "image/png" },
    { expected: ".webp", mime: "image/webp" },
    { expected: ".gif", mime: "image/gif" },
    { expected: ".heic", mime: "image/heic" },
    { expected: ".mp3", mime: "audio/mpeg" },
    { expected: ".ogg", mime: "audio/ogg" },
    { expected: ".m4a", mime: "audio/x-m4a" },
    { expected: ".m4a", mime: "audio/mp4" },
    { expected: ".mp4", mime: "video/mp4" },
    { expected: ".mov", mime: "video/quicktime" },
    { expected: ".pdf", mime: "application/pdf" },
    { expected: ".txt", mime: "text/plain" },
    { expected: ".md", mime: "text/markdown" },
    { expected: ".html", mime: "text/html" },
    { expected: ".xml", mime: "text/xml" },
    { expected: ".css", mime: "text/css" },
    { expected: ".xml", mime: "application/xml" },
    { expected: ".jpg", mime: "IMAGE/JPEG" },
    { expected: ".m4a", mime: "Audio/X-M4A" },
    { expected: ".mov", mime: "Video/QuickTime" },
    { expected: undefined, mime: "video/unknown" },
    { expected: undefined, mime: "application/x-custom" },
    { expected: undefined, mime: null },
    { expected: undefined, mime: undefined },
  ] as const)("maps $mime to extension", ({ mime, expected }) => {
    expectMimeExtensionCase(mime, expected);
  });
});

describe("isAudioFileName", () => {
  function expectAudioFileNameCase(fileName: string, expected: boolean) {
    expect(isAudioFileName(fileName)).toBe(expected);
  }

  it.each([
    { expected: true, fileName: "voice.mp3" },
    { expected: true, fileName: "voice.caf" },
    { expected: false, fileName: "voice.bin" },
  ] as const)("matches audio extension for $fileName", ({ fileName, expected }) => {
    expectAudioFileNameCase(fileName, expected);
  });
});

describe("normalizeMimeType", () => {
  function expectNormalizedMimeCase(
    input: Parameters<typeof normalizeMimeType>[0],
    expected: ReturnType<typeof normalizeMimeType>,
  ) {
    expect(normalizeMimeType(input)).toBe(expected);
  }

  it.each([
    { expected: "audio/mp4", input: "Audio/MP4; codecs=mp4a.40.2" },
    { expected: undefined, input: "   " },
    { expected: undefined, input: null },
    { expected: undefined, input: undefined },
  ] as const)("normalizes $input", ({ input, expected }) => {
    expectNormalizedMimeCase(input, expected);
  });
});

describe("mediaKindFromMime", () => {
  function expectMediaKindCase(
    mime: Parameters<typeof mediaKindFromMime>[0],
    expected: ReturnType<typeof mediaKindFromMime>,
  ) {
    expect(mediaKindFromMime(mime)).toBe(expected);
  }

  function expectMimeKindCase(
    mime: Parameters<typeof kindFromMime>[0],
    expected: ReturnType<typeof kindFromMime>,
  ) {
    expect(kindFromMime(mime)).toBe(expected);
  }

  it.each([
    { expected: "document", mime: "text/plain" },
    { expected: "document", mime: "text/csv" },
    { expected: "document", mime: "text/html; charset=utf-8" },
    { expected: undefined, mime: "model/gltf+json" },
    { expected: undefined, mime: null },
    { expected: undefined, mime: undefined },
  ] as const)("classifies $mime", ({ mime, expected }) => {
    expectMediaKindCase(mime, expected);
  });

  it.each([
    { expected: "audio", mime: " Audio/Ogg; codecs=opus " },
    { expected: undefined, mime: undefined },
    { expected: undefined, mime: "model/gltf+json" },
  ] as const)("maps kindFromMime($mime) => $expected", ({ mime, expected }) => {
    expectMimeKindCase(mime, expected);
  });
});
