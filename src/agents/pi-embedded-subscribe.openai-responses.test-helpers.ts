export type OpenAiResponsesTextEventPhase = "commentary" | "final_answer";

export function createOpenAiResponsesTextBlock(params: {
  text: string;
  id: string;
  phase?: OpenAiResponsesTextEventPhase;
}) {
  return {
    text: params.text,
    textSignature: JSON.stringify({
      id: params.id,
      v: 1,
      ...(params.phase ? { phase: params.phase } : {}),
    }),
    type: "text",
  };
}

export function createOpenAiResponsesPartial(params: {
  text: string;
  id: string;
  signaturePhase?: OpenAiResponsesTextEventPhase;
  partialPhase?: OpenAiResponsesTextEventPhase;
}) {
  return {
    role: "assistant",
    content: [
      createOpenAiResponsesTextBlock({
        id: params.id,
        phase: params.signaturePhase,
        text: params.text,
      }),
    ],
    ...(params.partialPhase ? { phase: params.partialPhase } : {}),
    stopReason: "stop",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.2",
    usage: {},
    timestamp: 0,
  };
}

export function createOpenAiResponsesTextEvent(params: {
  type: "text_delta" | "text_end";
  text: string;
  delta?: string;
  id?: string;
  signaturePhase?: OpenAiResponsesTextEventPhase;
  partialPhase?: OpenAiResponsesTextEventPhase;
  messagePhase?: OpenAiResponsesTextEventPhase;
  content?: unknown[];
  partial?: ReturnType<typeof createOpenAiResponsesPartial>;
}) {
  const partial =
    params.partial ??
    (params.id
      ? createOpenAiResponsesPartial({
          id: params.id,
          partialPhase: params.partialPhase,
          signaturePhase: params.signaturePhase,
          text: params.text,
        })
      : undefined);

  return {
    assistantMessageEvent: {
      type: params.type,
      ...(params.type === "text_delta"
        ? { delta: params.delta ?? params.text }
        : { content: params.text }),
      ...(partial ? { partial } : {}),
    },
    message: {
      role: "assistant",
      ...(params.messagePhase ? { phase: params.messagePhase } : {}),
      content: params.content ?? [],
    },
    type: "message_update",
  } as never;
}
