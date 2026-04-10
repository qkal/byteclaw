import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export function jsonToolResult(data: unknown) {
  return {
    content: [{ text: JSON.stringify(data, null, 2), type: "text" as const }],
    details: data,
  };
}

export function unknownToolActionResult(action: unknown) {
  return jsonToolResult({ error: `Unknown action: ${String(action)}` });
}

export function toolExecutionErrorResult(error: unknown) {
  return jsonToolResult({ error: formatErrorMessage(error) });
}
