export interface PendingToolCall { id: string; name?: string }

export interface PendingToolCallState {
  size: () => number;
  entries: () => IterableIterator<[string, string | undefined]>;
  getToolName: (id: string) => string | undefined;
  delete: (id: string) => void;
  clear: () => void;
  trackToolCalls: (calls: PendingToolCall[]) => void;
  getPendingIds: () => string[];
  shouldFlushForSanitizedDrop: () => boolean;
  shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) => boolean;
  shouldFlushBeforeNewToolCalls: (toolCallCount: number) => boolean;
}

export function createPendingToolCallState(): PendingToolCallState {
  const pending = new Map<string, string | undefined>();

  return {
    clear: () => {
      pending.clear();
    },
    delete: (id: string) => {
      pending.delete(id);
    },
    entries: () => pending.entries(),
    getPendingIds: () => [...pending.keys()],
    getToolName: (id: string) => pending.get(id),
    shouldFlushBeforeNewToolCalls: (toolCallCount: number) => pending.size > 0 && toolCallCount > 0,
    shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) =>
      pending.size > 0 && (toolCallCount === 0 || nextRole !== "assistant"),
    shouldFlushForSanitizedDrop: () => pending.size > 0,
    size: () => pending.size,
    trackToolCalls: (calls: PendingToolCall[]) => {
      for (const call of calls) {
        pending.set(call.id, call.name);
      }
    },
  };
}
