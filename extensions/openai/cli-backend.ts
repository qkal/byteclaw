import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";

const CODEX_CLI_DEFAULT_MODEL_REF = "codex-cli/gpt-5.4";

export function buildOpenAICodexCliBackend(): CliBackendPlugin {
  return {
    bundleMcp: true,
    bundleMcpMode: "codex-config-overrides",
    config: {
      args: [
        "exec",
        "--json",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
      ],
      command: "codex",
      imageArg: "--image",
      imageMode: "repeat",
      input: "arg",
      modelArg: "--model",
      output: "jsonl",
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      resumeArgs: ["exec", "resume", "{sessionId}", "--dangerously-bypass-approvals-and-sandbox"],
      resumeOutput: "text",
      serialize: true,
      sessionIdFields: ["thread_id"],
      sessionMode: "existing",
      systemPromptFileConfigArg: "-c",
      systemPromptFileConfigKey: "model_instructions_file",
      systemPromptWhen: "first",
    },
    id: "codex-cli",
    liveTest: {
      defaultImageProbe: true,
      defaultMcpProbe: true,
      defaultModelRef: CODEX_CLI_DEFAULT_MODEL_REF,
      docker: {
        binaryName: "codex",
        npmPackage: "@openai/codex",
      },
    },
  };
}
