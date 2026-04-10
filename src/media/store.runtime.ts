import {
  SafeOpenError,
  type SafeOpenErrorCode,
  readLocalFileSafely as readLocalFileSafelyImpl,
} from "../infra/fs-safe.js";

export interface SafeOpenLikeError {
  code: SafeOpenErrorCode;
  message: string;
}

export const readLocalFileSafely = readLocalFileSafelyImpl;

export function isSafeOpenError(error: unknown): error is SafeOpenLikeError {
  return error instanceof SafeOpenError;
}
