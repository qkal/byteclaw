import { describe, expect, it } from "vitest";
import {
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../test-utils/secret-ref-test-vectors.js";
import { buildSecretInputSchema } from "./secret-input-schema.js";
import {
  buildOptionalSecretInputSchema,
  buildSecretInputArraySchema,
  normalizeSecretInputString,
} from "./secret-input.js";

describe("plugin-sdk secret input helpers", () => {
  it.each([
    {
      expected: true,
      name: "accepts undefined for optional secret input",
      run: () => buildOptionalSecretInputSchema().safeParse(undefined).success,
    },
    {
      expected: true,
      name: "accepts arrays of secret inputs",
      run: () =>
        buildSecretInputArraySchema().safeParse([
          "sk-plain",
          { id: "OPENAI_API_KEY", provider: "default", source: "env" },
        ]).success,
    },
    {
      expected: "sk-test",
      name: "normalizes plaintext secret strings",
      run: () => normalizeSecretInputString("  sk-test  "),
    },
  ])("$name", ({ run, expected }) => {
    expect(run()).toEqual(expected);
  });
});

describe("plugin-sdk secret input schema", () => {
  const schema = buildSecretInputSchema();

  it("accepts plaintext and valid refs", () => {
    expect(schema.safeParse("sk-plain").success).toBe(true);
    expect(
      schema.safeParse({ id: "OPENAI_API_KEY", provider: "default", source: "env" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ id: "/providers/openai/apiKey", provider: "filemain", source: "file" })
        .success,
    ).toBe(true);
    for (const id of VALID_EXEC_SECRET_REF_IDS) {
      expect(schema.safeParse({ id, provider: "vault", source: "exec" }).success, id).toBe(true);
    }
  });

  it("rejects invalid exec refs", () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      expect(schema.safeParse({ id, provider: "vault", source: "exec" }).success, id).toBe(false);
    }
  });
});
