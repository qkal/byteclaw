import { beforeEach, describe, expect, it, vi } from "vitest";

const createMatrixClientMock = vi.fn();
const isBunRuntimeMock = vi.fn(() => false);

vi.mock("./probe.runtime.js", () => ({
  createMatrixClient: (...args: unknown[]) => createMatrixClientMock(...args),
}));

vi.mock("./client/runtime.js", () => ({
  isBunRuntime: () => isBunRuntimeMock(),
}));

import { probeMatrix } from "./probe.js";

describe("probeMatrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isBunRuntimeMock.mockReturnValue(false);
    createMatrixClientMock.mockResolvedValue({
      getUserId: vi.fn(async () => "@bot:example.org"),
    });
  });

  it("passes undefined userId when not provided", async () => {
    const result = await probeMatrix({
      accessToken: "tok",
      homeserver: "https://matrix.example.org",
      timeoutMs: 1234,
    });

    expect(result.ok).toBe(true);
    expect(createMatrixClientMock).toHaveBeenCalledWith({
      accessToken: "tok",
      homeserver: "https://matrix.example.org",
      localTimeoutMs: 1234,
      persistStorage: false,
      userId: undefined,
    });
  });

  it("trims provided userId before client creation", async () => {
    await probeMatrix({
      accessToken: "tok",
      homeserver: "https://matrix.example.org",
      timeoutMs: 500,
      userId: "  @bot:example.org  ",
    });

    expect(createMatrixClientMock).toHaveBeenCalledWith({
      accessToken: "tok",
      homeserver: "https://matrix.example.org",
      localTimeoutMs: 500,
      persistStorage: false,
      userId: "@bot:example.org",
    });
  });

  it("passes accountId through to client creation", async () => {
    await probeMatrix({
      accessToken: "tok",
      accountId: "ops",
      homeserver: "https://matrix.example.org",
      timeoutMs: 500,
      userId: "@bot:example.org",
    });

    expect(createMatrixClientMock).toHaveBeenCalledWith({
      accessToken: "tok",
      accountId: "ops",
      homeserver: "https://matrix.example.org",
      localTimeoutMs: 500,
      persistStorage: false,
      userId: "@bot:example.org",
    });
  });

  it("passes dispatcherPolicy through to client creation", async () => {
    await probeMatrix({
      accessToken: "tok",
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://127.0.0.1:7890",
      },
      homeserver: "https://matrix.example.org",
      timeoutMs: 500,
    });

    expect(createMatrixClientMock).toHaveBeenCalledWith({
      accessToken: "tok",
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://127.0.0.1:7890",
      },
      homeserver: "https://matrix.example.org",
      localTimeoutMs: 500,
      persistStorage: false,
      userId: undefined,
    });
  });

  it("passes deviceId through to client creation (#61317)", async () => {
    await probeMatrix({
      accessToken: "tok",
      accountId: "ops",
      deviceId: "ABCDEF",
      homeserver: "https://matrix.example.org",
      timeoutMs: 500,
      userId: "@bot:example.org",
    });

    expect(createMatrixClientMock).toHaveBeenCalledWith({
      accessToken: "tok",
      accountId: "ops",
      deviceId: "ABCDEF",
      homeserver: "https://matrix.example.org",
      localTimeoutMs: 500,
      persistStorage: false,
      userId: "@bot:example.org",
    });
  });

  it("omits deviceId when not provided", async () => {
    await probeMatrix({
      accessToken: "tok",
      homeserver: "https://matrix.example.org",
      timeoutMs: 500,
    });

    expect(createMatrixClientMock).toHaveBeenCalledWith({
      accessToken: "tok",
      deviceId: undefined,
      homeserver: "https://matrix.example.org",
      localTimeoutMs: 500,
      persistStorage: false,
      userId: undefined,
    });
  });

  it("returns client validation errors for insecure public http homeservers", async () => {
    createMatrixClientMock.mockRejectedValue(
      new Error("Matrix homeserver must use https:// unless it targets a private or loopback host"),
    );

    const result = await probeMatrix({
      accessToken: "tok",
      homeserver: "http://matrix.example.org",
      timeoutMs: 500,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Matrix homeserver must use https://");
  });
});
