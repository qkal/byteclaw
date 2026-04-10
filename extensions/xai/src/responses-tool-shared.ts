import type { XaiWebSearchResponse } from "./web-search-response.types.js";

export const XAI_RESPONSES_ENDPOINT = "https://api.x.ai/v1/responses";

export function buildXaiResponsesToolBody(params: {
  model: string;
  inputText: string;
  tools: Record<string, unknown>[];
  maxTurns?: number;
}): Record<string, unknown> {
  return {
    input: [{ content: params.inputText, role: "user" }],
    model: params.model,
    tools: params.tools,
    ...(params.maxTurns ? { max_turns: params.maxTurns } : {}),
  };
}

export function extractXaiWebSearchContent(data: XaiWebSearchResponse): {
  text: string | undefined;
  annotationCitations: string[];
} {
  for (const output of data.output ?? []) {
    if (output.type === "message") {
      for (const block of output.content ?? []) {
        if (block.type === "output_text" && typeof block.text === "string" && block.text) {
          const urls = (block.annotations ?? [])
            .filter(
              (annotation) =>
                annotation.type === "url_citation" && typeof annotation.url === "string",
            )
            .map((annotation) => annotation.url as string);
          return { annotationCitations: [...new Set(urls)], text: block.text };
        }
      }
    }

    if (output.type === "output_text" && typeof output.text === "string" && output.text) {
      const urls = (output.annotations ?? [])
        .filter(
          (annotation) => annotation.type === "url_citation" && typeof annotation.url === "string",
        )
        .map((annotation) => annotation.url as string);
      return { annotationCitations: [...new Set(urls)], text: output.text };
    }
  }

  return {
    annotationCitations: [],
    text: typeof data.output_text === "string" ? data.output_text : undefined,
  };
}

export function resolveXaiResponseTextAndCitations(data: XaiWebSearchResponse): {
  content: string;
  citations: string[];
} {
  const { text, annotationCitations } = extractXaiWebSearchContent(data);
  return {
    citations:
      Array.isArray(data.citations) && data.citations.length > 0
        ? data.citations
        : annotationCitations,
    content: text ?? "No response",
  };
}

export function resolveXaiResponseTextCitationsAndInline(
  data: XaiWebSearchResponse,
  inlineCitationsEnabled: boolean,
): {
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
} {
  const { content, citations } = resolveXaiResponseTextAndCitations(data);
  return {
    citations,
    content,
    inlineCitations:
      inlineCitationsEnabled && Array.isArray(data.inline_citations)
        ? data.inline_citations
        : undefined,
  };
}

export const __testing = {
  XAI_RESPONSES_ENDPOINT,
  buildXaiResponsesToolBody,
  extractXaiWebSearchContent,
  resolveXaiResponseTextAndCitations,
  resolveXaiResponseTextCitationsAndInline,
} as const;
