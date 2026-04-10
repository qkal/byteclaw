import { describe, expect, it } from "vitest";
import {
  Schema,
  ValidationRules,
  validate,
  validateOrThrow,
  ValidationError,
} from "./input-validation.js";

describe("input-validation", () => {
  describe("validate", () => {
    it("validates with custom rules", () => {
      const result = validate("test", [
        { name: "required", validate: ValidationRules.required },
        { name: "string", validate: ValidationRules.string },
      ]);
      expect(result.valid).toBe(true);
    });

    it("returns errors for invalid values", () => {
      const result = validate(123, [
        { name: "string", validate: ValidationRules.string },
      ]);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe("validateOrThrow", () => {
    it("returns value when valid", () => {
      const result = validateOrThrow("test", [
        { name: "string", validate: ValidationRules.string },
      ]);
      expect(result).toBe("test");
    });

    it("throws ValidationError when invalid", () => {
      expect(() =>
        validateOrThrow(123, [{ name: "string", validate: ValidationRules.string }]),
      ).toThrow(ValidationError);
    });
  });

  describe("ValidationRules", () => {
    it("validates email", () => {
      expect(ValidationRules.email("test@example.com")).toBe(true);
      expect(ValidationRules.email("invalid")).toBe(false);
    });

    it("validates URL", () => {
      expect(ValidationRules.url("https://example.com")).toBe(true);
      expect(ValidationRules.url("not-a-url")).toBe(false);
    });

    it("validates length constraints", () => {
      expect(ValidationRules.minLength(5)("hello")).toBe(true);
      expect(ValidationRules.minLength(5)("hi")).toBe(false);
      expect(ValidationRules.maxLength(5)("hello")).toBe(true);
      expect(ValidationRules.maxLength(5)("hello world")).toBe(false);
    });

    it("validates numeric constraints", () => {
      expect(ValidationRules.minValue(5)(10)).toBe(true);
      expect(ValidationRules.minValue(5)(3)).toBe(false);
      expect(ValidationRules.maxValue(10)(5)).toBe(true);
      expect(ValidationRules.maxValue(10)(15)).toBe(false);
    });

    it("validates UUID", () => {
      expect(ValidationRules.uuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
      expect(ValidationRules.uuid("not-a-uuid")).toBe(false);
    });

    it("validates port", () => {
      expect(ValidationRules.port(3000)).toBe(true);
      expect(ValidationRules.port(70000)).toBe(false);
      expect(ValidationRules.port(0)).toBe(false);
    });
  });

  describe("Schema", () => {
    it("validates object schema", () => {
      const schema = new Schema({
        name: [{ name: "required", validate: ValidationRules.required }],
        age: [{ name: "number", validate: ValidationRules.number }],
      });
      const result = schema.validate({ name: "John", age: 30 });
      expect(result.valid).toBe(true);
    });

    it("returns errors for invalid schema", () => {
      const schema = new Schema({
        name: [{ name: "required", validate: ValidationRules.required }],
        age: [{ name: "number", validate: ValidationRules.number }],
      });
      const result = schema.validate({ name: "John", age: "thirty" });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("throws on schema validation failure", () => {
      const schema = new Schema({
        name: [{ name: "required", validate: ValidationRules.required }],
      });
      expect(() => schema.validateOrThrow({})).toThrow(ValidationError);
    });
  });
});
