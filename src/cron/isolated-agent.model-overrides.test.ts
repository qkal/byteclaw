import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadModelCatalog } from "../agents/model-catalog.js";
import * as modelSelection from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import {
  DEFAULT_AGENT_TURN_PAYLOAD,
  DEFAULT_MESSAGE,
  GMAIL_MODEL,
  expectEmbeddedProviderModel,
  runCronTurn,
  runGmailHookTurn,
  runTurnWithStoredModelOverride,
  withTempHome,
} from "./isolated-agent.turn-test-helpers.js";

describe("runCronIsolatedAgentTurn model overrides", () => {
  beforeEach(() => {
    vi.spyOn(modelSelection, "resolveThinkingDefault").mockReturnValue("off");
    vi.mocked(runEmbeddedPiAgent).mockClear();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
  });

  it("treats blank model overrides as unset", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "   " },
      });

      expect(res.status).toBe("ok");
      expect(vi.mocked(runEmbeddedPiAgent)).toHaveBeenCalledTimes(1);
    });
  });

  it("applies model overrides with correct precedence", async () => {
    await withTempHome(async (home) => {
      const deterministicCatalog = [
        {
          id: "gpt-4.1-mini",
          name: "GPT-4.1 Mini",
          provider: "openai",
        },
        {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.5",
          provider: "anthropic",
        },
      ];
      vi.mocked(loadModelCatalog).mockResolvedValue(deterministicCatalog);

      let {res} = (
        await runCronTurn(home, {
          jobPayload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openai/gpt-4.1-mini",
          },
        })
      );
      expect(res.status).toBe("ok");
      const directModel = expectEmbeddedProviderModel({
        model: "gpt-4.1-mini",
        provider: "openai",
      });
      directModel.assert();

      ({ res } = (await runTurnWithStoredModelOverride(home, DEFAULT_AGENT_TURN_PAYLOAD)));
      expect(res.status).toBe("ok");
      const storedOverride = expectEmbeddedProviderModel({
        model: "gpt-4.1-mini",
        provider: "openai",
      });
      storedOverride.assert();

      ({ res } = (
        await runTurnWithStoredModelOverride(home, {
          kind: "agentTurn",
          message: DEFAULT_MESSAGE,
          model: "anthropic/claude-opus-4-6",
        })
      ));
      expect(res.status).toBe("ok");
      const explicitOverride = expectEmbeddedProviderModel({
        model: "claude-opus-4-6",
        provider: "anthropic",
      });
      explicitOverride.assert();
    });
  });

  it("uses hooks.gmail.model and keeps precedence over stored session override", async () => {
    await withTempHome(async (home) => {
      let {res} = (await runGmailHookTurn(home));
      expect(res.status).toBe("ok");
      const gmailModel = expectEmbeddedProviderModel({
        model: GMAIL_MODEL.replace("openrouter/", ""),
        provider: "openrouter",
      });
      gmailModel.assert();

      vi.mocked(runEmbeddedPiAgent).mockClear();
      ({ res } = (
        await runGmailHookTurn(home, {
          "agent:main:hook:gmail:msg-1": {
            modelOverride: "claude-opus-4-6",
            providerOverride: "anthropic",
            sessionId: "existing-gmail-session",
            updatedAt: Date.now(),
          },
        })
      ));
      expect(res.status).toBe("ok");
      const storedGmailModel = expectEmbeddedProviderModel({
        model: GMAIL_MODEL.replace("openrouter/", ""),
        provider: "openrouter",
      });
      storedGmailModel.assert();
    });
  });

  it("ignores hooks.gmail.model when not in the allowlist", async () => {
    await withTempHome(async (home) => {
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          id: "claude-opus-4-6",
          name: "Opus 4.5",
          provider: "anthropic",
        },
      ]);

      const { res } = await runCronTurn(home, {
        cfgOverrides: {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-6" },
              models: {
                "anthropic/claude-opus-4-6": { alias: "Opus" },
              },
            },
          },
          hooks: {
            gmail: {
              model: GMAIL_MODEL,
            },
          },
        },
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
        sessionKey: "hook:gmail:msg-2",
      });

      expect(res.status).toBe("ok");
      const ignoredGmailModel = expectEmbeddedProviderModel({
        model: "claude-opus-4-6",
        provider: "anthropic",
      });
      ignoredGmailModel.assert();
    });
  });

  it("rejects invalid model override", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: {
          kind: "agentTurn",
          message: DEFAULT_MESSAGE,
          model: "openai/",
        },
        mockTexts: null,
      });

      expect(res.status).toBe("error");
      expect(res.error).toMatch("invalid model");
      expect(vi.mocked(runEmbeddedPiAgent)).not.toHaveBeenCalled();
    });
  });

  it("passes through the resolved default thinking level", async () => {
    await withTempHome(async (home) => {
      vi.mocked(modelSelection.resolveThinkingDefault).mockReturnValueOnce("low");

      await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
        mockTexts: ["done"],
      });

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.thinkLevel).toBe("low");
    });
  });
});
