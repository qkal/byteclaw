import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

export function createStubTool(name: string): AgentTool {
  return {
    description: "",
    execute: async () => ({}) as AgentToolResult<unknown>,
    label: name,
    name,
    parameters: Type.Object({}),
  };
}
