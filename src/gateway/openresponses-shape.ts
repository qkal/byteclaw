import type { OutputItem } from "./open-responses.schema.js";

export function createAssistantOutputItem(params: {
  id: string;
  text: string;
  phase?: "commentary" | "final_answer";
  status?: "in_progress" | "completed";
}): OutputItem {
  return {
    type: "message",
    id: params.id,
    role: "assistant",
    content: [{ text: params.text, type: "output_text" }],
    ...(params.phase ? { phase: params.phase } : {}),
    status: params.status,
  };
}

export function createFunctionCallOutputItem(params: {
  id: string;
  callId: string;
  name: string;
  arguments: string;
  status?: "in_progress" | "completed";
}): OutputItem {
  return {
    arguments: params.arguments,
    call_id: params.callId,
    id: params.id,
    name: params.name,
    status: params.status,
    type: "function_call",
  };
}
