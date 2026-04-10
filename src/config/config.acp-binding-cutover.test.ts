import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("ACP binding cutover schema", () => {
  it("accepts top-level typed ACP bindings with per-agent runtime defaults", () => {
    const parsed = OpenClawSchema.safeParse({
      agents: {
        list: [
          { default: true, id: "main", runtime: { type: "embedded" } },
          {
            id: "coding",
            runtime: {
              acp: {
                agent: "codex",
                backend: "acpx",
                cwd: "/workspace/openclaw",
                mode: "persistent",
              },
              type: "acp",
            },
          },
        ],
      },
      bindings: [
        {
          agentId: "main",
          match: { accountId: "default", channel: "chat-a" },
          type: "route",
        },
        {
          acp: {
            backend: "acpx",
            label: "codex-main",
          },
          agentId: "coding",
          match: {
            accountId: "default",
            channel: "chat-a",
            peer: { id: "1478836151241412759", kind: "channel" },
          },
          type: "acp",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects legacy Discord channel-local ACP binding fields", () => {
    const parsed = OpenClawSchema.safeParse({
      channels: {
        discord: {
          guilds: {
            "1459246755253325866": {
              channels: {
                "1478836151241412759": {
                  bindings: {
                    acp: {
                      agentId: "codex",
                      mode: "persistent",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects legacy Telegram topic-local ACP binding fields", () => {
    const parsed = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "42": {
                  bindings: {
                    acp: {
                      agentId: "codex",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects ACP bindings without a peer conversation target", () => {
    const parsed = OpenClawSchema.safeParse({
      bindings: [
        {
          agentId: "codex",
          match: { accountId: "default", channel: "chat-a" },
          type: "acp",
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts ACP bindings for arbitrary channel ids when the peer target is explicit", () => {
    const parsed = OpenClawSchema.safeParse({
      bindings: [
        {
          agentId: "codex",
          match: {
            accountId: "default",
            channel: "plugin-chat",
            peer: { id: "C123456", kind: "channel" },
          },
          type: "acp",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts ACP bindings for generic direct and group peer kinds", () => {
    const parsed = OpenClawSchema.safeParse({
      bindings: [
        {
          agentId: "codex",
          match: {
            accountId: "default",
            channel: "plugin-chat",
            peer: { id: "peer-42", kind: "direct" },
          },
          type: "acp",
        },
        {
          agentId: "codex",
          match: {
            accountId: "default",
            channel: "plugin-chat",
            peer: { id: "group-42", kind: "group" },
          },
          type: "acp",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts deprecated dm peer kind for backward compatibility", () => {
    const parsed = OpenClawSchema.safeParse({
      bindings: [
        {
          agentId: "codex",
          match: {
            accountId: "default",
            channel: "plugin-chat",
            peer: { id: "legacy-peer", kind: "dm" },
          },
          type: "acp",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });
});
