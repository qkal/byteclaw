import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readFileUtf8AndCleanup,
  stubFetchTextResponse,
} from "../test-utils/camera-url-test-helpers.js";
import { createNodesTool } from "./tools/nodes-tool.js";

const { callGateway } = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({ callGateway }));
vi.mock("../media/image-ops.js", () => ({
  getImageMetadata: vi.fn(async () => ({ height: 1, width: 1 })),
  resizeToJpeg: vi.fn(async () => Buffer.from("jpeg")),
}));

const NODE_ID = "mac-1";
const JPG_PAYLOAD = {
  base64: "aGVsbG8=",
  format: "jpg",
  height: 1,
  width: 1,
} as const;
const PHOTOS_LATEST_ACTION_INPUT = { action: "photos_latest", node: NODE_ID } as const;
const PHOTOS_LATEST_DEFAULT_PARAMS = {
  limit: 1,
  maxWidth: 1600,
  quality: 0.85,
} as const;
const PHOTOS_LATEST_PAYLOAD = {
  photos: [
    {
      base64: "aGVsbG8=",
      createdAt: "2026-03-04T00:00:00Z",
      format: "jpeg",
      height: 1,
      width: 1,
    },
  ],
} as const;

interface GatewayCall { method: string; params?: unknown }

function unexpectedGatewayMethod(method: unknown): never {
  throw new Error(`unexpected method: ${String(method)}`);
}

function getNodesTool(options?: { modelHasVision?: boolean; allowMediaInvokeCommands?: boolean }) {
  return createNodesTool({
    ...(options?.modelHasVision !== undefined ? { modelHasVision: options.modelHasVision } : {}),
    ...(options?.allowMediaInvokeCommands !== undefined
      ? { allowMediaInvokeCommands: options.allowMediaInvokeCommands }
      : {}),
  });
}

async function executeNodes(
  input: Record<string, unknown>,
  options?: { modelHasVision?: boolean; allowMediaInvokeCommands?: boolean },
) {
  return getNodesTool(options).execute("call1", input as never);
}

type NodesToolResult = Awaited<ReturnType<typeof executeNodes>>;
type GatewayMockResult = Record<string, unknown> | null | undefined;

function mockNodeList(params?: { commands?: string[]; remoteIp?: string }) {
  return {
    nodes: [
      {
        nodeId: NODE_ID,
        ...(params?.commands ? { commands: params.commands } : {}),
        ...(params?.remoteIp ? { remoteIp: params.remoteIp } : {}),
      },
    ],
  };
}

function expectSingleImage(result: NodesToolResult, params?: { mimeType?: string }) {
  const images = (result.content ?? []).filter((block) => block.type === "image");
  expect(images).toHaveLength(1);
  if (params?.mimeType) {
    expect(images[0]?.mimeType).toBe(params.mimeType);
  }
}

function expectNoImages(result: NodesToolResult) {
  const images = (result.content ?? []).filter((block) => block.type === "image");
  expect(images).toHaveLength(0);
}

function expectFirstMediaUrl(result: NodesToolResult): string {
  const details = result.details as { media?: { mediaUrls?: string[] } } | undefined;
  const mediaUrl = details?.media?.mediaUrls?.[0];
  expect(typeof mediaUrl).toBe("string");
  return mediaUrl ?? "";
}

function expectFirstTextContains(result: NodesToolResult, expectedText: string) {
  expect(result.content?.[0]).toMatchObject({
    text: expect.stringContaining(expectedText),
    type: "text",
  });
}

function parseFirstTextJson(result: NodesToolResult): unknown {
  const first = result.content?.[0];
  expect(first).toMatchObject({ type: "text" });
  const text = first?.type === "text" ? first.text : "";
  return JSON.parse(text);
}

function setupNodeInvokeMock(params: {
  commands?: string[];
  remoteIp?: string;
  onInvoke?: (invokeParams: unknown) => GatewayMockResult | Promise<GatewayMockResult>;
  invokePayload?: unknown;
}) {
  callGateway.mockImplementation(async ({ method, params: invokeParams }: GatewayCall) => {
    if (method === "node.list") {
      return mockNodeList({ commands: params.commands, remoteIp: params.remoteIp });
    }
    if (method === "node.invoke") {
      if (params.onInvoke) {
        return await params.onInvoke(invokeParams);
      }
      if (params.invokePayload !== undefined) {
        return { payload: params.invokePayload };
      }
      return { payload: {} };
    }
    return unexpectedGatewayMethod(method);
  });
}

