import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readFileUtf8AndCleanup,
  stubFetchResponse,
} from "../test-utils/camera-url-test-helpers.js";
import { withTempDir } from "../test-utils/temp-dir.js";

const fetchGuardMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(async (params: { url: string }) => ({
      finalUrl: params.url,
      release: async () => {},
      response: await globalThis.fetch(params.url),
    })),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchGuardMocks.fetchWithSsrFGuard,
}));

let cameraTempPath: typeof import("./nodes-camera.js").cameraTempPath;
let parseCameraClipPayload: typeof import("./nodes-camera.js").parseCameraClipPayload;
let parseCameraSnapPayload: typeof import("./nodes-camera.js").parseCameraSnapPayload;
let writeCameraClipPayloadToFile: typeof import("./nodes-camera.js").writeCameraClipPayloadToFile;
let writeBase64ToFile: typeof import("./nodes-camera.js").writeBase64ToFile;
let writeUrlToFile: typeof import("./nodes-camera.js").writeUrlToFile;
let parseScreenRecordPayload: typeof import("./nodes-screen.js").parseScreenRecordPayload;
let screenRecordTempPath: typeof import("./nodes-screen.js").screenRecordTempPath;

async function withCameraTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  return await withTempDir("openclaw-test-", run);
}

describe("nodes camera helpers", () => {
  beforeAll(async () => {
    ({
      cameraTempPath,
      parseCameraClipPayload,
      parseCameraSnapPayload,
      writeCameraClipPayloadToFile,
      writeBase64ToFile,
      writeUrlToFile,
    } = await import("./nodes-camera.js"));
    ({ parseScreenRecordPayload, screenRecordTempPath } = await import("./nodes-screen.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses camera.snap payload", () => {
    expect(
      parseCameraSnapPayload({
        base64: "aGk=",
        format: "jpg",
        height: 20,
        width: 10,
      }),
    ).toEqual({ base64: "aGk=", format: "jpg", height: 20, width: 10 });
  });

  it("rejects invalid camera.snap payload", () => {
    expect(() => parseCameraSnapPayload({ format: "jpg" })).toThrow(
      /invalid camera\.snap payload/i,
    );
  });

  it("parses camera.clip payload", () => {
    expect(
      parseCameraClipPayload({
        base64: "AAEC",
        durationMs: 1234,
        format: "mp4",
        hasAudio: true,
      }),
    ).toEqual({
      base64: "AAEC",
      durationMs: 1234,
      format: "mp4",
      hasAudio: true,
    });
  });

  it("rejects invalid camera.clip payload", () => {
    expect(() =>
      parseCameraClipPayload({ base64: "AAEC", durationMs: 1234, format: "mp4" }),
    ).toThrow(/invalid camera\.clip payload/i);
  });

  it("builds stable temp paths when id provided", () => {
    const p = cameraTempPath({
      ext: "jpg",
      facing: "front",
      id: "id1",
      kind: "snap",
      tmpDir: "/tmp",
    });
    expect(p).toBe(path.join("/tmp", "openclaw-camera-snap-front-id1.jpg"));
  });

  it("writes camera clip payload to temp path", async () => {
    await withCameraTempDir(async (dir) => {
      const out = await writeCameraClipPayloadToFile({
        facing: "front",
        id: "clip1",
        payload: {
          base64: "aGk=",
          durationMs: 200,
          format: "mp4",
          hasAudio: false,
        },
        tmpDir: dir,
      });
      expect(out).toBe(path.join(dir, "openclaw-camera-clip-front-clip1.mp4"));
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("hi");
    });
  });

  it("writes camera clip payload from url", async () => {
    stubFetchResponse(new Response("url-clip", { status: 200 }));
    await withCameraTempDir(async (dir) => {
      const expectedHost = "198.51.100.42";
      const out = await writeCameraClipPayloadToFile({
        expectedHost,
        facing: "back",
        id: "clip2",
        payload: {
          durationMs: 200,
          format: "mp4",
          hasAudio: false,
          url: `https://${expectedHost}/clip.mp4`,
        },
        tmpDir: dir,
      });
      expect(out).toBe(path.join(dir, "openclaw-camera-clip-back-clip2.mp4"));
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("url-clip");
    });
  });

  it("rejects camera clip url payloads without node remoteIp", async () => {
    stubFetchResponse(new Response("url-clip", { status: 200 }));
    await expect(
      writeCameraClipPayloadToFile({
        facing: "back",
        payload: {
          durationMs: 200,
          format: "mp4",
          hasAudio: false,
          url: "https://198.51.100.42/clip.mp4",
        },
      }),
    ).rejects.toThrow(/node remoteip/i);
  });

  it("writes base64 to file", async () => {
    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "x.bin");
      await writeBase64ToFile(out, "aGk=");
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("hi");
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes url payload to file", async () => {
    stubFetchResponse(new Response("url-content", { status: 200 }));
    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "x.bin");
      await writeUrlToFile(out, "https://198.51.100.42/clip.mp4", {
        expectedHost: "198.51.100.42",
      });
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("url-content");
    });
  });

  it("rejects url host mismatches", async () => {
    stubFetchResponse(new Response("url-content", { status: 200 }));
    await expect(
      writeUrlToFile("/tmp/ignored", "https://198.51.100.42/clip.mp4", {
        expectedHost: "198.51.100.43",
      }),
    ).rejects.toThrow(/must match node host/i);
  });

  it.each([
    {
      expectedMessage: /only https/i,
      name: "non-https url",
      url: "http://198.51.100.42/x.bin",
    },
    {
      expectedMessage: /exceeds max/i,
      name: "oversized content-length",
      response: new Response("tiny", {
        headers: { "content-length": String(999_999_999) },
        status: 200,
      }),
      url: "https://198.51.100.42/huge.bin",
    },
    {
      expectedMessage: /503/i,
      name: "non-ok status",
      response: new Response("down", { status: 503, statusText: "Service Unavailable" }),
      url: "https://198.51.100.42/down.bin",
    },
    {
      expectedMessage: /empty response body/i,
      name: "empty response body",
      response: new Response(null, { status: 200 }),
      url: "https://198.51.100.42/empty.bin",
    },
  ] as const)(
    "rejects invalid url payload response: $name",
    async ({ url, response, expectedMessage }) => {
      if (response) {
        stubFetchResponse(response);
      }
      await expect(
        writeUrlToFile("/tmp/ignored", url, { expectedHost: "198.51.100.42" }),
      ).rejects.toThrow(expectedMessage);
    },
  );

  it("removes partially written file when url stream fails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("stream exploded"));
      },
    });
    stubFetchResponse(new Response(stream, { status: 200 }));

    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "broken.bin");
      await expect(
        writeUrlToFile(out, "https://198.51.100.42/broken.bin", { expectedHost: "198.51.100.42" }),
      ).rejects.toThrow(/stream exploded/i);
      await expect(fs.stat(out)).rejects.toThrow();
    });
  });
});

