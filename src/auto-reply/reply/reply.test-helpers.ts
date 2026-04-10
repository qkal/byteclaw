export function createMockTypingController() {
  return {
    cleanup: () => undefined,
    isActive: () => false,
    markDispatchIdle: () => undefined,
    markRunComplete: () => undefined,
    onReplyStart: async () => undefined,
    refreshTypingTtl: () => undefined,
    startTypingLoop: async () => undefined,
    startTypingOnText: async () => undefined,
  };
}
