import { describe, expect, it } from "vitest";
import { replaceManagedMarkdownBlock, withTrailingNewline } from "./memory-host-markdown.js";

describe("withTrailingNewline", () => {
  it("preserves trailing newlines", () => {
    expect(withTrailingNewline("hello\n")).toBe("hello\n");
  });

  it("adds a trailing newline when missing", () => {
    expect(withTrailingNewline("hello")).toBe("hello\n");
  });
});

describe("replaceManagedMarkdownBlock", () => {
  it("appends a managed block when missing", () => {
    expect(
      replaceManagedMarkdownBlock({
        body: "- first",
        endMarker: "<!-- end -->",
        heading: "## Generated",
        original: "# Title\n",
        startMarker: "<!-- start -->",
      }),
    ).toBe("# Title\n\n## Generated\n<!-- start -->\n- first\n<!-- end -->\n");
  });

  it("replaces an existing managed block in place", () => {
    expect(
      replaceManagedMarkdownBlock({
        body: "- new",
        endMarker: "<!-- end -->",
        heading: "## Generated",
        original:
          "# Title\n\n## Generated\n<!-- start -->\n- old\n<!-- end -->\n\n## Notes\nkept\n",
        startMarker: "<!-- start -->",
      }),
    ).toBe("# Title\n\n## Generated\n<!-- start -->\n- new\n<!-- end -->\n\n## Notes\nkept\n");
  });

  it("supports headingless blocks", () => {
    expect(
      replaceManagedMarkdownBlock({
        body: "beta",
        endMarker: "<!-- end -->",
        original: "alpha\n",
        startMarker: "<!-- start -->",
      }),
    ).toBe("alpha\n\n<!-- start -->\nbeta\n<!-- end -->\n");
  });
});
