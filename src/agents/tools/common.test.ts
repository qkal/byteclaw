import { describe, expect, test } from "vitest";
import { imageResult, parseAvailableTags } from "./common.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn8n0sAAAAASUVORK5CYII=";

describe("parseAvailableTags", () => {
  test("returns undefined for non-array inputs", () => {
    expect(parseAvailableTags(undefined)).toBeUndefined();
    expect(parseAvailableTags(null)).toBeUndefined();
    expect(parseAvailableTags("oops")).toBeUndefined();
  });

  test("drops entries without a string name and returns undefined when empty", () => {
    expect(parseAvailableTags([{ id: "1" }])).toBeUndefined();
    expect(parseAvailableTags([{ name: 123 }])).toBeUndefined();
  });

  test("keeps falsy ids and sanitizes emoji fields", () => {
    const result = parseAvailableTags([
      { emoji_id: null, id: "0", name: "General" },
      { emoji_name: "📚", id: "1", name: "Docs" },
      { emoji_id: 123, name: "Bad" },
    ]);
    expect(result).toEqual([
      { emoji_id: null, id: "0", name: "General" },
      { emoji_name: "📚", id: "1", name: "Docs" },
      { name: "Bad" },
    ]);
  });
});
describe("imageResult", () => {
  test("stores media delivery in details.media instead of MEDIA text", async () => {
    const result = await imageResult({
      base64: PNG_1X1_BASE64,
      label: "test:image",
      mimeType: "image/png",
      path: "/tmp/test.png",
    });

    expect(result.content).toEqual([
      {
        data: PNG_1X1_BASE64,
        mimeType: "image/png",
        type: "image",
      },
    ]);
    expect(result.details).toEqual({
      media: {
        mediaUrl: "/tmp/test.png",
      },
      path: "/tmp/test.png",
    });
  });

  test("keeps extra text without MEDIA text fallback", async () => {
    const result = await imageResult({
      base64: PNG_1X1_BASE64,
      extraText: "label text",
      label: "test:image",
      mimeType: "image/png",
      path: "/tmp/test.png",
    });

    expect(result.content?.[0]).toEqual({
      text: "label text",
      type: "text",
    });
    expect(result.content?.[1]).toEqual({
      data: PNG_1X1_BASE64,
      mimeType: "image/png",
      type: "image",
    });
    expect(JSON.stringify(result.content)).not.toContain("MEDIA:");
  });
});
