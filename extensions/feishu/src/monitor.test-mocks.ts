import { vi } from "vitest";

export function createFeishuClientMockModule(): {
  createFeishuWSClient: () => { start: () => void; close: () => void };
  createEventDispatcher: () => { register: () => void };
} {
  return {
    createEventDispatcher: vi.fn(() => ({ register: vi.fn() })),
    createFeishuWSClient: vi.fn(() => ({ close: vi.fn(), start: vi.fn() })),
  };
}

export function createFeishuRuntimeMockModule(): {
  getFeishuRuntime: () => {
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => number;
        createInboundDebouncer: () => {
          enqueue: () => Promise<void>;
          flushKey: () => Promise<void>;
        };
      };
      text: {
        hasControlCommand: () => boolean;
      };
    };
  };
} {
  return {
    getFeishuRuntime: () => ({
      channel: {
        debounce: {
          createInboundDebouncer: () => ({
            enqueue: async () => {},
            flushKey: async () => {},
          }),
          resolveInboundDebounceMs: () => 0,
        },
        text: {
          hasControlCommand: () => false,
        },
      },
    }),
  };
}
