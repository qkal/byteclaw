import { describe, expect, it } from "vitest";
import {
  buildUnresolvedTargetResults,
  resolveTargetsWithOptionalToken,
} from "./target-resolvers.js";

describe("buildUnresolvedTargetResults", () => {
  it("marks each input unresolved with the same note", () => {
    expect(buildUnresolvedTargetResults(["a", "b"], "missing token")).toEqual([
      { input: "a", note: "missing token", resolved: false },
      { input: "b", note: "missing token", resolved: false },
    ]);
  });
});

describe("resolveTargetsWithOptionalToken", () => {
  it("returns unresolved entries when the token is missing", async () => {
    const resolved = await resolveTargetsWithOptionalToken({
      inputs: ["alice"],
      mapResolved: (entry) => ({ id: entry.id, input: entry.input, resolved: true }),
      missingTokenNote: "missing token",
      resolveWithToken: async () => [{ id: "1", input: "alice" }],
    });

    expect(resolved).toEqual([{ input: "alice", note: "missing token", resolved: false }]);
  });

  it("resolves and maps entries when a token is present", async () => {
    const resolved = await resolveTargetsWithOptionalToken({
      inputs: ["alice"],
      mapResolved: (entry) => ({ id: entry.id, input: entry.input, resolved: true }),
      missingTokenNote: "missing token",
      resolveWithToken: async ({ token, inputs }) =>
        inputs.map((input) => ({ id: `${token}:${input}`, input })),
      token: " x ",
    });

    expect(resolved).toEqual([{ id: "x:alice", input: "alice", resolved: true }]);
  });
});
