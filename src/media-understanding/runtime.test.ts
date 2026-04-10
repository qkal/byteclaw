import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MediaAttachment, MediaUnderstandingOutput } from "../media-understanding/types.js";
import { describeImageFile, runMediaUnderstandingFile } from "./runtime.js";

const mocks = vi.hoisted(() => {
  const cleanup = vi.fn(async () => {});
  return {
    buildProviderRegistry: vi.fn(() => new Map()),
    cleanup,
    createMediaAttachmentCache: vi.fn(() => ({ cleanup })),
    normalizeMediaAttachments: vi.fn<() => MediaAttachment[]>(() => []),
    normalizeMediaProviderId: vi.fn((provider: string) => provider.trim().toLowerCase()),
    runCapability: vi.fn(),
  };
});

vi.mock("../plugin-sdk/media-runtime.js", () => ({
  buildProviderRegistry: mocks.buildProviderRegistry,
  createMediaAttachmentCache: mocks.createMediaAttachmentCache,
  normalizeMediaAttachments: mocks.normalizeMediaAttachments,
  normalizeMediaProviderId: mocks.normalizeMediaProviderId,
  runCapability: mocks.runCapability,
}));

describe("media-understanding runtime", () => {
  afterEach(() => {
    mocks.buildProviderRegistry.mockReset();
    mocks.createMediaAttachmentCache.mockReset();
    mocks.normalizeMediaAttachments.mockReset();
    mocks.normalizeMediaProviderId.mockReset();
    mocks.runCapability.mockReset();
    mocks.cleanup.mockReset();
    mocks.cleanup.mockResolvedValue(undefined);
  });

  it("returns disabled state without loading providers", async () => {
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, mime: "image/jpeg", path: "/tmp/sample.jpg" },
    ]);

    await expect(
      runMediaUnderstandingFile({
        agentDir: "/tmp/agent",
        capability: "image",
        cfg: {
          tools: {
            media: {
              image: {
                enabled: false,
              },
            },
          },
        } as OpenClawConfig,
        filePath: "/tmp/sample.jpg",
        mime: "image/jpeg",
      }),
    ).resolves.toEqual({
      model: undefined,
      output: undefined,
      provider: undefined,
      text: undefined,
    });

    expect(mocks.buildProviderRegistry).not.toHaveBeenCalled();
    expect(mocks.runCapability).not.toHaveBeenCalled();
  });

  it("returns the matching capability output", async () => {
    const output: MediaUnderstandingOutput = {
      attachmentIndex: 0,
      kind: "image.description",
      model: "vision-v1",
      provider: "vision-plugin",
      text: "image ok",
    };
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, mime: "image/jpeg", path: "/tmp/sample.jpg" },
    ]);
    mocks.runCapability.mockResolvedValue({
      outputs: [output],
    });

    await expect(
      describeImageFile({
        agentDir: "/tmp/agent",
        cfg: {} as OpenClawConfig,
        filePath: "/tmp/sample.jpg",
        mime: "image/jpeg",
      }),
    ).resolves.toEqual({
      model: "vision-v1",
      output,
      provider: "vision-plugin",
      text: "image ok",
    });

    expect(mocks.runCapability).toHaveBeenCalledTimes(1);
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });
});
