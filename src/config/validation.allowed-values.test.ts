import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("config validation allowed-values metadata", () => {
  it("adds allowed values for invalid union paths", () => {
    const result = validateConfigObjectRaw({
      update: { channel: "nightly" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "update.channel");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('(allowed: "stable", "beta", "dev")');
      expect(issue?.allowedValues).toEqual(["stable", "beta", "dev"]);
      expect(issue?.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("keeps native enum messages while attaching allowed values metadata", () => {
    const result = validateConfigObjectRaw({
      channels: { signal: { dmPolicy: "maybe" } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "channels.signal.dmPolicy");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain("expected one of");
      expect(issue?.message).not.toContain("(allowed:");
      expect(issue?.allowedValues).toEqual(["pairing", "allowlist", "open", "disabled"]);
      expect(issue?.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("includes boolean variants for boolean-or-enum unions", () => {
    const result = validateConfigObjectRaw({
      channels: {
        telegram: {
          allowFrom: ["*"],
          botToken: "x",
          dmPolicy: "allowlist",
          streaming: "maybe",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "channels.telegram");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain(
        "channels.telegram.streamMode, channels.telegram.streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy",
      );
      expect(issue?.allowedValues).toBeUndefined();
    }
  });

  it("skips allowed-values hints for unions with open-ended branches", () => {
    const result = validateConfigObjectRaw({
      cron: { sessionRetention: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "cron.sessionRetention");
      expect(issue).toBeDefined();
      expect(issue?.allowedValues).toBeUndefined();
      expect(issue?.allowedValuesHiddenCount).toBeUndefined();
      expect(issue?.message).not.toContain("(allowed:");
    }
  });

  it("surfaces specific sub-issue for invalid_union bindings errors instead of generic 'Invalid input'", () => {
    const result = validateConfigObjectRaw({
      bindings: [
        {
          acp: { agent: "claude" },
          agentId: "test",
          match: { channel: "discord", peer: { id: "123", kind: "direct" } },
          type: "acp",
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).not.toContainEqual({
        message: "Invalid input",
        path: "bindings.0",
      });
      expect(result.issues).toContainEqual({
        message: 'Unrecognized key: "agent"',
        path: "bindings.0.acp",
      });
    }
  });

  it("prefers the matching union branch for top-level unexpected keys", () => {
    const result = validateConfigObjectRaw({
      bindings: [
        {
          acp: { mode: "persistent" },
          agentId: "test",
          extraTopLevel: true,
          match: { channel: "discord", peer: { id: "123", kind: "direct" } },
          type: "acp",
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).not.toContainEqual({
        message: 'Invalid input: expected "route"',
        path: "bindings.0.type",
      });
      expect(result.issues).toContainEqual({
        message: 'Unrecognized key: "extraTopLevel"',
        path: "bindings.0",
      });
    }
  });

  it("keeps generic union messaging for mixed scalar-or-object unions", () => {
    const result = validateConfigObjectRaw({
      agents: {
        list: [{ id: "a", model: true }],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).not.toContainEqual({
        message: "Invalid input: expected string, received boolean",
        path: "agents.list.0.model",
      });
      expect(result.issues).not.toContainEqual({
        message: "Invalid input: expected object, received boolean",
        path: "agents.list.0.model",
      });
      expect(result.issues).toContainEqual({
        message: "Invalid input",
        path: "agents.list.0.model",
      });
    }
  });
});
