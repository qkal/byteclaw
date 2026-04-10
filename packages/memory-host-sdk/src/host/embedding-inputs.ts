export interface EmbeddingInputTextPart {
  type: "text";
  text: string;
}

export interface EmbeddingInputInlineDataPart {
  type: "inline-data";
  mimeType: string;
  data: string;
}

export type EmbeddingInputPart = EmbeddingInputTextPart | EmbeddingInputInlineDataPart;

export interface EmbeddingInput {
  text: string;
  parts?: EmbeddingInputPart[];
}

export function buildTextEmbeddingInput(text: string): EmbeddingInput {
  return { text };
}

export function isInlineDataEmbeddingInputPart(
  part: EmbeddingInputPart,
): part is EmbeddingInputInlineDataPart {
  return part.type === "inline-data";
}

export function hasNonTextEmbeddingParts(input: EmbeddingInput | undefined): boolean {
  if (!input?.parts?.length) {
    return false;
  }
  return input.parts.some((part) => isInlineDataEmbeddingInputPart(part));
}
