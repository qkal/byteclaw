import { describe, expect, it } from "vitest";
import { parseSpawnInput, parseSteerInput } from "./shared.js";

describe("parseSteerInput", () => {
  it("preserves non-option instruction tokens while normalizing unicode-dash flags", () => {
    const parsed = parseSteerInput([
      "\u2014session",
      "agent:codex:acp:s1",
      "\u2014briefly",
      "summarize",
      "this",
    ]);

    expect(parsed).toEqual({
      ok: true,
      value: {
        instruction: "\u2014briefly summarize this",
        sessionToken: "agent:codex:acp:s1",
      },
    });
  });
});

describe("parseSpawnInput", () => {
  it("rejects mixing --thread and --bind on the same spawn", () => {
    const parsed = parseSpawnInput(
      {
        cfg: {},
        command: {},
        ctx: {},
      } as never,
      ["codex", "--thread", "here", "--bind", "here"],
    );

    expect(parsed).toEqual({
      error:
        "Use either --thread or --bind for /acp spawn, not both. Usage: /acp spawn [harness-id] [--mode persistent|oneshot] [--thread auto|here|off] [--bind here|off] [--cwd <path>] [--label <label>].",
      ok: false,
    });
  });
});
