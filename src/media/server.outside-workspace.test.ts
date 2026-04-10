import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  cleanOldMedia: vi.fn().mockResolvedValue(undefined),
  isSafeOpenError: vi.fn(
    (error: unknown) => typeof error === "object" && error !== null && "code" in error,
  ),
  readFileWithinRoot: vi.fn(),
}));

let mediaDir = "";

vi.mock("./server.runtime.js", () => ({
  MEDIA_MAX_BYTES: 5 * 1024 * 1024,
  cleanOldMedia: mocks.cleanOldMedia,
  getMediaDir: () => mediaDir,
  isSafeOpenError: mocks.isSafeOpenError,
  readFileWithinRoot: mocks.readFileWithinRoot,
}));

let startMediaServer: typeof import("./server.js").startMediaServer;
let realFetch: typeof import("undici").fetch;
const mediaRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-media-outside-workspace-",
});
const LOOPBACK_FETCH_ENV = {
  ALL_PROXY: undefined,
  HTTPS_PROXY: undefined,
  HTTP_PROXY: undefined,
  NO_PROXY: "127.0.0.1,localhost",
  all_proxy: undefined,
  http_proxy: undefined,
  https_proxy: undefined,
  no_proxy: "127.0.0.1,localhost",
} as const;

async function expectOutsideWorkspaceServerResponse(url: string) {
  const response = await withEnvAsync(LOOPBACK_FETCH_ENV, () => realFetch(url));
  expect(response.status).toBe(400);
  expect(await response.text()).toBe("file is outside workspace root");
}

describe("media server outside-workspace mapping", () => {
  let server: Awaited<ReturnType<typeof startMediaServer>> | undefined;
  let listenBlocked = false;
  let port = 0;

  beforeAll(async () => {
    vi.useRealTimers();
    vi.doUnmock("undici");
    const require = createRequire(import.meta.url);
    ({ startMediaServer } = await import("./server.js"));
    ({ fetch: realFetch } = require("undici") as typeof import("undici"));
    await mediaRootTracker.setup();
    mediaDir = await mediaRootTracker.make("case");
    try {
      server = await startMediaServer(0, 1000);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        listenBlocked = true;
        return;
      }
      throw error;
    }
    const boundServer = server;
    if (!boundServer) {
      return;
    }
    ({ port } = boundServer.address() as AddressInfo);
  });

  beforeEach(() => {
    mocks.readFileWithinRoot.mockReset();
    mocks.cleanOldMedia.mockClear();
  });

  afterAll(async () => {
    const boundServer = server;
    if (boundServer) {
      await new Promise((resolve) => boundServer.close(resolve));
    }
    await mediaRootTracker.cleanup();
    mediaDir = "";
  });

  it("returns 400 with a specific outside-workspace message", async () => {
    if (listenBlocked) {
      return;
    }
    mocks.readFileWithinRoot.mockRejectedValueOnce({
      code: "outside-workspace",
      message: "file is outside workspace root",
    });

    await expectOutsideWorkspaceServerResponse(`http://127.0.0.1:${port}/media/ok-id`);
  });
});
