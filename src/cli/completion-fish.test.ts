import { describe, expect, it } from "vitest";
import {
  buildFishOptionCompletionLine,
  buildFishSubcommandCompletionLine,
  escapeFishDescription,
} from "./completion-fish.js";

describe("completion-fish helpers", () => {
  it("escapes single quotes in descriptions", () => {
    expect(escapeFishDescription("Bob's plugin")).toBe(String.raw`Bob'\''s plugin`);
  });

  it("builds a subcommand completion line", () => {
    const line = buildFishSubcommandCompletionLine({
      condition: "__fish_use_subcommand",
      description: "Manage Bob's plugins",
      name: "plugins",
      rootCmd: "openclaw",
    });
    expect(line).toBe(
      `complete -c openclaw -n "__fish_use_subcommand" -a "plugins" -d 'Manage Bob'\\''s plugins'\n`,
    );
  });

  it("builds option line with short and long flags", () => {
    const line = buildFishOptionCompletionLine({
      condition: "__fish_use_subcommand",
      description: "Shell target",
      flags: "-s, --shell <shell>",
      rootCmd: "openclaw",
    });
    expect(line).toBe(
      `complete -c openclaw -n "__fish_use_subcommand" -s s -l shell -d 'Shell target'\n`,
    );
  });

  it("builds option line with long-only flags", () => {
    const line = buildFishOptionCompletionLine({
      condition: "__fish_seen_subcommand_from completion",
      description: "Write cache",
      flags: "--write-state",
      rootCmd: "openclaw",
    });
    expect(line).toBe(
      `complete -c openclaw -n "__fish_seen_subcommand_from completion" -l write-state -d 'Write cache'\n`,
    );
  });
});