function setupPhotosLatestMock(params?: { remoteIp?: string }) {
  setupNodeInvokeMock({
    ...(params?.remoteIp ? { remoteIp: params.remoteIp } : {}),
    onInvoke: (invokeParams) => {
      expect(invokeParams).toMatchObject({
        command: "photos.latest",
        params: PHOTOS_LATEST_DEFAULT_PARAMS,
      });
      return { payload: PHOTOS_LATEST_PAYLOAD };
    },
  });
}

async function executePhotosLatest(params: { modelHasVision: boolean }) {
  return executeNodes(PHOTOS_LATEST_ACTION_INPUT, {
    modelHasVision: params.modelHasVision,
  });
}

beforeEach(() => {
  callGateway.mockClear();
  vi.unstubAllGlobals();
});

describe("nodes camera_snap", () => {
  it("uses front/high-quality defaults when params are omitted", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "camera.snap",
          params: {
            facing: "front",
            maxWidth: 1600,
            quality: 0.95,
          },
        });
        return { payload: JPG_PAYLOAD };
      },
    });

    const result = await executeNodes(
      {
        action: "camera_snap",
        node: NODE_ID,
      },
      { modelHasVision: true },
    );

    expectSingleImage(result);
  });

  it("maps jpg payloads to image/jpeg", async () => {
    setupNodeInvokeMock({
      invokePayload: JPG_PAYLOAD,
    });

    const result = await executeNodes(
      {
        action: "camera_snap",
        facing: "front",
        node: NODE_ID,
      },
      { modelHasVision: true },
    );

    expectSingleImage(result, { mimeType: "image/jpeg" });
  });

  it("omits inline base64 image blocks when model has no vision", async () => {
    setupNodeInvokeMock({
      invokePayload: JPG_PAYLOAD,
    });

    const result = await executeNodes(
      {
        action: "camera_snap",
        facing: "front",
        node: NODE_ID,
      },
      { modelHasVision: false },
    );

    expectNoImages(result);
    expect(result.content ?? []).toEqual([]);
    expect(expectFirstMediaUrl(result)).toMatch(/openclaw-camera-snap-front-.*\.jpg$/);
  });

  it("passes deviceId when provided", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "camera.snap",
          params: { deviceId: "cam-123" },
        });
        return { payload: JPG_PAYLOAD };
      },
    });

    await executeNodes({
      action: "camera_snap",
      deviceId: "cam-123",
      facing: "front",
      node: NODE_ID,
    });
  });

  it("rejects facing both when deviceId is provided", async () => {
    await expect(
      executeNodes({
        action: "camera_snap",
        deviceId: "cam-123",
        facing: "both",
        node: NODE_ID,
      }),
    ).rejects.toThrow(/facing=both is not allowed when deviceId is set/i);
  });

  it("downloads camera_snap url payloads when node remoteIp is available", async () => {
    stubFetchTextResponse("url-image");
    setupNodeInvokeMock({
      invokePayload: {
        format: "jpg",
        height: 1,
        url: "https://198.51.100.42/snap.jpg",
        width: 1,
      },
      remoteIp: "198.51.100.42",
    });

    const result = await executeNodes({
      action: "camera_snap",
      facing: "front",
      node: NODE_ID,
    });

    expect(result.content ?? []).toEqual([]);
    await expect(readFileUtf8AndCleanup(expectFirstMediaUrl(result))).resolves.toBe("url-image");
  });

  it("rejects camera_snap url payloads when node remoteIp is missing", async () => {
    stubFetchTextResponse("url-image");
    setupNodeInvokeMock({
      invokePayload: {
        format: "jpg",
        height: 1,
        url: "https://198.51.100.42/snap.jpg",
        width: 1,
      },
    });

    await expect(
      executeNodes({
        action: "camera_snap",
        facing: "front",
        node: NODE_ID,
      }),
    ).rejects.toThrow(/node remoteip/i);
  });
});

