import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";
import {
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../../test-utils/secret-ref-test-vectors.js";
import { SecretInputSchema, SecretRefSchema } from "./schema/primitives.js";

describe("gateway protocol SecretRef schema", () => {
  const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateSecretRef = ajv.compile(SecretRefSchema);
  const validateSecretInput = ajv.compile(SecretInputSchema);

  it("accepts valid source-specific refs", () => {
    expect(validateSecretRef({ id: "OPENAI_API_KEY", provider: "default", source: "env" })).toBe(
      true,
    );
    expect(
      validateSecretRef({ id: "/providers/openai/apiKey", provider: "filemain", source: "file" }),
    ).toBe(true);
    for (const id of VALID_EXEC_SECRET_REF_IDS) {
      expect(validateSecretRef({ id, provider: "vault", source: "exec" }), id).toBe(true);
      expect(validateSecretInput({ id, provider: "vault", source: "exec" }), id).toBe(true);
    }
  });

  it("rejects invalid exec refs", () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      expect(validateSecretRef({ id, provider: "vault", source: "exec" }), id).toBe(false);
      expect(validateSecretInput({ id, provider: "vault", source: "exec" }), id).toBe(false);
    }
  });
});
