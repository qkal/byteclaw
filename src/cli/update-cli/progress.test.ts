import { describe, expect, it } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { inferUpdateFailureHints } from "./progress.js";

function makeResult(
  stepName: string,
  stderrTail: string,
  mode: UpdateRunResult["mode"] = "npm",
): UpdateRunResult {
  return {
    durationMs: 1,
    mode,
    reason: stepName,
    status: "error",
    steps: [
      {
        command: "npm i -g openclaw@latest",
        cwd: "/tmp",
        durationMs: 1,
        exitCode: 1,
        name: stepName,
        stderrTail,
      },
    ],
  };
}

describe("inferUpdateFailureHints", () => {
  it("returns a package-manager bootstrap hint for pnpm npm-bootstrap failures", () => {
    const result = {
      durationMs: 1,
      mode: "git",
      reason: "pnpm-npm-bootstrap-failed",
      status: "error",
      steps: [],
    } satisfies UpdateRunResult;

    const hints = inferUpdateFailureHints(result);

    expect(hints.join("\n")).toContain("bootstrap pnpm from npm");
    expect(hints.join("\n")).toContain("Install pnpm manually");
  });

  it("returns a corepack hint when corepack is missing", () => {
    const result = {
      durationMs: 1,
      mode: "git",
      reason: "pnpm-corepack-missing",
      status: "error",
      steps: [],
    } satisfies UpdateRunResult;

    const hints = inferUpdateFailureHints(result);

    expect(hints.join("\n")).toContain("corepack is missing");
    expect(hints.join("\n")).toContain("Install pnpm manually");
  });

  it("returns EACCES hint for global update permission failures", () => {
    const result = makeResult(
      "global update",
      "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied",
    );
    const hints = inferUpdateFailureHints(result);
    expect(hints.join("\n")).toContain("EACCES");
    expect(hints.join("\n")).toContain("npm config set prefix ~/.local");
  });

  it("returns native optional dependency hint for node-gyp failures", () => {
    const result = makeResult("global update", "node-pre-gyp ERR!\nnode-gyp rebuild failed");
    const hints = inferUpdateFailureHints(result);
    expect(hints.join("\n")).toContain("--omit=optional");
  });

  it("does not return npm hints for non-npm install modes", () => {
    const result = makeResult(
      "global update",
      "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied",
      "pnpm",
    );
    expect(inferUpdateFailureHints(result)).toEqual([]);
  });
});