describe("nodes camera_clip", () => {
  it("downloads camera_clip url payloads when node remoteIp is available", async () => {
    stubFetchTextResponse("url-clip");
    setupNodeInvokeMock({
      invokePayload: {
        durationMs: 1200,
        format: "mp4",
        hasAudio: false,
        url: "https://198.51.100.42/clip.mp4",
      },
      remoteIp: "198.51.100.42",
    });

    const result = await executeNodes({
      action: "camera_clip",
      facing: "front",
      node: NODE_ID,
    });
    const filePath = String((result.content?.[0] as { text?: string } | undefined)?.text ?? "")
      .replace(/^FILE:/, "")
      .trim();
    await expect(readFileUtf8AndCleanup(filePath)).resolves.toBe("url-clip");
  });

  it("rejects camera_clip url payloads when node remoteIp is missing", async () => {
    stubFetchTextResponse("url-clip");
    setupNodeInvokeMock({
      invokePayload: {
        durationMs: 1200,
        format: "mp4",
        hasAudio: false,
        url: "https://198.51.100.42/clip.mp4",
      },
    });

    await expect(
      executeNodes({
        action: "camera_clip",
        facing: "front",
        node: NODE_ID,
      }),
    ).rejects.toThrow(/node remoteip/i);
  });
});

describe("nodes photos_latest", () => {
  it("returns empty content/details when no photos are available", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "photos.latest",
          params: {
            limit: 1,
            maxWidth: 1600,
            quality: 0.85,
          },
        });
        return {
          payload: {
            photos: [],
          },
        };
      },
    });

    const result = await executeNodes(
      {
        action: "photos_latest",
        node: NODE_ID,
      },
      { modelHasVision: false },
    );

    expect(result.content ?? []).toEqual([]);
    expect(result.details).toEqual([]);
  });

  it("returns MEDIA paths and no inline images when model has no vision", async () => {
    setupPhotosLatestMock({ remoteIp: "198.51.100.42" });

    const result = await executePhotosLatest({ modelHasVision: false });

    expectNoImages(result);
    expect(result.content ?? []).toEqual([]);
    const details =
      (result.details as { photos?: Record<string, unknown>[] } | undefined)?.photos ?? [];
    expect(details[0]).toMatchObject({
      createdAt: "2026-03-04T00:00:00Z",
      height: 1,
      width: 1,
    });
    expect(expectFirstMediaUrl(result)).toMatch(/openclaw-camera-snap-.*\.jpg$/);
  });

  it("includes inline image blocks when model has vision", async () => {
    setupPhotosLatestMock();

    const result = await executePhotosLatest({ modelHasVision: true });

    expectSingleImage(result, { mimeType: "image/jpeg" });
    expect(expectFirstMediaUrl(result)).toMatch(/openclaw-camera-snap-.*\.jpg$/);
  });
});

describe("nodes notifications_list", () => {
  it("invokes notifications.list and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["notifications.list"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "notifications.list",
          nodeId: NODE_ID,
          params: {},
        });
        return {
          payload: {
            connected: true,
            count: 1,
            enabled: true,
            notifications: [{ key: "n1", packageName: "com.example.app" }],
          },
        };
      },
    });

    const result = await executeNodes({
      action: "notifications_list",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"notifications"');
    expect(parseFirstTextJson(result)).toMatchObject({
      connected: true,
      count: 1,
      enabled: true,
      notifications: [{ key: "n1", packageName: "com.example.app" }],
    });
  });
});

describe("nodes notifications_action", () => {
  it("invokes notifications.actions dismiss", async () => {
    setupNodeInvokeMock({
      commands: ["notifications.actions"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "notifications.actions",
          nodeId: NODE_ID,
          params: {
            action: "dismiss",
            key: "n1",
          },
        });
        return { payload: { action: "dismiss", key: "n1", ok: true } };
      },
    });

    const result = await executeNodes({
      action: "notifications_action",
      node: NODE_ID,
      notificationAction: "dismiss",
      notificationKey: "n1",
    });

    expectFirstTextContains(result, '"dismiss"');
    expect(parseFirstTextJson(result)).toMatchObject({
      action: "dismiss",
      key: "n1",
      ok: true,
    });
  });

  it("invokes notifications.actions reply with reply text", async () => {
    setupNodeInvokeMock({
      commands: ["notifications.actions"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "notifications.actions",
          nodeId: NODE_ID,
          params: {
            action: "reply",
            key: "n2",
            replyText: "On it",
          },
        });
        return { payload: { action: "reply", key: "n2", ok: true } };
      },
    });

    const result = await executeNodes({
      action: "notifications_action",
      node: NODE_ID,
      notificationAction: "reply",
      notificationKey: "n2",
      notificationReplyText: " On it ",
    });

    expect(parseFirstTextJson(result)).toMatchObject({
      action: "reply",
      key: "n2",
      ok: true,
    });
  });
});

