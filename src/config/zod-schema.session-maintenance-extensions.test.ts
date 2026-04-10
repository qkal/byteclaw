import { describe, expect, it } from "vitest";
import { SessionSchema } from "./zod-schema.session.js";

describe("SessionSchema maintenance extensions", () => {
  it("accepts valid maintenance extensions", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          highWaterBytes: "350mb",
          maxDiskBytes: "500mb",
          resetArchiveRetention: "14d",
        },
      }),
    ).not.toThrow();
  });

  it("accepts parentForkMaxTokens including 0 to disable the guard", () => {
    expect(() => SessionSchema.parse({ parentForkMaxTokens: 100_000 })).not.toThrow();
    expect(() => SessionSchema.parse({ parentForkMaxTokens: 0 })).not.toThrow();
  });

  it("rejects negative parentForkMaxTokens", () => {
    expect(() =>
      SessionSchema.parse({
        parentForkMaxTokens: -1,
      }),
    ).toThrow(/parentForkMaxTokens/i);
  });

  it("accepts disabling reset archive cleanup", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          resetArchiveRetention: false,
        },
      }),
    ).not.toThrow();
  });

  it("rejects invalid maintenance extension values", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          resetArchiveRetention: "never",
        },
      }),
    ).toThrow(/resetArchiveRetention|duration/i);

    expect(() =>
      SessionSchema.parse({
        maintenance: {
          maxDiskBytes: "big",
        },
      }),
    ).toThrow(/maxDiskBytes|size/i);
  });
});