describe("nodes screen helpers", () => {
  it("parses screen.record payload", () => {
    const payload = parseScreenRecordPayload({
      base64: "Zm9v",
      durationMs: 1000,
      format: "mp4",
      fps: 12,
      hasAudio: true,
      screenIndex: 0,
    });
    expect(payload.format).toBe("mp4");
    expect(payload.base64).toBe("Zm9v");
    expect(payload.durationMs).toBe(1000);
    expect(payload.fps).toBe(12);
    expect(payload.screenIndex).toBe(0);
    expect(payload.hasAudio).toBe(true);
  });

  it("drops invalid optional fields instead of throwing", () => {
    const payload = parseScreenRecordPayload({
      base64: "Zm9v",
      durationMs: "nope",
      format: "mp4",
      fps: null,
      hasAudio: 1,
      screenIndex: "0",
    });
    expect(payload.durationMs).toBeUndefined();
    expect(payload.fps).toBeUndefined();
    expect(payload.screenIndex).toBeUndefined();
    expect(payload.hasAudio).toBeUndefined();
  });

  it("rejects invalid screen.record payload", () => {
    expect(() => parseScreenRecordPayload({ format: "mp4" })).toThrow(
      /invalid screen\.record payload/i,
    );
  });

  it("builds screen record temp path", () => {
    const p = screenRecordTempPath({
      ext: "mp4",
      id: "id1",
      tmpDir: "/tmp",
    });
    expect(p).toBe(path.join("/tmp", "openclaw-screen-record-id1.mp4"));
  });
});
