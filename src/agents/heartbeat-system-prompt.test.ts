import { describe, expect, it } from "vitest";
import { resolveHeartbeatPromptForSystemPrompt } from "./heartbeat-system-prompt.js";

describe("resolveHeartbeatPromptForSystemPrompt", () => {
  it("omits the heartbeat section when disabled in defaults", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        agentId: "main",
        config: {
          agents: {
            defaults: {
              heartbeat: {
                includeSystemPromptSection: false,
              },
            },
          },
        },
        defaultAgentId: "main",
      }),
    ).toBeUndefined();
  });

  it("omits the heartbeat section when the default cadence is disabled", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        agentId: "main",
        config: {
          agents: {
            defaults: {
              heartbeat: {
                every: "0m",
              },
            },
          },
        },
        defaultAgentId: "main",
      }),
    ).toBeUndefined();
  });

  it("omits the heartbeat section when the default-agent override disables cadence", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        agentId: "main",
        config: {
          agents: {
            defaults: {
              heartbeat: {
                every: "30m",
              },
            },
            list: [
              {
                heartbeat: {
                  every: "0m",
                },
                id: "main",
              },
            ],
          },
        },
        defaultAgentId: "main",
      }),
    ).toBeUndefined();
  });

  it("omits the heartbeat section when only a non-default agent has explicit heartbeat config", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        agentId: "main",
        config: {
          agents: {
            list: [
              { default: true, id: "main" },
              {
                heartbeat: {
                  every: "30m",
                },
                id: "ops",
              },
            ],
          },
        },
        defaultAgentId: "main",
      }),
    ).toBeUndefined();
  });

  it("honors default-agent overrides for the prompt text", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        agentId: "main",
        config: {
          agents: {
            defaults: {
              heartbeat: {
                prompt: "Default prompt",
              },
            },
            list: [
              {
                heartbeat: {
                  prompt: "  Ops check  ",
                },
                id: "main",
              },
            ],
          },
        },
        defaultAgentId: "main",
      }),
    ).toBe("Ops check");
  });

  it("does not inject the heartbeat section for non-default agents", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        agentId: "ops",
        config: {
          agents: {
            defaults: {
              heartbeat: {
                prompt: "Default prompt",
              },
            },
            list: [
              {
                heartbeat: {
                  prompt: "Ops prompt",
                },
                id: "ops",
              },
            ],
          },
        },
        defaultAgentId: "main",
      }),
    ).toBeUndefined();
  });
});
