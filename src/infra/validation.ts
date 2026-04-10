/**
 * Centralized Zod Validation Layer
 * Provides reusable validation schemas and utilities
 */

import { z } from "zod";

/**
 * Common validation schemas
 */
export const commonSchemas = {
  // String validations
  nonEmptyString: z.string().min(1),
  apiKey: z.string().min(16),
  token: z.string().min(32),

  // Numeric validations
  port: z.number().int().min(1024).max(65_535),
  timeout: z.number().int().min(0).max(600_000), // Max 10 minutes
  percentage: z.number().min(0).max(100),

  // URL validations
  url: z.string().url(),
  httpUrl: z
    .string()
    .url()
    .refine((url) => url.startsWith("http://") || url.startsWith("https://")),

  // Boolean string transformations
  booleanString: z.string().transform((val) => val === "1" || val.toLowerCase() === "true"),

  // Array validations
  nonEmptyArray: z.array(z.any()).min(1),

  // Object ID validations
  objectId: z.string().regex(/^[a-f0-9]{24}$/),

  // Email validation
  email: z.string().email(),
};

/**
 * Gateway configuration validation schema
 */
export const gatewayConfigSchema = z.object({
  cors: z
    .object({
      credentials: z.boolean().optional(),
      origin: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .optional(),
  host: z.string().optional(),
  password: z.string().min(16).optional(),
  port: commonSchemas.port.optional(),
  token: commonSchemas.token.optional(),
});

/**
 * API configuration validation schema
 */
export const apiConfigSchema = z.object({
  apiKey: commonSchemas.apiKey.optional(),
  baseUrl: commonSchemas.httpUrl.optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  model: z.string().min(1),
  provider: z.enum(["openai", "anthropic", "gemini", "openrouter", "custom"]),
  timeout: commonSchemas.timeout.optional(),
});

/**
 * Channel configuration validation schema
 */
export const channelConfigSchema = z.object({
  config: z.record(z.any()).optional(),
  enabled: z.boolean(),
  type: z.string().min(1),
});

/**
 * Request validation schema
 */
export const requestSchema = z.object({
  body: z.any().optional(),
  headers: z.record(z.string()).optional(),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
  timeout: commonSchemas.timeout.optional(),
  url: commonSchemas.httpUrl,
});

/**
 * Response validation schema
 */
export const responseSchema = z.object({
  body: z.any().optional(),
  headers: z.record(z.string()).optional(),
  status: z.number().int().min(100).max(599),
});

/**
 * Validate data against schema with detailed error reporting
 */
export function validate<T>(schema: z.ZodSchema<T>, data: unknown, context?: string): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    const errors = result.error.errors.map((err) => ({
      code: err.code,
      message: err.message,
      path: err.path.join("."),
    }));

    const errorMessage = context
      ? `Validation failed for ${context}: ${JSON.stringify(errors, null, 2)}`
      : `Validation failed: ${JSON.stringify(errors, null, 2)}`;

    throw new ValidationError(errorMessage, errors);
  }

  return result.data;
}

/**
 * Validation error class
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public errors: { path: string; message: string; code: string }[],
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Sanitize input by removing potentially dangerous content
 */
export function sanitizeInput(input: string): string {
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/on\w+\s*=/gi, "");
}

/**
 * Validate and sanitize object properties
 */
export function sanitizeObject<T extends Record<string, unknown>>(obj: T, keys: (keyof T)[]): T {
  const sanitized = { ...obj };

  for (const key of keys) {
    if (typeof sanitized[key] === "string") {
      sanitized[key] = sanitizeInput(sanitized[key] as string) as T[keyof T];
    }
  }

  return sanitized;
}

/**
 * Create a validator function from schema
 */
export function createValidator<T>(schema: z.ZodSchema<T>, context?: string) {
  return (data: unknown): T => validate(schema, data, context);
}
