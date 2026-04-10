import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  type CameraFacing,
  cameraTempPath,
  parseCameraClipPayload,
  parseCameraSnapPayload,
  writeCameraClipPayloadToFile,
  writeCameraPayloadToFile,
} from "../../cli/nodes-camera.js";
import {
  parseScreenRecordPayload,
  screenRecordTempPath,
  writeScreenRecordToFile,
} from "../../cli/nodes-screen.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { imageMimeFromFormat } from "../../media/mime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import { sanitizeToolResultImages } from "../tool-images.js";
import type { GatewayCallOptions } from "./gateway.js";
import { callGatewayTool } from "./gateway.js";
import { resolveNode, resolveNodeId } from "./nodes-utils.js";

export const MEDIA_INVOKE_ACTIONS = {
  "camera.clip": "camera_clip",
  "camera.snap": "camera_snap",
  "photos.latest": "photos_latest",
  "screen.record": "screen_record",
} as const;

export type NodeMediaAction = "camera_snap" | "photos_latest" | "camera_clip" | "screen_record";

interface ExecuteNodeMediaActionParams {
  action: NodeMediaAction;
  params: Record<string, unknown>;
  gatewayOpts: GatewayCallOptions;
  modelHasVision?: boolean;
  imageSanitization: ImageSanitizationLimits;
}

export async function executeNodeMediaAction(
  input: ExecuteNodeMediaActionParams,
): Promise<AgentToolResult<unknown>> {
  switch (input.action) {
    case "camera_snap": {
      return await executeCameraSnap(input);
    }
    case "photos_latest": {
      return await executePhotosLatest(input);
    }
    case "camera_clip": {
      return await executeCameraClip(input);
    }
    case "screen_record": {
      return await executeScreenRecord(input);
    }
  }
}

async function executeCameraSnap({
  params,
  gatewayOpts,
  modelHasVision,
  imageSanitization,
}: ExecuteNodeMediaActionParams): Promise<AgentToolResult<unknown>> {
  const node = requireString(params, "node");
  const resolvedNode = await resolveNode(gatewayOpts, node);
  const { nodeId } = resolvedNode;
  const facingRaw = normalizeLowercaseStringOrEmpty(params.facing) || "front";
  const facings: CameraFacing[] =
    facingRaw === "both"
      ? ["front", "back"]
      : facingRaw === "front" || facingRaw === "back"
        ? [facingRaw]
        : (() => {
            throw new Error("invalid facing (front|back|both)");
          })();
  const maxWidth =
    typeof params.maxWidth === "number" && Number.isFinite(params.maxWidth)
      ? params.maxWidth
      : 1600;
  const quality =
    typeof params.quality === "number" && Number.isFinite(params.quality) ? params.quality : 0.95;
  const delayMs =
    typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
      ? params.delayMs
      : undefined;
  const deviceId =
    typeof params.deviceId === "string" && params.deviceId.trim()
      ? params.deviceId.trim()
      : undefined;
  if (deviceId && facings.length > 1) {
    throw new Error("facing=both is not allowed when deviceId is set");
  }

  const content: AgentToolResult<unknown>["content"] = [];
  const details: Record<string, unknown>[] = [];

  for (const facing of facings) {
    const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
      command: "camera.snap",
      idempotencyKey: crypto.randomUUID(),
      nodeId,
      params: {
        delayMs,
        deviceId,
        facing,
        format: "jpg",
        maxWidth,
        quality,
      },
    });
    const payload = parseCameraSnapPayload(raw?.payload);
    const normalizedFormat = normalizeLowercaseStringOrEmpty(payload.format);
    if (normalizedFormat !== "jpg" && normalizedFormat !== "jpeg" && normalizedFormat !== "png") {
      throw new Error(`unsupported camera.snap format: ${payload.format}`);
    }

    const isJpeg = normalizedFormat === "jpg" || normalizedFormat === "jpeg";
    const filePath = cameraTempPath({
      ext: isJpeg ? "jpg" : "png",
      facing,
      kind: "snap",
    });
    await writeCameraPayloadToFile({
      expectedHost: resolvedNode.remoteIp,
      filePath,
      invalidPayloadMessage: "invalid camera.snap payload",
      payload,
    });
    if (modelHasVision && payload.base64) {
      content.push({
        data: payload.base64,
        mimeType: imageMimeFromFormat(payload.format) ?? (isJpeg ? "image/jpeg" : "image/png"),
        type: "image",
      });
    }
    details.push({
      facing,
      height: payload.height,
      path: filePath,
      width: payload.width,
    });
  }

  return await sanitizeToolResultImages(
    {
      content,
      details: {
        media: {
          mediaUrls: details
            .map((entry) => entry.path)
            .filter((path): path is string => typeof path === "string"),
        },
        snaps: details,
      },
    },
    "nodes:camera_snap",
    imageSanitization,
  );
}

