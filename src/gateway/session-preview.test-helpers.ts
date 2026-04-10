export function createToolSummaryPreviewTranscriptLines(sessionId: string): string[] {
  return [
    JSON.stringify({ id: sessionId, type: "session", version: 1 }),
    JSON.stringify({ message: { content: "Hello", role: "user" } }),
    JSON.stringify({ message: { content: "Hi", role: "assistant" } }),
    JSON.stringify({
      message: { content: [{ name: "weather", type: "toolcall" }], role: "assistant" },
    }),
    JSON.stringify({ message: { content: "Forecast ready", role: "assistant" } }),
  ];
}
