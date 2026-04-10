import { vi } from "vitest";
import { stubTool } from "./fast-tool-stubs.js";

function stubActionTool(name: string, actions: string[]) {
  return {
    ...stubTool(name),
    parameters: {
      properties: {
        action: {
          enum: actions,
          type: "string" as const,
        },
      },
      required: ["action"],
      type: "object" as const,
    },
  };
}

const coreTools = [
  stubActionTool("canvas", ["create", "read"]),
  stubActionTool("nodes", ["list", "invoke"]),
  stubActionTool("cron", ["schedule", "cancel"]),
  stubActionTool("message", ["send", "reply"]),
  stubActionTool("gateway", ["status"]),
  stubActionTool("agents_list", ["list", "show"]),
  stubActionTool("sessions_list", ["list", "show"]),
  stubActionTool("sessions_history", ["read", "tail"]),
  stubActionTool("sessions_send", ["send", "reply"]),
  stubActionTool("sessions_spawn", ["spawn", "handoff"]),
  stubActionTool("subagents", ["list", "show"]),
  stubActionTool("session_status", ["get", "show"]),
  stubTool("tts"),
  stubTool("image_generate"),
  stubTool("video_generate"),
  stubTool("web_fetch"),
  stubTool("image"),
  stubTool("pdf"),
];

vi.mock("../openclaw-tools.js", () => ({
  __testing: {
    setDepsForTest: () => {},
  },
  createOpenClawTools: () => coreTools.map((tool) => ({ ...tool })),
}));
