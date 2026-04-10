import {
  composeThinkingAndContent,
  extractContentFromMessage,
  extractThinkingFromMessage,
  resolveFinalAssistantText,
} from "./tui-formatters.js";

interface RunStreamState {
  thinkingText: string;
  contentText: string;
  contentBlocks: string[];
  sawNonTextContentBlocks: boolean;
  displayText: string;
}

type BoundaryDropMode = "off" | "streamed-only" | "streamed-or-incoming";

function extractTextBlocksAndSignals(message: unknown): {
  textBlocks: string[];
  sawNonTextContentBlocks: boolean;
} {
  if (!message || typeof message !== "object") {
    return { sawNonTextContentBlocks: false, textBlocks: [] };
  }
  const record = message as Record<string, unknown>;
  const { content } = record;

  if (typeof content === "string") {
    const text = content.trim();
    return {
      sawNonTextContentBlocks: false,
      textBlocks: text ? [text] : [],
    };
  }
  if (!Array.isArray(content)) {
    return { sawNonTextContentBlocks: false, textBlocks: [] };
  }

  const textBlocks: string[] = [];
  let sawNonTextContentBlocks = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") {
      const text = rec.text.trim();
      if (text) {
        textBlocks.push(text);
      }
      continue;
    }
    if (typeof rec.type === "string" && rec.type !== "thinking") {
      sawNonTextContentBlocks = true;
    }
  }
  return { sawNonTextContentBlocks, textBlocks };
}

function isDroppedBoundaryTextBlockSubset(params: {
  streamedTextBlocks: string[];
  finalTextBlocks: string[];
}): boolean {
  const { streamedTextBlocks, finalTextBlocks } = params;
  if (finalTextBlocks.length === 0 || finalTextBlocks.length >= streamedTextBlocks.length) {
    return false;
  }

  const prefixMatches = finalTextBlocks.every(
    (block, index) => streamedTextBlocks[index] === block,
  );
  if (prefixMatches) {
    return true;
  }

  const suffixStart = streamedTextBlocks.length - finalTextBlocks.length;
  return finalTextBlocks.every((block, index) => streamedTextBlocks[suffixStart + index] === block);
}

function shouldPreserveBoundaryDroppedText(params: {
  boundaryDropMode: BoundaryDropMode;
  streamedSawNonTextContentBlocks: boolean;
  incomingSawNonTextContentBlocks: boolean;
  streamedTextBlocks: string[];
  nextContentBlocks: string[];
}) {
  if (params.boundaryDropMode === "off") {
    return false;
  }
  const sawEligibleNonTextContent =
    params.boundaryDropMode === "streamed-or-incoming"
      ? params.streamedSawNonTextContentBlocks || params.incomingSawNonTextContentBlocks
      : params.streamedSawNonTextContentBlocks;
  if (!sawEligibleNonTextContent) {
    return false;
  }
  return isDroppedBoundaryTextBlockSubset({
    finalTextBlocks: params.nextContentBlocks,
    streamedTextBlocks: params.streamedTextBlocks,
  });
}

export class TuiStreamAssembler {
  private runs = new Map<string, RunStreamState>();

  private getOrCreateRun(runId: string): RunStreamState {
    let state = this.runs.get(runId);
    if (!state) {
      state = {
        contentBlocks: [],
        contentText: "",
        displayText: "",
        sawNonTextContentBlocks: false,
        thinkingText: "",
      };
      this.runs.set(runId, state);
    }
    return state;
  }

  private updateRunState(
    state: RunStreamState,
    message: unknown,
    showThinking: boolean,
    opts?: { boundaryDropMode?: BoundaryDropMode },
  ) {
    const thinkingText = extractThinkingFromMessage(message);
    const contentText = extractContentFromMessage(message);
    const { textBlocks, sawNonTextContentBlocks } = extractTextBlocksAndSignals(message);

    if (thinkingText) {
      state.thinkingText = thinkingText;
    }
    if (contentText) {
      const nextContentBlocks = textBlocks.length > 0 ? textBlocks : [contentText];
      const boundaryDropMode = opts?.boundaryDropMode ?? "off";
      const shouldKeepStreamedBoundaryText = shouldPreserveBoundaryDroppedText({
        boundaryDropMode,
        incomingSawNonTextContentBlocks: sawNonTextContentBlocks,
        nextContentBlocks,
        streamedSawNonTextContentBlocks: state.sawNonTextContentBlocks,
        streamedTextBlocks: state.contentBlocks,
      });

      if (!shouldKeepStreamedBoundaryText) {
        state.contentText = contentText;
        state.contentBlocks = nextContentBlocks;
      }
    }
    if (sawNonTextContentBlocks) {
      state.sawNonTextContentBlocks = true;
    }

    const displayText = composeThinkingAndContent({
      contentText: state.contentText,
      showThinking,
      thinkingText: state.thinkingText,
    });

    state.displayText = displayText;
  }

  ingestDelta(runId: string, message: unknown, showThinking: boolean): string | null {
    const state = this.getOrCreateRun(runId);
    const previousDisplayText = state.displayText;
    this.updateRunState(state, message, showThinking, {
      boundaryDropMode: "streamed-or-incoming",
    });

    if (!state.displayText || state.displayText === previousDisplayText) {
      return null;
    }

    return state.displayText;
  }

  finalize(runId: string, message: unknown, showThinking: boolean, errorMessage?: string): string {
    const state = this.getOrCreateRun(runId);
    const streamedDisplayText = state.displayText;
    const streamedTextBlocks = [...state.contentBlocks];
    const streamedSawNonTextContentBlocks = state.sawNonTextContentBlocks;
    this.updateRunState(state, message, showThinking, {
      boundaryDropMode: "streamed-only",
    });
    const finalComposed = state.displayText;
    const shouldKeepStreamedText =
      streamedSawNonTextContentBlocks &&
      isDroppedBoundaryTextBlockSubset({
        finalTextBlocks: state.contentBlocks,
        streamedTextBlocks,
      });
    const finalText = resolveFinalAssistantText({
      errorMessage,
      finalText: shouldKeepStreamedText ? streamedDisplayText : finalComposed,
      streamedText: streamedDisplayText,
    });

    this.runs.delete(runId);
    return finalText;
  }

  drop(runId: string) {
    this.runs.delete(runId);
  }
}
