import { describe, expect, it } from "vitest";
import {
  COMMON_ENV_SPECS,
  getCommonEnv,
  validateEnv,
  validateEnvOrThrow,
  type EnvVarSpec,
} from "./env-validation.js";

describe("env-validation", () => {
  it("validates required environment variables", () => {
    const specs: EnvVarSpec[] = [
      { name: "REQUIRED_VAR", required: true, type: "string" },
    ];
    process.env.REQUIRED_VAR = "test";
    const result = validateEnv(specs);
    expect(result.valid).toBe(true);
    delete process.env.REQUIRED_VAR;
  });

  it("fails on missing required variables", () => {
    const specs: EnvVarSpec[] = [
      { name: "MISSING_VAR", required: true, type: "string" },
    ];
    const result = validateEnv(specs);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("uses default values for optional variables", () => {
    const specs: EnvVarSpec[] = [
      { name: "OPTIONAL_VAR", required: false, type: "string", defaultValue: "default" },
    ];
    const result = validateEnv(specs);
    expect(result.env.OPTIONAL_VAR).toBe("default");
  });

  it("validates number types", () => {
    const specs: EnvVarSpec[] = [
      { name: "NUMBER_VAR", required: true, type: "number" },
    ];
    process.env.NUMBER_VAR = "42";
    const result = validateEnv(specs);
    expect(result.env.NUMBER_VAR).toBe(42);
    delete process.env.NUMBER_VAR;
  });

  it("validates boolean types", () => {
    const specs: EnvVarSpec[] = [
      { name: "BOOL_VAR", required: true, type: "boolean" },
    ];
    process.env.BOOL_VAR = "true";
    const result = validateEnv(specs);
    expect(result.env.BOOL_VAR).toBe(true);
    delete process.env.BOOL_VAR;
  });

  it("validates URL types", () => {
    const specs: EnvVarSpec[] = [
      { name: "URL_VAR", required: true, type: "url" },
    ];
    process.env.URL_VAR = "https://example.com";
    const result = validateEnv(specs);
    expect(result.valid).toBe(true);
    delete process.env.URL_VAR;
  });

  it("rejects invalid URLs", () => {
    const specs: EnvVarSpec[] = [
      { name: "URL_VAR", required: true, type: "url" },
    ];
    process.env.URL_VAR = "not-a-url";
    const result = validateEnv(specs);
    expect(result.valid).toBe(false);
    delete process.env.URL_VAR;
  });

  it("throws on validation failure", () => {
    const specs: EnvVarSpec[] = [
      { name: "MISSING_VAR", required: true, type: "string" },
    ];
    expect(() => validateEnvOrThrow(specs)).toThrow("EnvValidationError");
  });

  it("provides common environment specs", () => {
    expect(COMMON_ENV_SPECS).toHaveLength(3);
  });
});
