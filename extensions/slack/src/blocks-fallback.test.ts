import { describe, expect, it } from "vitest";
import { buildSlackBlocksFallbackText } from "./blocks-fallback.js";

describe("buildSlackBlocksFallbackText", () => {
  it("prefers header text", () => {
    expect(
      buildSlackBlocksFallbackText([
        { text: { text: "Deploy status", type: "plain_text" }, type: "header" },
      ] as never),
    ).toBe("Deploy status");
  });

  it("uses image alt text", () => {
    expect(
      buildSlackBlocksFallbackText([
        { alt_text: "Latency chart", image_url: "https://example.com/image.png", type: "image" },
      ] as never),
    ).toBe("Latency chart");
  });

  it("uses generic defaults for file and unknown blocks", () => {
    expect(
      buildSlackBlocksFallbackText([
        { external_id: "F123", source: "remote", type: "file" },
      ] as never),
    ).toBe("Shared a file");
    expect(buildSlackBlocksFallbackText([{ type: "divider" }] as never)).toBe(
      "Shared a Block Kit message",
    );
  });
});
