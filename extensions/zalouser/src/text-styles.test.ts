import { describe, expect, it } from "vitest";
import { parseZalouserTextStyles } from "./text-styles.js";
import { TextStyle } from "./zca-constants.js";

describe("parseZalouserTextStyles", () => {
  it("renders inline markdown emphasis as Zalo style ranges", () => {
    expect(parseZalouserTextStyles("**bold** *italic* ~~strike~~")).toEqual({
      styles: [
        { len: 4, st: TextStyle.Bold, start: 0 },
        { len: 6, st: TextStyle.Italic, start: 5 },
        { len: 6, st: TextStyle.StrikeThrough, start: 12 },
      ],
      text: "bold italic strike",
    });
  });

  it("keeps inline code and plain math markers literal", () => {
    expect(parseZalouserTextStyles("before `inline *code*` after\n2 * 3 * 4")).toEqual({
      styles: [],
      text: "before `inline *code*` after\n2 * 3 * 4",
    });
  });

  it("preserves backslash escapes inside code spans and fenced code blocks", () => {
    expect(parseZalouserTextStyles("before `\\*` after\n```ts\n\\*\\_\\\\\n```")).toEqual({
      styles: [],
      text: "before `\\*` after\n\\*\\_\\\\",
    });
  });

  it("closes fenced code blocks when the input uses CRLF newlines", () => {
    expect(parseZalouserTextStyles("```\r\n*code*\r\n```\r\n**after**")).toEqual({
      styles: [{ len: 5, st: TextStyle.Bold, start: 7 }],
      text: "*code*\nafter",
    });
  });

  it("maps headings, block quotes, and lists into line styles", () => {
    expect(parseZalouserTextStyles(["# Title", "> quoted", "  - nested"].join("\n"))).toEqual({
      styles: [
        { len: 5, st: TextStyle.Bold, start: 0 },
        { len: 5, st: TextStyle.Big, start: 0 },
        { indentSize: 1, len: 6, st: TextStyle.Indent, start: 6 },
        { len: 6, st: TextStyle.UnorderedList, start: 13 },
      ],
      text: "Title\nquoted\nnested",
    });
  });

  it("treats 1-3 leading spaces as markdown padding for headings and lists", () => {
    expect(parseZalouserTextStyles("  # Title\n   1. item\n  - bullet")).toEqual({
      styles: [
        { len: 5, st: TextStyle.Bold, start: 0 },
        { len: 5, st: TextStyle.Big, start: 0 },
        { len: 4, st: TextStyle.OrderedList, start: 6 },
        { len: 6, st: TextStyle.UnorderedList, start: 11 },
      ],
      text: "Title\nitem\nbullet",
    });
  });

  it("strips fenced code markers and preserves leading indentation with nbsp", () => {
    expect(parseZalouserTextStyles("```ts\n  const x = 1\n\treturn x\n```")).toEqual({
      styles: [],
      text: "\u00A0\u00A0const x = 1\n\u00A0\u00A0\u00A0\u00A0return x",
    });
  });

  it("treats tilde fences as literal code blocks", () => {
    expect(parseZalouserTextStyles("~~~bash\n*cmd*\n~~~")).toEqual({
      styles: [],
      text: "*cmd*",
    });
  });

  it("treats fences indented under list items as literal code blocks", () => {
    expect(parseZalouserTextStyles("  ```\n*cmd*\n  ```")).toEqual({
      styles: [],
      text: "*cmd*",
    });
  });

  it("treats quoted backtick fences as literal code blocks", () => {
    expect(parseZalouserTextStyles("> ```js\n> *cmd*\n> ```")).toEqual({
      styles: [],
      text: "*cmd*",
    });
  });

  it("treats quoted tilde fences as literal code blocks", () => {
    expect(parseZalouserTextStyles("> ~~~\n> *cmd*\n> ~~~")).toEqual({
      styles: [],
      text: "*cmd*",
    });
  });

  it("preserves quote-prefixed lines inside normal fenced code blocks", () => {
    expect(parseZalouserTextStyles("```\n> prompt\n```")).toEqual({
      styles: [],
      text: "> prompt",
    });
  });

  it("does not treat quote-prefixed fence text inside code as a closing fence", () => {
    expect(parseZalouserTextStyles("```\n> ```\n*still code*\n```")).toEqual({
      styles: [],
      text: "> ```\n*still code*",
    });
  });

  it("treats indented blockquotes as quoted lines", () => {
    expect(parseZalouserTextStyles("  > quoted")).toEqual({
      styles: [{ indentSize: 1, len: 6, st: TextStyle.Indent, start: 0 }],
      text: "quoted",
    });
  });

  it("treats spaced nested blockquotes as deeper quoted lines", () => {
    expect(parseZalouserTextStyles("> > quoted")).toEqual({
      styles: [{ indentSize: 2, len: 6, st: TextStyle.Indent, start: 0 }],
      text: "quoted",
    });
  });

  it("treats indented quoted fences as literal code blocks", () => {
    expect(parseZalouserTextStyles("  > ```\n  > *cmd*\n  > ```")).toEqual({
      styles: [],
      text: "*cmd*",
    });
  });

  it("treats spaced nested quoted fences as literal code blocks", () => {
    expect(parseZalouserTextStyles("> > ```\n> > code\n> > ```")).toEqual({
      styles: [],
      text: "code",
    });
  });

  it("preserves inner quote markers inside quoted fenced code blocks", () => {
    expect(parseZalouserTextStyles("> ```\n>> prompt\n> ```")).toEqual({
      styles: [],
      text: "> prompt",
    });
  });

  it("keeps quote indentation on heading lines", () => {
    expect(parseZalouserTextStyles("> # Title")).toEqual({
      styles: [
        { len: 5, st: TextStyle.Bold, start: 0 },
        { len: 5, st: TextStyle.Big, start: 0 },
        { indentSize: 1, len: 5, st: TextStyle.Indent, start: 0 },
      ],
      text: "Title",
    });
  });

  it("keeps unmatched fences literal", () => {
    expect(parseZalouserTextStyles("```python")).toEqual({
      styles: [],
      text: "```python",
    });
  });

  it("keeps unclosed fenced blocks literal until eof", () => {
    expect(parseZalouserTextStyles("```python\n\\*not italic*\n_next_")).toEqual({
      styles: [],
      text: "```python\n\\*not italic*\n_next_",
    });
  });

  it("supports nested markdown and tag styles regardless of order", () => {
    expect(parseZalouserTextStyles("**{red}x{/red}** {red}**y**{/red}")).toEqual({
      styles: [
        { len: 1, st: TextStyle.Bold, start: 0 },
        { len: 1, st: TextStyle.Red, start: 0 },
        { len: 1, st: TextStyle.Red, start: 2 },
        { len: 1, st: TextStyle.Bold, start: 2 },
      ],
      text: "x y",
    });
  });

  it("treats small text tags as normal text", () => {
    expect(parseZalouserTextStyles("{small}tiny{/small}")).toEqual({
      styles: [],
      text: "tiny",
    });
  });

  it("keeps escaped markers literal", () => {
    expect(parseZalouserTextStyles(String.raw`\*literal\* \{underline}tag{/underline}`)).toEqual({
      styles: [],
      text: "*literal* {underline}tag{/underline}",
    });
  });

  it("keeps indented code blocks literal", () => {
    expect(parseZalouserTextStyles("    *cmd*")).toEqual({
      styles: [],
      text: "\u00A0\u00A0\u00A0\u00A0*cmd*",
    });
  });
});
