import { type ZodType, z } from "zod";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

const trimStringPreprocess = (value: unknown) => (typeof value === "string" ? value.trim() : value);

const trimLowercaseStringPreprocess = (value: unknown) =>
  normalizeOptionalLowercaseString(value) ?? value;

export const DeliveryModeFieldSchema = z
  .preprocess(trimLowercaseStringPreprocess, z.enum(["deliver", "announce", "none", "webhook"]))
  .transform((value) => (value === "deliver" ? "announce" : value));

export const LowercaseNonEmptyStringFieldSchema = z.preprocess(
  trimLowercaseStringPreprocess,
  z.string().min(1),
);

export const TrimmedNonEmptyStringFieldSchema = z.preprocess(
  trimStringPreprocess,
  z.string().min(1),
);

export const DeliveryThreadIdFieldSchema = z.union([
  TrimmedNonEmptyStringFieldSchema,
  z.number().finite(),
]);

export const TimeoutSecondsFieldSchema = z
  .number()
  .finite()
  .transform((value) => Math.max(0, Math.floor(value)));

export interface ParsedDeliveryInput {
  mode?: "announce" | "none" | "webhook";
  channel?: string;
  to?: string;
  threadId?: string | number;
  accountId?: string;
}

export function parseDeliveryInput(input: Record<string, unknown>): ParsedDeliveryInput {
  return {
    accountId: parseOptionalField(TrimmedNonEmptyStringFieldSchema, input.accountId),
    channel: parseOptionalField(LowercaseNonEmptyStringFieldSchema, input.channel),
    mode: parseOptionalField(DeliveryModeFieldSchema, input.mode),
    threadId: parseOptionalField(DeliveryThreadIdFieldSchema, input.threadId),
    to: parseOptionalField(TrimmedNonEmptyStringFieldSchema, input.to),
  };
}

export function parseOptionalField<T>(schema: ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
