import type { MockFn } from "openclaw/plugin-sdk/testing";
import { vi } from "vitest";

interface DiscordWebMediaMockFactoryResult {
  loadWebMedia: MockFn;
  loadWebMediaRaw: MockFn;
}

interface DiscordRestFactoryResult {
  rest: import("@buape/carbon").RequestClient;
  postMock: MockFn;
  putMock: MockFn;
  getMock: MockFn;
  patchMock: MockFn;
  deleteMock: MockFn;
}

export function discordWebMediaMockFactory(): DiscordWebMediaMockFactoryResult {
  return {
    loadWebMedia: vi.fn().mockResolvedValue({
      buffer: Buffer.from("img"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
      kind: "image",
    }),
    loadWebMediaRaw: vi.fn().mockResolvedValue({
      buffer: Buffer.from("img"),
      contentType: "image/png",
      fileName: "asset.png",
      kind: "image",
    }),
  };
}

export function makeDiscordRest(): DiscordRestFactoryResult {
  const postMock = vi.fn() as unknown as MockFn;
  const putMock = vi.fn() as unknown as MockFn;
  const getMock = vi.fn() as unknown as MockFn;
  const patchMock = vi.fn() as unknown as MockFn;
  const deleteMock = vi.fn() as unknown as MockFn;

  return {
    deleteMock,
    getMock,
    patchMock,
    postMock,
    putMock,
    rest: {
      delete: deleteMock,
      get: getMock,
      patch: patchMock,
      post: postMock,
      put: putMock,
    } as unknown as import("@buape/carbon").RequestClient,
  };
}
