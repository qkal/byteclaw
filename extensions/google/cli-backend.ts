import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";

const GEMINI_MODEL_ALIASES: Record<string, string> = {
  flash: "gemini-3.1-flash-preview",
  "flash-lite": "gemini-3.1-flash-lite-preview",
  pro: "gemini-3.1-pro-preview",
};
const GEMINI_CLI_DEFAULT_MODEL_REF = "google-gemini-cli/gemini-3-flash-preview";

export function buildGoogleGeminiCliBackend(): CliBackendPlugin {
  return {
    bundleMcp: true,
    bundleMcpMode: "gemini-system-settings",
    config: {
      args: ["--output-format", "json", "--prompt", "{prompt}"],
      command: "gemini",
      imageArg: "@",
      imagePathScope: "workspace",
      input: "arg",
      modelAliases: GEMINI_MODEL_ALIASES,
      modelArg: "--model",
      output: "json",
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      resumeArgs: ["--resume", "{sessionId}", "--output-format", "json", "--prompt", "{prompt}"],
      serialize: true,
      sessionIdFields: ["session_id", "sessionId"],
      sessionMode: "existing",
    },
    id: "google-gemini-cli",
    liveTest: {
      defaultImageProbe: true,
      defaultMcpProbe: true,
      defaultModelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
      docker: {
        binaryName: "gemini",
        npmPackage: "@google/gemini-cli",
      },
    },
  };
}
