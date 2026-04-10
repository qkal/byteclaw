import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type SystemRunApprovalMatchResult,
  toSystemRunApprovalMismatchError,
} from "./system-run-approval-binding.js";

interface FixtureCase {
  name: string;
  runId: string;
  match: Extract<SystemRunApprovalMatchResult, { ok: false }>;
  expected: {
    ok: false;
    message: string;
    details: Record<string, unknown>;
  };
}

interface Fixture {
  cases: FixtureCase[];
}

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/system-run-approval-mismatch-contract.json",
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;

describe("system-run approval mismatch contract fixtures", () => {
  test.each(fixture.cases)("$name", (entry) => {
    const result = toSystemRunApprovalMismatchError({
      match: entry.match,
      runId: entry.runId,
    });
    expect(result).toEqual(entry.expected);
  });
});
