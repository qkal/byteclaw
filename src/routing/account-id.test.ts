import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "./account-id.js";

describe("account id normalization", () => {
  const reservedAccountIdCases = [
    { input: "__proto__", name: "rejects __proto__ pollution keys" },
    { input: "constructor", name: "rejects constructor pollution keys" },
    { input: "prototype", name: "rejects prototype pollution keys" },
  ] as const;

  function expectNormalizedAccountIdCase(params: {
    input: string | null | undefined;
    expected: string | undefined;
    optional?: boolean;
  }) {
    const normalize = params.optional ? normalizeOptionalAccountId : normalizeAccountId;
    expect(normalize(params.input)).toBe(params.expected);
  }

  it.each([
    {
      expected: DEFAULT_ACCOUNT_ID,
      input: undefined,
      name: "defaults undefined to default account",
    },
    { expected: DEFAULT_ACCOUNT_ID, input: null, name: "defaults null to default account" },
    {
      expected: DEFAULT_ACCOUNT_ID,
      input: "   ",
      name: "defaults blank strings to default account",
    },
    { expected: "business_1", input: "  Business_1  ", name: "normalizes valid ids to lowercase" },
    {
      expected: "prod-us-east",
      input: " Prod/US East ",
      name: "sanitizes invalid characters into canonical ids",
    },
    ...reservedAccountIdCases.map(({ name, input }) => ({
      expected: DEFAULT_ACCOUNT_ID,
      input,
      name,
    })),
  ] as const)("$name", ({ input, expected }) => {
    expectNormalizedAccountIdCase({ expected, input });
  });

  it.each([
    { expected: undefined, input: undefined, name: "keeps undefined optional values unset" },
    { expected: undefined, input: "   ", name: "keeps blank optional values unset" },
    { expected: undefined, input: " !!! ", name: "keeps invalid optional values unset" },
    ...reservedAccountIdCases.map(({ name, input }) => ({
      expected: undefined,
      input,
      name: name.replace(" pollution keys", " optional values"),
    })),
    { expected: "business", input: "  Business  ", name: "normalizes valid optional values" },
  ] as const)("$name", ({ input, expected }) => {
    expectNormalizedAccountIdCase({ expected, input, optional: true });
  });
});