async function executePhotosLatest({
  params,
  gatewayOpts,
  modelHasVision,
  imageSanitization,
}: ExecuteNodeMediaActionParams): Promise<AgentToolResult<unknown>> {
  const node = requireString(params, "node");
  const resolvedNode = await resolveNode(gatewayOpts, node);
  const { nodeId } = resolvedNode;
  const limitRaw =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.floor(params.limit)
      : DEFAULT_PHOTOS_LIMIT;
  const limit = Math.max(1, Math.min(limitRaw, MAX_PHOTOS_LIMIT));
  const maxWidth =
    typeof params.maxWidth === "number" && Number.isFinite(params.maxWidth)
      ? params.maxWidth
      : DEFAULT_PHOTOS_MAX_WIDTH;
  const quality =
    typeof params.quality === "number" && Number.isFinite(params.quality)
      ? params.quality
      : DEFAULT_PHOTOS_QUALITY;
  const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
    command: "photos.latest",
    idempotencyKey: crypto.randomUUID(),
    nodeId,
    params: {
      limit,
      maxWidth,
      quality,
    },
  });
  const payload =
    raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : {};
  const photos = Array.isArray(payload.photos) ? payload.photos : [];

  if (photos.length === 0) {
    return await sanitizeToolResultImages(
      {
        content: [],
        details: [],
      },
      "nodes:photos_latest",
      imageSanitization,
    );
  }

  const content: AgentToolResult<unknown>["content"] = [];
  const details: Record<string, unknown>[] = [];

  for (const [index, photoRaw] of photos.entries()) {
    const photo = parseCameraSnapPayload(photoRaw);
    const normalizedFormat = normalizeLowercaseStringOrEmpty(photo.format);
    if (normalizedFormat !== "jpg" && normalizedFormat !== "jpeg" && normalizedFormat !== "png") {
      throw new Error(`unsupported photos.latest format: ${photo.format}`);
    }
    const isJpeg = normalizedFormat === "jpg" || normalizedFormat === "jpeg";
    const filePath = cameraTempPath({
      ext: isJpeg ? "jpg" : "png",
      id: crypto.randomUUID(),
      kind: "snap",
    });
    await writeCameraPayloadToFile({
      expectedHost: resolvedNode.remoteIp,
      filePath,
      invalidPayloadMessage: "invalid photos.latest payload",
      payload: photo,
    });

    if (modelHasVision && photo.base64) {
      content.push({
        data: photo.base64,
        mimeType: imageMimeFromFormat(photo.format) ?? (isJpeg ? "image/jpeg" : "image/png"),
        type: "image",
      });
    }

    const createdAt =
      photoRaw && typeof photoRaw === "object" && !Array.isArray(photoRaw)
        ? (photoRaw as Record<string, unknown>).createdAt
        : undefined;
    details.push({
      height: photo.height,
      index,
      path: filePath,
      width: photo.width,
      ...(typeof createdAt === "string" ? { createdAt } : {}),
    });
  }

  return await sanitizeToolResultImages(
    {
      content,
      details: {
        media: {
          mediaUrls: details
            .map((entry) => entry.path)
            .filter((path): path is string => typeof path === "string"),
        },
        photos: details,
      },
    },
    "nodes:photos_latest",
    imageSanitization,
  );
}

