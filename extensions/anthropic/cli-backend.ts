import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";
import {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_CLEAR_ENV,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CLAUDE_CLI_MODEL_ALIASES,
  CLAUDE_CLI_SESSION_ID_FIELDS,
  normalizeClaudeBackendConfig,
} from "./cli-shared.js";

export function buildAnthropicCliBackend(): CliBackendPlugin {
  return {
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    config: {
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--setting-sources",
        "user",
        "--permission-mode",
        "bypassPermissions",
      ],
      clearEnv: [...CLAUDE_CLI_CLEAR_ENV],
      command: "claude",
      input: "stdin",
      modelAliases: CLAUDE_CLI_MODEL_ALIASES,
      modelArg: "--model",
      output: "jsonl",
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      resumeArgs: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--setting-sources",
        "user",
        "--permission-mode",
        "bypassPermissions",
        "--resume",
        "{sessionId}",
      ],
      serialize: true,
      sessionArg: "--session-id",
      sessionIdFields: [...CLAUDE_CLI_SESSION_ID_FIELDS],
      sessionMode: "always",
      systemPromptArg: "--append-system-prompt",
      systemPromptMode: "append",
      systemPromptWhen: "first",
    },
    id: CLAUDE_CLI_BACKEND_ID,
    liveTest: {
      defaultImageProbe: true,
      defaultMcpProbe: true,
      defaultModelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
      docker: {
        binaryName: "claude",
        npmPackage: "@anthropic-ai/claude-code",
      },
    },
    normalizeConfig: normalizeClaudeBackendConfig,
  };
}
