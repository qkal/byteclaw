import { describe, expect, it } from "vitest";
import {
  formatZalouserMessageSidFull,
  parseZalouserMessageSidFull,
  resolveZalouserMessageSid,
  resolveZalouserReactionMessageIds,
} from "./message-sid.js";

describe("zalouser message sid helpers", () => {
  it("parses MessageSidFull pairs", () => {
    expect(parseZalouserMessageSidFull("111:222")).toEqual({
      cliMsgId: "222",
      msgId: "111",
    });
    expect(parseZalouserMessageSidFull("111")).toBeNull();
    expect(parseZalouserMessageSidFull(undefined)).toBeNull();
  });

  it("resolves reaction ids from explicit params first", () => {
    expect(
      resolveZalouserReactionMessageIds({
        cliMsgId: "c-1",
        currentMessageId: "x:y",
        messageId: "m-1",
      }),
    ).toEqual({
      cliMsgId: "c-1",
      msgId: "m-1",
    });
  });

  it("resolves reaction ids from current message sid full", () => {
    expect(
      resolveZalouserReactionMessageIds({
        currentMessageId: "m-2:c-2",
      }),
    ).toEqual({
      cliMsgId: "c-2",
      msgId: "m-2",
    });
  });

  it("falls back to duplicated current id when no pair is available", () => {
    expect(
      resolveZalouserReactionMessageIds({
        currentMessageId: "solo",
      }),
    ).toEqual({
      cliMsgId: "solo",
      msgId: "solo",
    });
  });

  it("formats message sid fields for context payload", () => {
    expect(formatZalouserMessageSidFull({ cliMsgId: "2", msgId: "1" })).toBe("1:2");
    expect(formatZalouserMessageSidFull({ msgId: "1" })).toBe("1");
    expect(formatZalouserMessageSidFull({ cliMsgId: "2" })).toBe("2");
    expect(formatZalouserMessageSidFull({})).toBeUndefined();
  });

  it("resolves primary message sid with fallback timestamp", () => {
    expect(resolveZalouserMessageSid({ cliMsgId: "2", fallback: "t", msgId: "1" })).toBe("1");
    expect(resolveZalouserMessageSid({ cliMsgId: "2", fallback: "t" })).toBe("2");
    expect(resolveZalouserMessageSid({ fallback: "t" })).toBe("t");
  });
});
