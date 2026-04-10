import { type AnyAgentTool, type OpenClawPluginApi, definePluginEntry } from "./api.js";
import { createLlmTaskTool } from "./src/llm-task-tool.js";

export default definePluginEntry({
  description: "Optional tool for structured subtask execution",
  id: "llm-task",
  name: "LLM Task",
  register(api: OpenClawPluginApi) {
    api.registerTool(createLlmTaskTool(api) as unknown as AnyAgentTool, { optional: true });
  },
});