describe("nodes location_get", () => {
  it("invokes location.get and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["location.get"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "location.get",
          nodeId: NODE_ID,
          params: {
            desiredAccuracy: "balanced",
            maxAgeMs: 12_000,
            timeoutMs: 4500,
          },
        });
        return {
          payload: {
            accuracyMeters: 18,
            latitude: 37.3346,
            longitude: -122.009,
            provider: "network",
          },
        };
      },
    });

    const result = await executeNodes({
      action: "location_get",
      desiredAccuracy: "balanced",
      locationTimeoutMs: 4500,
      maxAgeMs: 12_000,
      node: NODE_ID,
    });

    expect(parseFirstTextJson(result)).toMatchObject({
      accuracyMeters: 18,
      latitude: 37.3346,
      longitude: -122.009,
      provider: "network",
    });
  });
});

describe("nodes device_status and device_info", () => {
  it("invokes device.status and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["device.status", "device.info"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "device.status",
          nodeId: NODE_ID,
          params: {},
        });
        return {
          payload: {
            battery: { lowPowerModeEnabled: false, state: "charging" },
          },
        };
      },
    });

    const result = await executeNodes({
      action: "device_status",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"battery"');
  });

  it("invokes device.info and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["device.status", "device.info"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "device.info",
          nodeId: NODE_ID,
          params: {},
        });
        return {
          payload: {
            appVersion: "1.0.0",
            systemName: "Android",
          },
        };
      },
    });

    const result = await executeNodes({
      action: "device_info",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"systemName"');
  });

  it("invokes device.permissions and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["device.permissions"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "device.permissions",
          nodeId: NODE_ID,
          params: {},
        });
        return {
          payload: {
            permissions: {
              camera: { promptable: false, status: "granted" },
              sms: {
                capabilities: {
                  read: { promptable: false, status: "granted" },
                  send: { promptable: true, status: "denied" },
                },
                promptable: true,
                status: "denied",
              },
            },
          },
        };
      },
    });

    const result = await executeNodes({
      action: "device_permissions",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"permissions"');
    expect(parseFirstTextJson(result)).toMatchObject({
      permissions: {
        sms: {
          capabilities: {
            read: { promptable: false, status: "granted" },
            send: { promptable: true, status: "denied" },
          },
          promptable: true,
          status: "denied",
        },
      },
    });
  });

  it("invokes device.health and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["device.health"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "device.health",
          nodeId: NODE_ID,
          params: {},
        });
        return {
          payload: {
            battery: { chargingType: "usb" },
            memory: { pressure: "normal" },
          },
        };
      },
    });

    const result = await executeNodes({
      action: "device_health",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"memory"');
  });
});

describe("nodes invoke", () => {
  it("allows metadata-only camera.list via generic invoke", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "camera.list",
          params: {},
        });
        return {
          payload: {
            devices: [{ id: "cam-back", name: "Back Camera" }],
          },
        };
      },
    });

    const result = await executeNodes({
      action: "invoke",
      invokeCommand: "camera.list",
      node: NODE_ID,
    });

    expect(result.details).toMatchObject({
      payload: {
        devices: [{ id: "cam-back", name: "Back Camera" }],
      },
    });
  });

  it("blocks media invoke commands to avoid base64 context bloat", async () => {
    await expect(
      executeNodes({
        action: "invoke",
        invokeCommand: "photos.latest",
        invokeParamsJson: '{"limit":1}',
        node: NODE_ID,
      }),
    ).rejects.toThrow(/use action="photos_latest"/i);
  });

  it("allows media invoke commands when explicitly enabled", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "photos.latest",
          params: { limit: 1 },
        });
        return {
          payload: {
            photos: [{ base64: "aGVsbG8=", format: "jpg", height: 1, width: 1 }],
          },
        };
      },
    });

    const result = await executeNodes(
      {
        action: "invoke",
        invokeCommand: "photos.latest",
        invokeParamsJson: '{"limit":1}',
        node: NODE_ID,
      },
      { allowMediaInvokeCommands: true },
    );

    expect(result.details).toMatchObject({
      payload: {
        photos: [{ base64: "aGVsbG8=", format: "jpg", height: 1, width: 1 }],
      },
    });
  });
});
