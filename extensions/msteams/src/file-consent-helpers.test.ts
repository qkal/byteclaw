import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareFileConsentActivity, requiresFileConsent } from "./file-consent-helpers.js";
import {
  clearPendingUploads,
  getPendingUpload,
  getPendingUploadCount,
  removePendingUpload,
  storePendingUpload,
} from "./pending-uploads.js";
import * as pendingUploads from "./pending-uploads.js";

describe("requiresFileConsent", () => {
  const thresholdBytes = 4 * 1024 * 1024; // 4MB

  it("returns true for personal chat with non-image", () => {
    expect(
      requiresFileConsent({
        bufferSize: 1000,
        contentType: "application/pdf",
        conversationType: "personal",
        thresholdBytes,
      }),
    ).toBe(true);
  });

  it("returns true for personal chat with large image", () => {
    expect(
      requiresFileConsent({
        conversationType: "personal",
        contentType: "image/png",
        bufferSize: 5 * 1024 * 1024, // 5MB
        thresholdBytes,
      }),
    ).toBe(true);
  });

  it("returns false for personal chat with small image", () => {
    expect(
      requiresFileConsent({
        bufferSize: 1000,
        contentType: "image/png",
        conversationType: "personal",
        thresholdBytes,
      }),
    ).toBe(false);
  });

  it("returns false for group chat with large non-image", () => {
    expect(
      requiresFileConsent({
        bufferSize: 5 * 1024 * 1024,
        contentType: "application/pdf",
        conversationType: "groupChat",
        thresholdBytes,
      }),
    ).toBe(false);
  });

  it("returns false for channel with large non-image", () => {
    expect(
      requiresFileConsent({
        bufferSize: 5 * 1024 * 1024,
        contentType: "application/pdf",
        conversationType: "channel",
        thresholdBytes,
      }),
    ).toBe(false);
  });

  it("handles case-insensitive conversation type", () => {
    expect(
      requiresFileConsent({
        bufferSize: 1000,
        contentType: "application/pdf",
        conversationType: "Personal",
        thresholdBytes,
      }),
    ).toBe(true);

    expect(
      requiresFileConsent({
        bufferSize: 1000,
        contentType: "application/pdf",
        conversationType: "PERSONAL",
        thresholdBytes,
      }),
    ).toBe(true);
  });

  it("returns false when conversationType is undefined", () => {
    expect(
      requiresFileConsent({
        bufferSize: 1000,
        contentType: "application/pdf",
        conversationType: undefined,
        thresholdBytes,
      }),
    ).toBe(false);
  });

  it("returns true for personal chat when contentType is undefined (non-image)", () => {
    expect(
      requiresFileConsent({
        bufferSize: 1000,
        contentType: undefined,
        conversationType: "personal",
        thresholdBytes,
      }),
    ).toBe(true);
  });

  it("returns true for personal chat with file exactly at threshold", () => {
    expect(
      requiresFileConsent({
        conversationType: "personal",
        contentType: "image/jpeg",
        bufferSize: thresholdBytes, // Exactly 4MB
        thresholdBytes,
      }),
    ).toBe(true);
  });

  it("returns false for personal chat with file just below threshold", () => {
    expect(
      requiresFileConsent({
        conversationType: "personal",
        contentType: "image/jpeg",
        bufferSize: thresholdBytes - 1, // 4MB - 1 byte
        thresholdBytes,
      }),
    ).toBe(false);
  });
});

