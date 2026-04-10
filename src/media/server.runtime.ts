import { SafeOpenError, readFileWithinRoot as readFileWithinRootImpl } from "../infra/fs-safe.js";
import {
  MEDIA_MAX_BYTES,
  cleanOldMedia as cleanOldMediaImpl,
  getMediaDir as getMediaDirImpl,
} from "./store.js";

export interface SafeOpenLikeError {
  code:
    | "invalid-path"
    | "not-found"
    | "outside-workspace"
    | "symlink"
    | "not-file"
    | "path-mismatch"
    | "too-large";
  message: string;
}

export const readFileWithinRoot = readFileWithinRootImpl;
export const cleanOldMedia = cleanOldMediaImpl;
export const getMediaDir = getMediaDirImpl;
export { MEDIA_MAX_BYTES };

export function isSafeOpenError(error: unknown): error is SafeOpenLikeError {
  return error instanceof SafeOpenError;
}
