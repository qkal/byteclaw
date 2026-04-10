import process from "node:process";
import { z } from "zod";

/**
 * Environment variable validation schema
 * Validates all critical environment variables at startup
 */
const envSchema = z.object({
  // Gateway security
  OPENCLAW_GATEWAY_TOKEN: z.string().min(32).optional(),
  OPENCLAW_GATEWAY_PASSWORD: z.string().min(16).optional(),
  OPENCLAW_GATEWAY_PORT: z.string().regex(/^\d+$/).transform(Number).optional(),
  OPENCLAW_GATEWAY_HOST: z.string().optional(),

  // API Keys (at least one required for operation)
  OPENAI_API_KEY: z.string().startsWith("sk-").optional(),
  ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-").optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),

  // Paths
  OPENCLAW_STATE_DIR: z.string().optional(),
  OPENCLAW_CONFIG_PATH: z.string().optional(),
  OPENCLAW_HOME: z.string().optional(),

  // Feature flags
  OPENCLAW_SKIP_CHANNELS: z
    .string()
    .transform((v) => v === "1")
    .optional(),
  OPENCLAW_LOAD_SHELL_ENV: z
    .string()
    .transform((v) => v === "1")
    .optional(),
  OPENCLAW_SHELL_ENV_TIMEOUT_MS: z.string().regex(/^\d+$/).transform(Number).optional(),

  // Security
  NODE_DISABLE_COMPILE_CACHE: z
    .string()
    .transform((v) => v === "1")
    .optional(),
  OPENCLAW_AUTH_STORE_READONLY: z
    .string()
    .transform((v) => v === "1")
    .optional(),

  // Node.js Permission Model support
  OPENCLAW_ENABLE_PERMISSIONS: z
    .string()
    .transform((v) => v === "1")
    .optional(),
  OPENCLAW_ALLOW_FS_READ: z.string().optional(),
  OPENCLAW_ALLOW_FS_WRITE: z.string().optional(),
  OPENCLAW_ALLOW_CHILD_PROCESS: z
    .string()
    .transform((v) => v === "1")
    .optional(),
  OPENCLAW_ALLOW_WORKER_THREADS: z
    .string()
    .transform((v) => v === "1")
    .optional(),
});

export type ValidatedEnv = z.infer<typeof envSchema>;

/**
 * Validation errors with severity levels
 */
export interface ValidationError {
  severity: "error" | "warning";
  key: string;
  message: string;
}

/**
 * Validate environment variables at startup
 * Returns validation errors if any, throws if critical errors exist
 */
export function validateEnv(): ValidationError[] {
  const errors: ValidationError[] = [];

  try {
    // Validate against schema
    const result = envSchema.safeParse(process.env);

    if (!result.success) {
      for (const error of result.error.errors) {
        errors.push({
          key: error.path.join("."),
          message: error.message,
          severity: "error",
        });
      }
    }

    // Additional business logic validations

    // Check if at least one API key is configured (warning, not error)
    const hasApiKey =
      process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY;

    if (!hasApiKey) {
      errors.push({
        key: "API_KEYS",
        message: "No API key configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY.",
        severity: "warning",
      });
    }

    // Check gateway security
    const hasGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    const hasGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    const gatewayHost = process.env.OPENCLAW_GATEWAY_HOST;

    if (
      gatewayHost &&
      gatewayHost !== "127.0.0.1" &&
      gatewayHost !== "localhost" &&
      !hasGatewayToken &&
      !hasGatewayPassword
    ) {
      errors.push({
        key: "GATEWAY_SECURITY",
        message:
          "Gateway exposed beyond localhost requires authentication (OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD).",
        severity: "error",
      });
    }

    // Check port validity
    const port = process.env.OPENCLAW_GATEWAY_PORT
      ? Number.parseInt(process.env.OPENCLAW_GATEWAY_PORT, 10)
      : null;
    if (port && (port < 1024 || port > 65_535)) {
      errors.push({
        key: "OPENCLAW_GATEWAY_PORT",
        message: `Port ${port} is invalid. Use a port between 1024 and 65535.`,
        severity: "error",
      });
    }

    // Check shell env timeout
    const shellTimeout = process.env.OPENCLAW_SHELL_ENV_TIMEOUT_MS
      ? Number.parseInt(process.env.OPENCLAW_SHELL_ENV_TIMEOUT_MS, 10)
      : null;
    if (shellTimeout && (shellTimeout < 1000 || shellTimeout > 60_000)) {
      errors.push({
        key: "OPENCLAW_SHELL_ENV_TIMEOUT_MS",
        message: `Shell env timeout ${shellTimeout}ms is outside recommended range (1000-60000ms).`,
        severity: "warning",
      });
    }

    // Check Node.js Permission Model compatibility
    if (process.env.OPENCLAW_ENABLE_PERMISSIONS === "1") {
      if (!process.execArgv.includes("--permission")) {
        errors.push({
          key: "OPENCLAW_ENABLE_PERMISSIONS",
          message:
            "OPENCLAW_ENABLE_PERMISSIONS is set but Node.js was not started with --permission flag.",
          severity: "warning",
        });
      }
    }
  } catch (error) {
    errors.push({
      key: "VALIDATION_ERROR",
      message: `Unexpected validation error: ${error instanceof Error ? error.message : String(error)}`,
      severity: "error",
    });
  }

  return errors;
}

/**
 * Print validation errors to console
 */
export function printValidationErrors(errors: ValidationError[]): void {
  if (errors.length === 0) {
    return;
  }

  const errorCount = errors.filter((e) => e.severity === "error").length;
  const warningCount = errors.filter((e) => e.severity === "warning").length;

  console.error("[openclaw] Environment validation results:");
  console.error(`  Errors: ${errorCount}, Warnings: ${warningCount}`);

  for (const error of errors) {
    const prefix = error.severity === "error" ? "  ✗" : "  ⚠";
    console.error(`${prefix} ${error.key}: ${error.message}`);
  }
}

/**
 * Validate environment and throw if critical errors exist
 */
export function validateEnvOrThrow(): void {
  const errors = validateEnv();
  printValidationErrors(errors);

  const criticalErrors = errors.filter((e) => e.severity === "error");
  if (criticalErrors.length > 0) {
    throw new Error(`Environment validation failed with ${criticalErrors.length} error(s)`);
  }
}
