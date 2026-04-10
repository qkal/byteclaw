/**
 * Production-grade environment variable validation.
 * Ensures all required environment variables are present and properly typed.
 */

export interface EnvVarSpec {
  name: string;
  required: boolean;
  type: 'string' | 'number' | 'boolean' | 'url' | 'email' | 'port';
  defaultValue?: string | number | boolean;
  validator?: (value: string) => boolean;
  description?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ name: string; message: string }>;
  warnings: Array<{ name: string; message: string }>;
  env: Record<string, string | number | boolean>;
}

class EnvValidationError extends Error {
  constructor(public readonly validationErrors: Array<{ name: string; message: string }>) {
    const messages = validationErrors.map(e => `${e.name}: ${e.message}`).join('\n');
    super(`Environment validation failed:\n${messages}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validate environment variables against specifications.
 */
export function validateEnv(specs: EnvVarSpec[]): ValidationResult {
  const errors: Array<{ name: string; message: string }> = [];
  const warnings: Array<{ name: string; message: string }> = [];
  const env: Record<string, string | number | boolean> = {};

  for (const spec of specs) {
    const value = process.env[spec.name];
    
    if (value === undefined) {
      if (spec.required) {
        errors.push({ name: spec.name, message: 'Required environment variable is missing' });
      } else if (spec.defaultValue !== undefined) {
        env[spec.name] = spec.defaultValue;
      }
      continue;
    }

    // Type validation
    const typedValue = parseEnvValue(value, spec.type, spec.name);
    if (typedValue === null) {
      errors.push({ name: spec.name, message: `Invalid ${spec.type} value` });
      continue;
    }

    // Custom validation
    if (spec.validator && !spec.validator(value)) {
      errors.push({ name: spec.name, message: 'Custom validation failed' });
      continue;
    }

    env[spec.name] = typedValue;
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    env,
  };
}

/**
 * Validate environment and throw if invalid.
 */
export function validateEnvOrThrow(specs: EnvVarSpec[]): Record<string, string | number | boolean> {
  const result = validateEnv(specs);
  if (!result.valid) {
    throw new EnvValidationError(result.errors);
  }
  return result.env;
}

/**
 * Parse environment value based on type.
 */
function parseEnvValue(value: string, type: EnvVarSpec['type'], name: string): string | number | boolean | null {
  switch (type) {
    case 'string':
      return value;
    
    case 'number':
      const num = Number(value);
      return isNaN(num) ? null : num;
    
    case 'boolean':
      if (value.toLowerCase() === 'true' || value === '1') return true;
      if (value.toLowerCase() === 'false' || value === '0') return false;
      return null;
    
    case 'url':
      try {
        new URL(value);
        return value;
      } catch {
        return null;
      }
    
    case 'email':
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return emailRegex.test(value) ? value : null;
    
    case 'port':
      const port = Number(value);
      return (Number.isInteger(port) && port >= 1 && port <= 65535) ? port : null;
    
    default:
      return null;
  }
}

/**
 * Common environment variable specifications.
 */
export const COMMON_ENV_SPECS: EnvVarSpec[] = [
  {
    name: 'NODE_ENV',
    required: false,
    type: 'string',
    defaultValue: 'production',
    description: 'Node environment (development, production, test)',
    validator: (value) => ['development', 'production', 'test'].includes(value),
  },
  {
    name: 'PORT',
    required: false,
    type: 'port',
    defaultValue: 3000,
    description: 'Server port',
  },
  {
    name: 'LOG_LEVEL',
    required: false,
    type: 'string',
    defaultValue: 'info',
    description: 'Logging level',
    validator: (value) => ['debug', 'info', 'warn', 'error'].includes(value),
  },
];

/**
 * Get validated common environment variables.
 */
export function getCommonEnv(): Record<string, string | number | boolean> {
  return validateEnvOrThrow(COMMON_ENV_SPECS);
}
