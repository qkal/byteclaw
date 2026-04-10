import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../../runtime-api.js";
import { setMatrixRuntime } from "../../runtime.js";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import { downloadMatrixMedia } from "./media.js";

function createEncryptedClient() {
  const decryptMedia = vi.fn().mockResolvedValue(Buffer.from("decrypted"));

  return {
    client: {
      crypto: { decryptMedia },
      mxcToHttp: vi.fn().mockReturnValue("https://example/mxc"),
    } as unknown as import("../sdk.js").MatrixClient,
    decryptMedia,
  };
}

function createEncryptedFile() {
  return {
    hashes: { sha256: "hash" },
    iv: "iv",
    key: {
      alg: "A256CTR",
      ext: true,
      k: "secret",
      key_ops: ["encrypt", "decrypt"],
      kty: "oct",
    },
    url: "mxc://example/file",
    v: "v2",
  };
}

describe("downloadMatrixMedia", () => {
  const saveMediaBuffer = vi.fn().mockResolvedValue({
    contentType: "image/png",
    path: "/tmp/media",
  });

  const runtimeStub = {
    channel: {
      media: {
        saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
      },
    },
  } as unknown as PluginRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    setMatrixRuntime(runtimeStub);
  });

  it("decrypts encrypted media when file payloads are present", async () => {
    const { client, decryptMedia } = createEncryptedClient();
    const file = createEncryptedFile();

    const result = await downloadMatrixMedia({
      client,
      contentType: "image/png",
      file,
      maxBytes: 1024,
      mxcUrl: "mxc://example/file",
    });

    expect(decryptMedia).toHaveBeenCalledWith(file, {
      maxBytes: 1024,
      readIdleTimeoutMs: 30_000,
    });
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("decrypted"),
      "image/png",
      "inbound",
      1024,
      undefined,
    );
    expect(result?.path).toBe("/tmp/media");
  });

  it("forwards originalFilename to saveMediaBuffer when provided", async () => {
    const { client } = createEncryptedClient();
    const file = createEncryptedFile();

    await downloadMatrixMedia({
      client,
      contentType: "image/png",
      file,
      maxBytes: 1024,
      mxcUrl: "mxc://example/file",
      originalFilename: "Screenshot 2026-03-27.png",
    });

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("decrypted"),
      "image/png",
      "inbound",
      1024,
      "Screenshot 2026-03-27.png",
    );
  });

  it("rejects encrypted media that exceeds maxBytes before decrypting", async () => {
    const { client, decryptMedia } = createEncryptedClient();
    const file = createEncryptedFile();

    await expect(
      downloadMatrixMedia({
        client,
        contentType: "image/png",
        file,
        maxBytes: 1024,
        mxcUrl: "mxc://example/file",
        sizeBytes: 2048,
      }),
    ).rejects.toBeInstanceOf(MatrixMediaSizeLimitError);

    expect(decryptMedia).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
  });

  it("preserves typed size-limit errors from plain media downloads", async () => {
    const tooLargeError = new MatrixMediaSizeLimitError(
      "Matrix media exceeds configured size limit (8192 bytes > 4096 bytes)",
    );
    const downloadContent = vi.fn().mockRejectedValue(tooLargeError);
    const client = {
      downloadContent,
    } as unknown as import("../sdk.js").MatrixClient;

    await expect(
      downloadMatrixMedia({
        client,
        contentType: "image/png",
        maxBytes: 4096,
        mxcUrl: "mxc://example/file",
      }),
    ).rejects.toBe(tooLargeError);
  });

  it("passes byte limits through plain media downloads", async () => {
    const downloadContent = vi.fn().mockResolvedValue(Buffer.from("plain"));

    const client = {
      downloadContent,
    } as unknown as import("../sdk.js").MatrixClient;

    await downloadMatrixMedia({
      client,
      contentType: "image/png",
      maxBytes: 4096,
      mxcUrl: "mxc://example/file",
    });

    expect(downloadContent).toHaveBeenCalledWith("mxc://example/file", {
      maxBytes: 4096,
      readIdleTimeoutMs: 30_000,
    });
  });
});
