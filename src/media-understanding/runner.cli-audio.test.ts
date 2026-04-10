import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withAudioFixture } from "./runner.test-utils.js";

const runExecMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runExec: (...args: unknown[]) => runExecMock(...args),
}));

let runCliEntry: typeof import("./runner.entries.js").runCliEntry;

describe("media-understanding CLI audio entry", () => {
  beforeAll(async () => {
    ({ runCliEntry } = await import("./runner.entries.js"));
  });

  beforeEach(() => {
    runExecMock.mockReset().mockResolvedValue({ stdout: "cli transcript" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("applies per-request prompt and language overrides to CLI transcription templating", async () => {
    await withAudioFixture("openclaw-cli-audio", async ({ ctx, cache }) => {
      await runCliEntry({
        attachmentIndex: 0,
        cache,
        capability: "audio",
        cfg: {
          tools: {
            media: {
              audio: {
                _requestLanguageOverride: "en",
                _requestPromptOverride: "Focus on names",
                language: "fr",
                prompt: "configured prompt",
              },
            },
          },
        } as OpenClawConfig,
        config: {
          _requestLanguageOverride: "en",
          _requestPromptOverride: "Focus on names",
          language: "fr",
          prompt: "configured prompt",
        } as never,
        ctx,
        entry: {
          args: ["--prompt", "{{Prompt}}", "--language", "{{Language}}", "--file", "{{MediaPath}}"],
          command: "mock-transcriber",
          language: "de",
          prompt: "entry prompt",
          type: "cli",
        },
      });
    });

    expect(runExecMock).toHaveBeenCalledWith(
      "mock-transcriber",
      expect.arrayContaining(["--prompt", "Focus on names", "--language", "en"]),
      expect.any(Object),
    );
  });
});
