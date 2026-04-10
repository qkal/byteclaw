import { describe, expect, it } from "vitest";
import {
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
  shouldIncludeSupplementalContext,
} from "./context-visibility.js";

describe("evaluateSupplementalContextVisibility", () => {
  it("reports why all mode keeps context", () => {
    expect(
      evaluateSupplementalContextVisibility({
        kind: "history",
        mode: "all",
        senderAllowed: false,
      }),
    ).toEqual({
      include: true,
      reason: "mode_all",
    });
  });

  it("reports quote override decisions", () => {
    expect(
      evaluateSupplementalContextVisibility({
        kind: "quote",
        mode: "allowlist_quote",
        senderAllowed: false,
      }),
    ).toEqual({
      include: true,
      reason: "quote_override",
    });
  });
});

describe("shouldIncludeSupplementalContext", () => {
  it("keeps all context in all mode", () => {
    expect(
      shouldIncludeSupplementalContext({
        kind: "history",
        mode: "all",
        senderAllowed: false,
      }),
    ).toBe(true);
  });

  it("enforces allowlist mode for non-allowlisted senders", () => {
    expect(
      shouldIncludeSupplementalContext({
        kind: "thread",
        mode: "allowlist",
        senderAllowed: false,
      }),
    ).toBe(false);
  });

  it("keeps explicit quotes in allowlist_quote mode", () => {
    expect(
      shouldIncludeSupplementalContext({
        kind: "quote",
        mode: "allowlist_quote",
        senderAllowed: false,
      }),
    ).toBe(true);
  });

  it("still drops non-quote context in allowlist_quote mode", () => {
    expect(
      shouldIncludeSupplementalContext({
        kind: "history",
        mode: "allowlist_quote",
        senderAllowed: false,
      }),
    ).toBe(false);
  });
});

describe("filterSupplementalContextItems", () => {
  it("filters blocked items and reports omission count", () => {
    const result = filterSupplementalContextItems({
      isSenderAllowed: (item) => item.senderAllowed,
      items: [
        { id: "allowed", senderAllowed: true },
        { id: "blocked", senderAllowed: false },
      ],
      kind: "thread",
      mode: "allowlist",
    });

    expect(result).toEqual({
      items: [{ id: "allowed", senderAllowed: true }],
      omitted: 1,
    });
  });
});
