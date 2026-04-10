import { describe, expect, it } from "vitest";
import { resolveSystemPromptOverride } from "./system-prompt-override.js";

describe("resolveSystemPromptOverride", () => {
  it("uses defaults when no per-agent override exists", () => {
    expect(
      resolveSystemPromptOverride({
        agentId: "main",
        config: {
          agents: {
            defaults: { systemPromptOverride: "  default system  " },
            list: [{ id: "main" }],
          },
        },
      }),
    ).toBe("default system");
  });

  it("prefers the per-agent override", () => {
    expect(
      resolveSystemPromptOverride({
        agentId: "main",
        config: {
          agents: {
            defaults: { systemPromptOverride: "default system" },
            list: [{ id: "main", systemPromptOverride: "  agent system  " }],
          },
        },
      }),
    ).toBe("agent system");
  });

  it("ignores blank override values", () => {
    expect(
      resolveSystemPromptOverride({
        agentId: "main",
        config: {
          agents: {
            defaults: { systemPromptOverride: "default system" },
            list: [{ id: "main", systemPromptOverride: "   " }],
          },
        },
      }),
    ).toBe("default system");
  });
});
