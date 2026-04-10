import { describe, expect, it } from "vitest";
import { parsePostContent } from "./post.js";

describe("parsePostContent", () => {
  it("renders title and styled text as markdown", () => {
    const content = JSON.stringify({
      content: [
        [
          { style: { bold: true }, tag: "text", text: "Bold" },
          { tag: "text", text: " " },
          { style: { italic: true }, tag: "text", text: "Italic" },
          { tag: "text", text: " " },
          { style: { underline: true }, tag: "text", text: "Underline" },
          { tag: "text", text: " " },
          { style: { strikethrough: true }, tag: "text", text: "Strike" },
          { tag: "text", text: " " },
          { style: { bold: true, code: true }, tag: "text", text: "Code" },
        ],
      ],
      title: "Daily *Plan*",
    });

    const result = parsePostContent(content);

    expect(result.textContent).toBe(
      "Daily \\*Plan\\*\n\n**Bold** *Italic* <u>Underline</u> ~~Strike~~ `Code`",
    );
    expect(result.imageKeys).toEqual([]);
    expect(result.mentionedOpenIds).toEqual([]);
  });

  it("renders links and mentions", () => {
    const content = JSON.stringify({
      content: [
        [
          { href: "https://example.com/guide(a)", tag: "a", text: "Docs [v2]" },
          { tag: "text", text: " " },
          { tag: "at", user_name: "alice_bob" },
          { tag: "text", text: " " },
          { open_id: "ou_123", tag: "at" },
          { tag: "text", text: " " },
          { href: "https://example.com/no-text", tag: "a" },
        ],
      ],
      title: "",
    });

    const result = parsePostContent(content);

    expect(result.textContent).toBe(
      String.raw`[Docs \[v2\]](https://example.com/guide(a)) @alice\_bob @ou\_123 [https://example.com/no\-text](https://example.com/no-text)`,
    );
    expect(result.mentionedOpenIds).toEqual(["ou_123"]);
  });

  it("inserts image placeholders and collects image keys", () => {
    const content = JSON.stringify({
      content: [
        [
          { tag: "text", text: "Before " },
          { image_key: "img_1", tag: "img" },
          { tag: "text", text: " after" },
        ],
        [{ image_key: "img_2", tag: "img" }],
      ],
      title: "",
    });

    const result = parsePostContent(content);

    expect(result.textContent).toBe("Before ![image] after\n![image]");
    expect(result.imageKeys).toEqual(["img_1", "img_2"]);
    expect(result.mentionedOpenIds).toEqual([]);
  });

  it("supports locale wrappers", () => {
    const wrappedByPost = JSON.stringify({
      post: {
        zh_cn: {
          content: [[{ tag: "text", text: "内容A" }]],
          title: "标题",
        },
      },
    });
    const wrappedByLocale = JSON.stringify({
      zh_cn: {
        content: [[{ tag: "text", text: "内容B" }]],
        title: "标题",
      },
    });

    expect(parsePostContent(wrappedByPost)).toEqual({
      imageKeys: [],
      mediaKeys: [],
      mentionedOpenIds: [],
      textContent: "标题\n\n内容A",
    });
    expect(parsePostContent(wrappedByLocale)).toEqual({
      imageKeys: [],
      mediaKeys: [],
      mentionedOpenIds: [],
      textContent: "标题\n\n内容B",
    });
  });
});
