import { z } from "zod";
import { ENV_SECRET_REF_ID_RE } from "../config/types.secrets.js";
import { sensitive } from "../config/zod-schema.sensitive.js";
import {
  SECRET_PROVIDER_ALIAS_PATTERN,
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidFileSecretRefId,
} from "../secrets/ref-contract.js";

export function buildSecretInputSchema() {
  return secretInputSchema;
}

const providerSchema = z
  .string()
  .regex(
    SECRET_PROVIDER_ALIAS_PATTERN,
    'Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").',
  );

// Singleton registered with the sensitive registry so that mapSensitivePaths
// Marks every config field using this schema as sensitive (redacted).
const secretInputSchema = z
  .union([
    z.string(),
    z.discriminatedUnion("source", [
      z.object({
        id: z
          .string()
          .regex(
            ENV_SECRET_REF_ID_RE,
            'Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: "OPENAI_API_KEY").',
          ),
        provider: providerSchema,
        source: z.literal("env"),
      }),
      z.object({
        id: z
          .string()
          .refine(
            isValidFileSecretRefId,
            'File secret reference id must be an absolute JSON pointer (example: "/providers/openai/apiKey"), or "value" for singleValue mode.',
          ),
        provider: providerSchema,
        source: z.literal("file"),
      }),
      z.object({
        id: z.string().refine(isValidExecSecretRefId, formatExecSecretRefIdValidationMessage()),
        provider: providerSchema,
        source: z.literal("exec"),
      }),
    ]),
  ])
  .register(sensitive);
