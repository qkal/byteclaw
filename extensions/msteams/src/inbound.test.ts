import { describe, expect, it } from "vitest";
import {
  decodeHtmlEntities,
  extractMSTeamsQuoteInfo,
  htmlToPlainText,
  normalizeMSTeamsConversationId,
  parseMSTeamsActivityTimestamp,
  stripMSTeamsMentionTags,
  wasMSTeamsBotMentioned,
} from "./inbound.js";

describe("msteams inbound", () => {
  describe("stripMSTeamsMentionTags", () => {
    it("removes <at>...</at> tags and trims", () => {
      expect(stripMSTeamsMentionTags("<at>Bot</at> hi")).toBe("hi");
      expect(stripMSTeamsMentionTags("hi <at>Bot</at>")).toBe("hi");
    });

    it("removes <at ...> tags with attributes", () => {
      expect(stripMSTeamsMentionTags('<at id="1">Bot</at> hi')).toBe("hi");
      expect(stripMSTeamsMentionTags('hi <at itemid="2">Bot</at>')).toBe("hi");
    });
  });

  describe("normalizeMSTeamsConversationId", () => {
    it("strips the ;messageid suffix", () => {
      expect(normalizeMSTeamsConversationId("19:abc@thread.tacv2;messageid=deadbeef")).toBe(
        "19:abc@thread.tacv2",
      );
    });
  });

  describe("parseMSTeamsActivityTimestamp", () => {
    it("returns undefined for empty/invalid values", () => {
      expect(parseMSTeamsActivityTimestamp(undefined)).toBeUndefined();
      expect(parseMSTeamsActivityTimestamp("not-a-date")).toBeUndefined();
    });

    it("parses string timestamps", () => {
      const ts = parseMSTeamsActivityTimestamp("2024-01-01T00:00:00.000Z");
      if (!ts) {
        throw new Error("expected MSTeams timestamp parser to return a Date");
      }
      expect(ts.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    });

    it("passes through Date instances", () => {
      const d = new Date("2024-01-01T00:00:00.000Z");
      expect(parseMSTeamsActivityTimestamp(d)).toBe(d);
    });
  });

  describe("wasMSTeamsBotMentioned", () => {
    it("returns true when a mention entity matches recipient.id", () => {
      expect(
        wasMSTeamsBotMentioned({
          entities: [{ mentioned: { id: "bot" }, type: "mention" }],
          recipient: { id: "bot" },
        }),
      ).toBe(true);
    });

    it("returns false when there is no matching mention", () => {
      expect(
        wasMSTeamsBotMentioned({
          entities: [{ mentioned: { id: "other" }, type: "mention" }],
          recipient: { id: "bot" },
        }),
      ).toBe(false);
    });
  });

  describe("decodeHtmlEntities", () => {
    it("decodes common entities", () => {
      expect(decodeHtmlEntities("&amp;&lt;&gt;&quot;&#39;&#x27;&nbsp;")).toBe("&<>\"'' ");
    });

    it("leaves plain text unchanged", () => {
      expect(decodeHtmlEntities("hello world")).toBe("hello world");
    });

    it("prevents double-decoding: &amp;lt; should become &lt; not <", () => {
      // If &amp; were decoded first, &amp;lt; → &lt; → < (wrong).
      // With &amp; decoded last, &amp;lt; stays as &lt; (correct).
      expect(decodeHtmlEntities("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
    });
  });

  describe("htmlToPlainText", () => {
    it("strips tags and decodes entities", () => {
      expect(htmlToPlainText("<strong>Hello &amp; world</strong>")).toBe("Hello & world");
    });

    it("collapses whitespace from tag removal", () => {
      expect(htmlToPlainText("<p>foo</p><p>bar</p>")).toBe("foo bar");
    });

    it("trims leading and trailing whitespace", () => {
      expect(htmlToPlainText("  <span>hi</span>  ")).toBe("hi");
    });
  });

  describe("extractMSTeamsQuoteInfo", () => {
    const replyAttachment = (overrides?: { content?: string; contentType?: string }) => ({
      content:
        overrides?.content ??
        '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
          '<strong itemprop="mri">Alice</strong>' +
          '<p itemprop="copy">Hello world</p>' +
          "</blockquote>",
      contentType: overrides?.contentType ?? "text/html",
    });

    it("extracts sender and body from a Teams reply attachment", () => {
      const result = extractMSTeamsQuoteInfo([replyAttachment()]);
      expect(result).toEqual({ body: "Hello world", sender: "Alice" });
    });

    it("returns undefined for empty attachments array", () => {
      expect(extractMSTeamsQuoteInfo([])).toBeUndefined();
    });

    it("returns undefined when no reply blockquote is present", () => {
      expect(
        extractMSTeamsQuoteInfo([{ content: "<p>just a message</p>", contentType: "text/html" }]),
      ).toBeUndefined();
    });

    it("uses 'unknown' as sender when sender element is absent", () => {
      const result = extractMSTeamsQuoteInfo([
        {
          content:
            '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
            '<p itemprop="copy">quoted text</p>' +
            "</blockquote>",
          contentType: "text/html",
        },
      ]);
      expect(result).toEqual({ body: "quoted text", sender: "unknown" });
    });

    it("returns undefined when body element is absent", () => {
      const result = extractMSTeamsQuoteInfo([
        {
          content:
            '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
            '<strong itemprop="mri">Alice</strong>' +
            "</blockquote>",
          contentType: "text/html",
        },
      ]);
      expect(result).toBeUndefined();
    });

    it("decodes HTML entities in body text", () => {
      const result = extractMSTeamsQuoteInfo([
        {
          content:
            '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
            '<strong itemprop="mri">Bob</strong>' +
            '<p itemprop="copy">2 &lt; 3 &amp; 4 &gt; 1</p>' +
            "</blockquote>",
          contentType: "text/html",
        },
      ]);
      expect(result).toEqual({ body: "2 < 3 & 4 > 1", sender: "Bob" });
    });

    it("handles multiline body by collapsing whitespace", () => {
      const result = extractMSTeamsQuoteInfo([
        {
          content:
            '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
            '<strong itemprop="mri">Carol</strong>' +
            '<p itemprop="copy">line one\nline two</p>' +
            "</blockquote>",
          contentType: "text/html",
        },
      ]);
      expect(result?.body).toBe("line one line two");
    });

    it("skips non-string content values", () => {
      expect(
        extractMSTeamsQuoteInfo([{ content: { foo: "bar" }, contentType: "application/json" }]),
      ).toBeUndefined();
    });

    it("handles object content with .text property containing the reply HTML", () => {
      const htmlContent =
        '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
        '<strong itemprop="mri">Dave</strong>' +
        '<p itemprop="copy">hello from object</p>' +
        "</blockquote>";
      const result = extractMSTeamsQuoteInfo([
        { content: { text: htmlContent }, contentType: "text/html" },
      ]);
      expect(result).toEqual({ body: "hello from object", sender: "Dave" });
    });

    it("handles object content with .body property containing the reply HTML", () => {
      const htmlContent =
        '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
        '<strong itemprop="mri">Eve</strong>' +
        '<p itemprop="copy">hello from body field</p>' +
        "</blockquote>";
      const result = extractMSTeamsQuoteInfo([
        { content: { body: htmlContent }, contentType: "text/html" },
      ]);
      expect(result).toEqual({ body: "hello from body field", sender: "Eve" });
    });

    it("finds quote in second attachment when first has no quote", () => {
      const result = extractMSTeamsQuoteInfo([
        { content: "plain text", contentType: "text/plain" },
        replyAttachment(),
      ]);
      expect(result).toEqual({ body: "Hello world", sender: "Alice" });
    });
  });
});
