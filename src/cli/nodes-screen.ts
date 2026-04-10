import * as path from "node:path";
import { writeBase64ToFile } from "./nodes-camera.js";
import { asRecord, asString, resolveTempPathParts } from "./nodes-media-utils.js";

export interface ScreenRecordPayload {
  format: string;
  base64: string;
  durationMs?: number;
  fps?: number;
  screenIndex?: number;
  hasAudio?: boolean;
}

export function parseScreenRecordPayload(value: unknown): ScreenRecordPayload {
  const obj = asRecord(value);
  const format = asString(obj.format);
  const base64 = asString(obj.base64);
  if (!format || !base64) {
    throw new Error("invalid screen.record payload");
  }
  return {
    base64,
    durationMs: typeof obj.durationMs === "number" ? obj.durationMs : undefined,
    format,
    fps: typeof obj.fps === "number" ? obj.fps : undefined,
    hasAudio: typeof obj.hasAudio === "boolean" ? obj.hasAudio : undefined,
    screenIndex: typeof obj.screenIndex === "number" ? obj.screenIndex : undefined,
  };
}

export function screenRecordTempPath(opts: { ext: string; tmpDir?: string; id?: string }) {
  const { tmpDir, id, ext } = resolveTempPathParts(opts);
  return path.join(tmpDir, `openclaw-screen-record-${id}${ext}`);
}

export async function writeScreenRecordToFile(filePath: string, base64: string) {
  return writeBase64ToFile(filePath, base64);
}
