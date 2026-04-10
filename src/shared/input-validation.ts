/**
 * Production-grade centralized input validation.
 * Provides type-safe validation with detailed error reporting.
 */

export interface ValidationRule<T = unknown> {
  name: string;
  validate: (value: T) => boolean;
  message?: string;
}

export interface ValidationResult<T = unknown> {
  valid: boolean;
  value?: T;
  errors: string[];
}

export class ValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join("; "));
    this.name = "ValidationError";
  }
}

/**
 * Validate a value against a set of rules.
 */
export function validate<T>(value: T, rules: ValidationRule<T>[]): ValidationResult<T> {
  const errors: string[] = [];

  for (const rule of rules) {
    if (!rule.validate(value)) {
      errors.push(rule.message ?? `Validation failed for rule: ${rule.name}`);
    }
  }

  return {
    valid: errors.length === 0,
    value: errors.length === 0 ? value : undefined,
    errors,
  };
}

/**
 * Validate and throw if invalid.
 */
export function validateOrThrow<T>(value: T, rules: ValidationRule<T>[]): T {
  const result = validate(value, rules);
  if (!result.valid) {
    throw new ValidationError(result.errors);
  }
  return value;
}

/**
 * Common validation rules.
 */
export const ValidationRules = {
  required: <T>(value: T): boolean => value !== null && value !== undefined,

  string: (value: unknown): value is string => typeof value === "string",

  number: (value: unknown): value is number => typeof value === "number" && !isNaN(value),

  boolean: (value: unknown): value is boolean => typeof value === "boolean",

  email: (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),

  url: (value: string): boolean => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  },

  minLength:
    (min: number) =>
    (value: string): boolean =>
      value.length >= min,

  maxLength:
    (max: number) =>
    (value: string): boolean =>
      value.length <= max,

  minValue:
    (min: number) =>
    (value: number): boolean =>
      value >= min,

  maxValue:
    (max: number) =>
    (value: number): boolean =>
      value <= max,

  pattern:
    (regex: RegExp) =>
    (value: string): boolean =>
      regex.test(value),

  enum:
    <T extends readonly string[]>(values: T) =>
    (value: string): value is T[number] =>
      values.includes(value as T[number]),

  uuid: (value: string): boolean =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),

  alpha: (value: string): boolean => /^[a-zA-Z]+$/.test(value),

  alphanumeric: (value: string): boolean => /^[a-zA-Z0-9]+$/.test(value),

  date: (value: string): boolean => !isNaN(Date.parse(value)),

  port: (value: number): boolean => Number.isInteger(value) && value >= 1 && value <= 65535,

  positive: (value: number): boolean => value > 0,

  nonNegative: (value: number): boolean => value >= 0,
} as const;

/**
 * Schema-based validation for objects.
 */
export class Schema<T extends Record<string, unknown>> {
  constructor(private rules: Record<keyof T, ValidationRule[]>) {}

  validate(data: Record<string, unknown>): ValidationResult<T> {
    const errors: string[] = [];
    const validated: Partial<T> = {};

    for (const [key, rules] of Object.entries(this.rules)) {
      const value = data[key];
      const result = validate(value, rules);

      if (!result.valid) {
        errors.push(...result.errors.map((e) => `${String(key)}: ${e}`));
      } else {
        validated[key as keyof T] = result.value as T[keyof T];
      }
    }

    return {
      valid: errors.length === 0,
      value: errors.length === 0 ? (validated as T) : undefined,
      errors,
    };
  }

  validateOrThrow(data: Record<string, unknown>): T {
    const result = this.validate(data);
    if (!result.valid) {
      throw new ValidationError(result.errors);
    }
    return result.value!;
  }
}
