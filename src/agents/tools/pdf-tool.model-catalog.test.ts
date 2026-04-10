import { describe, expect, it } from "vitest";
import { modelSupportsDocument } from "../model-catalog.js";

describe("model catalog document support", () => {
  it("modelSupportsDocument returns true when input includes document", () => {
    expect(
      modelSupportsDocument({
        id: "test",
        input: ["text", "document"],
        name: "test",
        provider: "test",
      }),
    ).toBe(true);
  });

  it("modelSupportsDocument returns false when input lacks document", () => {
    expect(
      modelSupportsDocument({
        id: "test",
        input: ["text", "image"],
        name: "test",
        provider: "test",
      }),
    ).toBe(false);
  });

  it("modelSupportsDocument returns false for undefined entry", () => {
    expect(modelSupportsDocument(undefined)).toBe(false);
  });
});
