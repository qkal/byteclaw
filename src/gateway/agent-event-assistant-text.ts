import type { AgentEventPayload } from "../infra/agent-events.js";

export function resolveAssistantStreamDeltaText(evt: AgentEventPayload): string {
  const {delta} = evt.data;
  const {text} = evt.data;
  return typeof delta === "string" ? delta : (typeof text === "string" ? text : "");
}
