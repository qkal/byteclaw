import { describe, expect, it, vi } from "vitest";
import { sandboxExplainCommand } from "./sandbox-explain.js";

const SANDBOX_EXPLAIN_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 30_000;

let mockCfg: unknown = {};

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: vi.fn().mockImplementation(() => mockCfg),
  };
});

describe("sandbox explain command", () => {
  it("prints JSON shape + fix-it keys", { timeout: SANDBOX_EXPLAIN_TEST_TIMEOUT_MS }, async () => {
    mockCfg = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
        },
      },
      session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" },
      tools: {
        elevated: { allowFrom: { whatsapp: ["*"] }, enabled: true },
        sandbox: { tools: { deny: ["browser"] } },
      },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ json: true, session: "agent:main:main" }, {
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
      log: (msg: string) => logs.push(msg),
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const out = logs.join("");
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("docsUrl", "https://docs.openclaw.ai/sandbox");
    expect(parsed).toHaveProperty("sandbox.mode", "all");
    expect(parsed).toHaveProperty("sandbox.tools.sources.allow.source");
    expect(Array.isArray(parsed.fixIt)).toBe(true);
    expect(parsed.fixIt).toContain("agents.defaults.sandbox.mode=off");
    expect(parsed.fixIt).toContain("tools.sandbox.tools.alsoAllow");
    expect(parsed.fixIt).toContain("tools.sandbox.tools.deny");
  });

  it("shows effective sandbox alsoAllow grants and default-deny removals", async () => {
    mockCfg = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
        },
        list: [
          {
            id: "tavern",
            tools: {
              sandbox: {
                tools: {
                  alsoAllow: ["message", "tts"],
                },
              },
            },
          },
        ],
      },
      session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" },
      tools: {
        sandbox: {
          tools: {
            allow: ["browser"],
          },
        },
      },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ agent: "tavern", json: true }, {
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
      log: (msg: string) => logs.push(msg),
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const parsed = JSON.parse(logs.join(""));
    expect(parsed.sandbox.tools.allow).toEqual(
      expect.arrayContaining(["browser", "message", "tts"]),
    );
    expect(parsed.sandbox.tools.deny).not.toContain("browser");
    expect(parsed.sandbox.tools.sources.allow).toEqual({
      key: "agents.list[].tools.sandbox.tools.alsoAllow",
      source: "agent",
    });
  });
});
