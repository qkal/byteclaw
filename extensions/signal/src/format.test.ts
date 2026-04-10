import { describe, expect, it } from "vitest";
import { markdownToSignalText } from "./format.js";

describe("markdownToSignalText", () => {
  it("renders inline styles", () => {
    const res = markdownToSignalText("hi _there_ **boss** ~~nope~~ `code`");

    expect(res.text).toBe("hi there boss nope code");
    expect(res.styles).toEqual([
      { length: 5, start: 3, style: "ITALIC" },
      { length: 4, start: 9, style: "BOLD" },
      { length: 4, start: 14, style: "STRIKETHROUGH" },
      { length: 4, start: 19, style: "MONOSPACE" },
    ]);
  });

  it("renders links as label plus url when needed", () => {
    const res = markdownToSignalText("see [docs](https://example.com) and https://example.com");

    expect(res.text).toBe("see docs (https://example.com) and https://example.com");
    expect(res.styles).toEqual([]);
  });

  it("keeps style offsets correct with multiple expanded links", () => {
    const markdown =
      "[first](https://example.com/first) **bold** [second](https://example.com/second)";
    const res = markdownToSignalText(markdown);

    const expectedText =
      "first (https://example.com/first) bold second (https://example.com/second)";

    expect(res.text).toBe(expectedText);
    expect(res.styles).toEqual([{ length: 4, start: expectedText.indexOf("bold"), style: "BOLD" }]);
  });

  it("applies spoiler styling", () => {
    const res = markdownToSignalText("hello ||secret|| world");

    expect(res.text).toBe("hello secret world");
    expect(res.styles).toEqual([{ length: 6, start: 6, style: "SPOILER" }]);
  });

  it("renders fenced code blocks with monospaced styles", () => {
    const res = markdownToSignalText("before\n\n```\nconst x = 1;\n```\n\nafter");

    const prefix = "before\n\n";
    const code = "const x = 1;\n";
    const suffix = "\nafter";

    expect(res.text).toBe(`${prefix}${code}${suffix}`);
    expect(res.styles).toEqual([{ length: code.length, start: prefix.length, style: "MONOSPACE" }]);
  });

  it("renders lists without extra block markup", () => {
    const res = markdownToSignalText("- one\n- two");

    expect(res.text).toBe("• one\n• two");
    expect(res.styles).toEqual([]);
  });

  it("uses UTF-16 code units for offsets", () => {
    const res = markdownToSignalText("😀 **bold**");

    const prefix = "😀 ";
    expect(res.text).toBe(`${prefix}bold`);
    expect(res.styles).toEqual([{ length: 4, start: prefix.length, style: "BOLD" }]);
  });

  describe("duplicate URL display", () => {
    it("does not duplicate URL for normalized equivalent labels", () => {
      const equivalentCases = [
        { expected: "selfh.st", input: "[selfh.st](http://selfh.st)" },
        { expected: "example.com", input: "[example.com](https://example.com)" },
        { expected: "www.example.com", input: "[www.example.com](https://example.com)" },
        { expected: "example.com", input: "[example.com](https://example.com/)" },
        { expected: "example.com", input: "[example.com](https://example.com///)" },
        { expected: "example.com", input: "[example.com](https://www.example.com)" },
        { expected: "EXAMPLE.COM", input: "[EXAMPLE.COM](https://example.com)" },
        { expected: "example.com/page", input: "[example.com/page](https://example.com/page)" },
      ] as const;

      for (const { input, expected } of equivalentCases) {
        const res = markdownToSignalText(input);
        expect(res.text).toBe(expected);
      }
    });

    it("still shows URL when label is meaningfully different", () => {
      const res = markdownToSignalText("[click here](https://example.com)");
      expect(res.text).toBe("click here (https://example.com)");
    });

    it("shows URL when the label is only the domain but the URL has a path", () => {
      const res = markdownToSignalText("[example.com](https://example.com/page)");
      expect(res.text).toBe("example.com (https://example.com/page)");
    });
  });

  describe("visual distinctions", () => {
    it("renders headings as bold text", () => {
      const res = markdownToSignalText("# Heading 1");
      expect(res.text).toBe("Heading 1");
      expect(res.styles).toContainEqual({ length: 9, start: 0, style: "BOLD" });
    });

    it("renders h2 headings as bold text", () => {
      const res = markdownToSignalText("## Heading 2");
      expect(res.text).toBe("Heading 2");
      expect(res.styles).toContainEqual({ length: 9, start: 0, style: "BOLD" });
    });

    it("renders h3 headings as bold text", () => {
      const res = markdownToSignalText("### Heading 3");
      expect(res.text).toBe("Heading 3");
      expect(res.styles).toContainEqual({ length: 9, start: 0, style: "BOLD" });
    });

    it("renders blockquotes with a visible prefix", () => {
      const res = markdownToSignalText("> This is a quote");
      expect(res.text).toMatch(/^[│>]/);
      expect(res.text).toContain("This is a quote");
    });

    it("renders multi-line blockquotes with a visible prefix", () => {
      const res = markdownToSignalText("> Line 1\n> Line 2");
      expect(res.text).toMatch(/^[│>]/);
      expect(res.text).toContain("Line 1");
      expect(res.text).toContain("Line 2");
    });

    it("renders horizontal rules as a visible separator", () => {
      const res = markdownToSignalText("Para 1\n\n---\n\nPara 2");
      expect(res.text).toMatch(/[─—-]{3,}/);
    });

    it("renders horizontal rules between content", () => {
      const res = markdownToSignalText("Above\n\n***\n\nBelow");
      expect(res.text).toContain("Above");
      expect(res.text).toContain("Below");
      expect(res.text).toMatch(/[─—-]{3,}/);
    });
  });
});
