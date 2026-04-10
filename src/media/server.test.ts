import fs from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";

let MEDIA_DIR = "";
const cleanOldMedia = vi.fn().mockResolvedValue(undefined);

vi.mock("./store.js", async () => {
  const actual = await vi.importActual<typeof import("./store.js")>("./store.js");
  return {
    ...actual,
    cleanOldMedia,
    getMediaDir: () => MEDIA_DIR,
  };
});

let startMediaServer: typeof import("./server.js").startMediaServer;
let MEDIA_MAX_BYTES: typeof import("./store.js").MEDIA_MAX_BYTES;
let realFetch: typeof import("undici").fetch;
const mediaRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-media-test-" });
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

async function waitForFileRemoval(filePath: string, maxTicks = 1000) {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    try {
      await fs.stat(filePath);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${filePath} removal`);
}

describe("media server", () => {
  let server: Awaited<ReturnType<typeof startMediaServer>> | undefined;
  let listenBlocked = false;
  let port = 0;

  function mediaUrl(id: string) {
    return `http://127.0.0.1:${port}/media/${id}`;
  }

  async function writeMediaFile(id: string, contents: string) {
    const filePath = path.join(MEDIA_DIR, id);
    await fs.writeFile(filePath, contents);
    return filePath;
  }

  async function ageMediaFile(filePath: string) {
    const past = Date.now() - 10_000;
    await fs.utimes(filePath, past / 1000, past / 1000);
  }

  async function expectMissingMediaFile(filePath: string) {
    await expect(fs.stat(filePath)).rejects.toThrow();
  }

  function expectFetchedResponse(
    response: Awaited<ReturnType<typeof realFetch>>,
    expected: { status: number; noSniff?: boolean },
  ) {
    expect(response.status).toBe(expected.status);
    if (expected.noSniff) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  }

  async function expectMediaFileLifecycleCase(params: {
    id: string;
    contents: string;
    expectedStatus: number;
    expectedBody?: string;
    mutateFile?: (filePath: string) => Promise<void>;
    assertAfterFetch?: (filePath: string) => Promise<void>;
  }) {
    const file = await writeMediaFile(params.id, params.contents);
    await params.mutateFile?.(file);
    const res = await withEnvAsync(LOOPBACK_FETCH_ENV, () => realFetch(mediaUrl(params.id)));
    expectFetchedResponse(res, { status: params.expectedStatus });
    if (params.expectedBody !== undefined) {
      expect(await res.text()).toBe(params.expectedBody);
    }
    await params.assertAfterFetch?.(file);
  }

  async function expectFetchedMediaCase(params: {
    mediaPath: string;
    expectedStatus: number;
    expectedBody?: string;
    expectedNoSniff?: boolean;
    setup?: () => Promise<void>;
  }) {
    await params.setup?.();
    const res = await withEnvAsync(LOOPBACK_FETCH_ENV, () => realFetch(mediaUrl(params.mediaPath)));
    expectFetchedResponse(res, {
      status: params.expectedStatus,
      ...(params.expectedNoSniff ? { noSniff: true } : {}),
    });
    if (params.expectedBody !== undefined) {
      expect(await res.text()).toBe(params.expectedBody);
    }
  }

  beforeAll(async () => {
    vi.useRealTimers();
    vi.doUnmock("undici");
    const require = createRequire(import.meta.url);
    ({ startMediaServer } = await import("./server.js"));
    ({ MEDIA_MAX_BYTES } = await import("./store.js"));
    ({ fetch: realFetch } = require("undici") as typeof import("undici"));
    await mediaRootTracker.setup();
    MEDIA_DIR = await mediaRootTracker.make("case");
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
    ({ port } = (boundServer.address() as AddressInfo));
  });

  afterAll(async () => {
    const boundServer = server;
    if (boundServer) {
      await new Promise((r) => boundServer.close(r));
    }
    await mediaRootTracker.cleanup();
    MEDIA_DIR = "";
  });

  it.each([
    {
      assertAfterFetch: async (filePath: string) => {
        await waitForFileRemoval(filePath);
      },
      contents: "hello",
      expectedBody: "hello",
      expectedStatus: 200,
      id: "file1",
      name: "serves media and cleans up after send",
    },
    {
      assertAfterFetch: expectMissingMediaFile,
      contents: "stale",
      expectedStatus: 410,
      id: "old",
      mutateFile: ageMediaFile,
      name: "expires old media",
    },
  ] as const)("$name", async (testCase) => {
    if (listenBlocked) {
      return;
    }
    await expectMediaFileLifecycleCase(testCase);
  });

  it.each([
    {
      expectedBody: "invalid path",
      expectedStatus: 400,
      mediaPath: "%2e%2e%2fpackage.json",
      testName: "blocks path traversal attempts",
    },
    {
      expectedBody: "invalid path",
      expectedStatus: 400,
      mediaPath: "invalid%20id",
      setup: async () => {
        await writeMediaFile("file2", "hello");
      },
      testName: "rejects invalid media ids",
    },
    {
      expectedBody: "invalid path",
      expectedStatus: 400,
      mediaPath: "link-out",
      setup: async () => {
        const target = path.join(process.cwd(), "package.json"); // Outside MEDIA_DIR
        const link = path.join(MEDIA_DIR, "link-out");
        await fs.symlink(target, link);
      },
      testName: "blocks symlink escaping outside media dir",
    },
    {
      expectedBody: "too large",
      expectedStatus: 413,
      mediaPath: "big",
      name: "rejects oversized media files",
      setup: async () => {
        const file = await writeMediaFile("big", "");
        await fs.truncate(file, MEDIA_MAX_BYTES + 1);
      },
    },
    {
      expectedBody: "not found",
      expectedNoSniff: true,
      expectedStatus: 404,
      mediaPath: "missing-file",
      name: "returns not found for missing media IDs",
    },
    {
      expectedStatus: 404,
      mediaPath: ".",
      name: "returns 404 when route param is missing (dot path)",
    },
    {
      expectedBody: "invalid path",
      expectedStatus: 400,
      mediaPath: `${"a".repeat(201)}.txt`,
      name: "rejects overlong media id",
    },
  ] as const)("%#", async (testCase) => {
    if (listenBlocked) {
      return;
    }
    await expectFetchedMediaCase(testCase);
  });
});