async function executeCameraClip({
  params,
  gatewayOpts,
}: ExecuteNodeMediaActionParams): Promise<AgentToolResult<unknown>> {
  const node = requireString(params, "node");
  const resolvedNode = await resolveNode(gatewayOpts, node);
  const { nodeId } = resolvedNode;
  const facing = normalizeLowercaseStringOrEmpty(params.facing) || "front";
  if (facing !== "front" && facing !== "back") {
    throw new Error("invalid facing (front|back)");
  }
  const durationMs =
    typeof params.durationMs === "number" && Number.isFinite(params.durationMs)
      ? params.durationMs
      : typeof params.duration === "string"
        ? parseDurationMs(params.duration)
        : 3000;
  const includeAudio = typeof params.includeAudio === "boolean" ? params.includeAudio : true;
  const deviceId =
    typeof params.deviceId === "string" && params.deviceId.trim()
      ? params.deviceId.trim()
      : undefined;
  const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
    command: "camera.clip",
    idempotencyKey: crypto.randomUUID(),
    nodeId,
    params: {
      deviceId,
      durationMs,
      facing,
      format: "mp4",
      includeAudio,
    },
  });
  const payload = parseCameraClipPayload(raw?.payload);
  const filePath = await writeCameraClipPayloadToFile({
    expectedHost: resolvedNode.remoteIp,
    facing,
    payload,
  });
  return {
    content: [{ text: `FILE:${filePath}`, type: "text" }],
    details: {
      durationMs: payload.durationMs,
      facing,
      hasAudio: payload.hasAudio,
      path: filePath,
    },
  };
}

async function executeScreenRecord({
  params,
  gatewayOpts,
}: ExecuteNodeMediaActionParams): Promise<AgentToolResult<unknown>> {
  const node = requireString(params, "node");
  const nodeId = await resolveNodeId(gatewayOpts, node);
  const durationMs = Math.min(
    typeof params.durationMs === "number" && Number.isFinite(params.durationMs)
      ? params.durationMs
      : typeof params.duration === "string"
        ? parseDurationMs(params.duration)
        : 10_000,
    300_000,
  );
  const fps = typeof params.fps === "number" && Number.isFinite(params.fps) ? params.fps : 10;
  const screenIndex =
    typeof params.screenIndex === "number" && Number.isFinite(params.screenIndex)
      ? params.screenIndex
      : 0;
  const includeAudio = typeof params.includeAudio === "boolean" ? params.includeAudio : true;
  const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
    command: "screen.record",
    idempotencyKey: crypto.randomUUID(),
    nodeId,
    params: {
      durationMs,
      format: "mp4",
      fps,
      includeAudio,
      screenIndex,
    },
  });
  const payload = parseScreenRecordPayload(raw?.payload);
  const filePath =
    typeof params.outPath === "string" && params.outPath.trim()
      ? params.outPath.trim()
      : screenRecordTempPath({ ext: payload.format || "mp4" });
  const written = await writeScreenRecordToFile(filePath, payload.base64);
  return {
    content: [{ text: `FILE:${written.path}`, type: "text" }],
    details: {
      durationMs: payload.durationMs,
      fps: payload.fps,
      hasAudio: payload.hasAudio,
      path: written.path,
      screenIndex: payload.screenIndex,
    },
  };
}

function requireString(params: Record<string, unknown>, key: string): string {
  const raw = params[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${key} required`);
  }
  return raw.trim();
}

const DEFAULT_PHOTOS_LIMIT = 1;
const MAX_PHOTOS_LIMIT = 20;
const DEFAULT_PHOTOS_MAX_WIDTH = 1600;
const DEFAULT_PHOTOS_QUALITY = 0.85;
