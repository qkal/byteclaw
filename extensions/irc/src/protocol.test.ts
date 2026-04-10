import { describe, expect, it } from "vitest";
import {
  parseIrcLine,
  parseIrcPrefix,
  sanitizeIrcOutboundText,
  sanitizeIrcTarget,
  splitIrcText,
} from "./protocol.js";

describe("irc protocol", () => {
  it("parses PRIVMSG lines with prefix and trailing", () => {
    const parsed = parseIrcLine(":alice!u@host PRIVMSG #room :hello world");
    expect(parsed).toEqual({
      command: "PRIVMSG",
      params: ["#room"],
      prefix: "alice!u@host",
      raw: ":alice!u@host PRIVMSG #room :hello world",
      trailing: "hello world",
    });

    expect(parseIrcPrefix(parsed?.prefix)).toEqual({
      host: "host",
      nick: "alice",
      user: "u",
    });
  });

  it("sanitizes outbound text to prevent command injection", () => {
    expect(sanitizeIrcOutboundText(String.raw`hello\r\nJOIN #oops`)).toBe("hello JOIN #oops");
    expect(sanitizeIrcOutboundText(String.raw`\u0001test\u0000`)).toBe("test");
  });

  it("validates targets and rejects control characters", () => {
    expect(sanitizeIrcTarget("#openclaw")).toBe("#openclaw");
    expect(() => sanitizeIrcTarget(String.raw`#bad\nPING`)).toThrow(/Invalid IRC target/);
    expect(() => sanitizeIrcTarget(" user")).toThrow(/Invalid IRC target/);
  });

  it("splits long text on boundaries", () => {
    const chunks = splitIrcText("a ".repeat(300), 120);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 120)).toBe(true);
  });
});
