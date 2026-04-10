import { vi } from "vitest";

type DraftPreviewMode = "message" | "draft";

export interface TestDraftStream {
  update: ReturnType<typeof vi.fn<(text: string) => void>>;
  flush: ReturnType<typeof vi.fn<() => Promise<void>>>;
  messageId: ReturnType<typeof vi.fn<() => number | undefined>>;
  previewMode: ReturnType<typeof vi.fn<() => DraftPreviewMode>>;
  previewRevision: ReturnType<typeof vi.fn<() => number>>;
  lastDeliveredText: ReturnType<typeof vi.fn<() => string>>;
  clear: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  materialize: ReturnType<typeof vi.fn<() => Promise<number | undefined>>>;
  forceNewMessage: ReturnType<typeof vi.fn<() => void>>;
  sendMayHaveLanded: ReturnType<typeof vi.fn<() => boolean>>;
  setMessageId: (value: number | undefined) => void;
}

export function createTestDraftStream(params?: {
  messageId?: number;
  previewMode?: DraftPreviewMode;
  onUpdate?: (text: string) => void;
  onStop?: () => void | Promise<void>;
  clearMessageIdOnForceNew?: boolean;
}): TestDraftStream {
  let messageId = params?.messageId;
  let previewRevision = 0;
  let lastDeliveredText = "";
  return {
    clear: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    forceNewMessage: vi.fn().mockImplementation(() => {
      if (params?.clearMessageIdOnForceNew) {
        messageId = undefined;
      }
    }),
    lastDeliveredText: vi.fn().mockImplementation(() => lastDeliveredText),
    materialize: vi.fn().mockImplementation(async () => messageId),
    messageId: vi.fn().mockImplementation(() => messageId),
    previewMode: vi.fn().mockReturnValue(params?.previewMode ?? "message"),
    previewRevision: vi.fn().mockImplementation(() => previewRevision),
    sendMayHaveLanded: vi.fn().mockReturnValue(false),
    setMessageId: (value: number | undefined) => {
      messageId = value;
    },
    stop: vi.fn().mockImplementation(async () => {
      await params?.onStop?.();
    }),
    update: vi.fn().mockImplementation((text: string) => {
      previewRevision += 1;
      lastDeliveredText = text.trimEnd();
      params?.onUpdate?.(text);
    }),
  };
}

export function createSequencedTestDraftStream(startMessageId = 1001): TestDraftStream {
  let activeMessageId: number | undefined;
  let nextMessageId = startMessageId;
  let previewRevision = 0;
  let lastDeliveredText = "";
  return {
    clear: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    forceNewMessage: vi.fn().mockImplementation(() => {
      activeMessageId = undefined;
    }),
    lastDeliveredText: vi.fn().mockImplementation(() => lastDeliveredText),
    materialize: vi.fn().mockImplementation(async () => activeMessageId),
    messageId: vi.fn().mockImplementation(() => activeMessageId),
    previewMode: vi.fn().mockReturnValue("message"),
    previewRevision: vi.fn().mockImplementation(() => previewRevision),
    sendMayHaveLanded: vi.fn().mockReturnValue(false),
    setMessageId: (value: number | undefined) => {
      activeMessageId = value;
    },
    stop: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockImplementation((text: string) => {
      if (activeMessageId == null) {
        activeMessageId = nextMessageId++;
      }
      previewRevision += 1;
      lastDeliveredText = text.trimEnd();
    }),
  };
}