describe("prepareFileConsentActivity", () => {
  const mockUploadId = "test-upload-id-123";

  beforeEach(() => {
    vi.spyOn(pendingUploads, "storePendingUpload").mockReturnValue(mockUploadId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates activity with consent card attachment", () => {
    const result = prepareFileConsentActivity({
      conversationId: "conv123",
      description: "My file",
      media: {
        buffer: Buffer.from("test content"),
        contentType: "application/pdf",
        filename: "test.pdf",
      },
    });

    expect(result.uploadId).toBe(mockUploadId);
    expect(result.activity.type).toBe("message");
    expect(result.activity.attachments).toHaveLength(1);

    const attachment = (result.activity.attachments as unknown[])[0] as Record<string, unknown>;
    expect(attachment.contentType).toBe("application/vnd.microsoft.teams.card.file.consent");
    expect(attachment.name).toBe("test.pdf");
  });

  it("stores pending upload with correct data", () => {
    const buffer = Buffer.from("test content");
    prepareFileConsentActivity({
      conversationId: "conv123",
      description: "My file",
      media: {
        buffer,
        contentType: "application/pdf",
        filename: "test.pdf",
      },
    });

    expect(pendingUploads.storePendingUpload).toHaveBeenCalledWith({
      buffer,
      contentType: "application/pdf",
      conversationId: "conv123",
      filename: "test.pdf",
    });
  });

  it("uses default description when not provided", () => {
    const result = prepareFileConsentActivity({
      conversationId: "conv456",
      media: {
        buffer: Buffer.from("test"),
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "document.docx",
      },
    });

    const attachment = (result.activity.attachments as unknown[])[0] as Record<
      string,
      { description: string }
    >;
    expect(attachment.content.description).toBe("File: document.docx");
  });

  it("uses provided description", () => {
    const result = prepareFileConsentActivity({
      conversationId: "conv789",
      description: "Q4 Financial Report",
      media: {
        buffer: Buffer.from("test"),
        contentType: "application/pdf",
        filename: "report.pdf",
      },
    });

    const attachment = (result.activity.attachments as unknown[])[0] as Record<
      string,
      { description: string }
    >;
    expect(attachment.content.description).toBe("Q4 Financial Report");
  });

  it("includes uploadId in consent card context", () => {
    const result = prepareFileConsentActivity({
      conversationId: "conv000",
      media: {
        buffer: Buffer.from("test"),
        contentType: "text/plain",
        filename: "file.txt",
      },
    });

    const attachment = (result.activity.attachments as unknown[])[0] as Record<
      string,
      { acceptContext: { uploadId: string } }
    >;
    expect(attachment.content.acceptContext.uploadId).toBe(mockUploadId);
  });

  it("handles media without contentType", () => {
    const result = prepareFileConsentActivity({
      conversationId: "conv111",
      media: {
        buffer: Buffer.from("binary data"),
        filename: "unknown.bin",
      },
    });

    expect(result.uploadId).toBe(mockUploadId);
    expect(result.activity.type).toBe("message");
  });
});

describe("msteams pending uploads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearPendingUploads();
  });

  afterEach(() => {
    clearPendingUploads();
    vi.useRealTimers();
  });

  it("stores uploads, exposes them by id, and tracks count", () => {
    const id = storePendingUpload({
      buffer: Buffer.from("hello"),
      contentType: "text/plain",
      conversationId: "conv-1",
      filename: "hello.txt",
    });

    expect(getPendingUploadCount()).toBe(1);
    expect(getPendingUpload(id)).toEqual(
      expect.objectContaining({
        contentType: "text/plain",
        conversationId: "conv-1",
        filename: "hello.txt",
        id,
      }),
    );
  });

  it("removes uploads explicitly and ignores empty ids", () => {
    const id = storePendingUpload({
      buffer: Buffer.from("hello"),
      conversationId: "conv-1",
      filename: "hello.txt",
    });

    removePendingUpload(undefined);
    expect(getPendingUploadCount()).toBe(1);

    removePendingUpload(id);
    expect(getPendingUpload(id)).toBeUndefined();
    expect(getPendingUploadCount()).toBe(0);
  });

  it("expires uploads by ttl even if the timeout callback has not been observed yet", () => {
    const id = storePendingUpload({
      buffer: Buffer.from("hello"),
      conversationId: "conv-1",
      filename: "hello.txt",
    });

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(getPendingUpload(id)).toBeUndefined();
    expect(getPendingUploadCount()).toBe(0);
  });

  it("clears all uploads for test cleanup", () => {
    storePendingUpload({
      buffer: Buffer.from("a"),
      conversationId: "conv-1",
      filename: "a.txt",
    });
    storePendingUpload({
      buffer: Buffer.from("b"),
      conversationId: "conv-2",
      filename: "b.txt",
    });

    clearPendingUploads();

    expect(getPendingUploadCount()).toBe(0);
  });
});
