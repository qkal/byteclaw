import fs from "node:fs";
import path from "node:path";
import {
  type ResolvedBoundaryPath,
  resolveBoundaryPath,
  resolveBoundaryPathSync,
} from "./boundary-path.js";
import type { PathAliasPolicy } from "./path-alias-guards.js";
import {
  type SafeOpenSyncAllowedType,
  type SafeOpenSyncFailureReason,
  openVerifiedFileSync,
} from "./safe-open-sync.js";

type BoundaryReadFs = Pick<
  typeof fs,
  | "closeSync"
  | "constants"
  | "fstatSync"
  | "lstatSync"
  | "openSync"
  | "readFileSync"
  | "realpathSync"
>;

export type BoundaryFileOpenFailureReason = SafeOpenSyncFailureReason | "validation";

export type BoundaryFileOpenResult =
  | { ok: true; path: string; fd: number; stat: fs.Stats; rootRealPath: string }
  | { ok: false; reason: BoundaryFileOpenFailureReason; error?: unknown };

export type BoundaryFileOpenFailure = Extract<BoundaryFileOpenResult, { ok: false }>;

export interface OpenBoundaryFileSyncParams {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  rootRealPath?: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  allowedType?: SafeOpenSyncAllowedType;
  skipLexicalRootCheck?: boolean;
  ioFs?: BoundaryReadFs;
}

export type OpenBoundaryFileParams = OpenBoundaryFileSyncParams & {
  aliasPolicy?: PathAliasPolicy;
};

interface ResolvedBoundaryFilePath {
  absolutePath: string;
  resolvedPath: string;
  rootRealPath: string;
}

export function canUseBoundaryFileOpen(ioFs: typeof fs): boolean {
  return (
    typeof ioFs.openSync === "function" &&
    typeof ioFs.closeSync === "function" &&
    typeof ioFs.fstatSync === "function" &&
    typeof ioFs.lstatSync === "function" &&
    typeof ioFs.realpathSync === "function" &&
    typeof ioFs.readFileSync === "function" &&
    typeof ioFs.constants === "object" &&
    ioFs.constants !== null
  );
}

export function openBoundaryFileSync(params: OpenBoundaryFileSyncParams): BoundaryFileOpenResult {
  const ioFs = params.ioFs ?? fs;
  const resolved = resolveBoundaryFilePathGeneric({
    absolutePath: params.absolutePath,
    resolve: (absolutePath) =>
      resolveBoundaryPathSync({
        absolutePath,
        boundaryLabel: params.boundaryLabel,
        rootCanonicalPath: params.rootRealPath,
        rootPath: params.rootPath,
        skipLexicalRootCheck: params.skipLexicalRootCheck,
      }),
  });
  if (resolved instanceof Promise) {
    return toBoundaryValidationError(new Error("Unexpected async boundary resolution"));
  }
  return finalizeBoundaryFileOpen({
    allowedType: params.allowedType,
    ioFs,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    resolved,
  });
}

export function matchBoundaryFileOpenFailure<T>(
  failure: BoundaryFileOpenFailure,
  handlers: {
    path?: (failure: BoundaryFileOpenFailure) => T;
    validation?: (failure: BoundaryFileOpenFailure) => T;
    io?: (failure: BoundaryFileOpenFailure) => T;
    fallback: (failure: BoundaryFileOpenFailure) => T;
  },
): T {
  switch (failure.reason) {
    case "path": {
      return handlers.path ? handlers.path(failure) : handlers.fallback(failure);
    }
    case "validation": {
      return handlers.validation ? handlers.validation(failure) : handlers.fallback(failure);
    }
    case "io": {
      return handlers.io ? handlers.io(failure) : handlers.fallback(failure);
    }
  }
}

function openBoundaryFileResolved(params: {
  absolutePath: string;
  resolvedPath: string;
  rootRealPath: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  allowedType?: SafeOpenSyncAllowedType;
  ioFs: BoundaryReadFs;
}): BoundaryFileOpenResult {
  const opened = openVerifiedFileSync({
    allowedType: params.allowedType,
    filePath: params.absolutePath,
    ioFs: params.ioFs,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks ?? true,
    resolvedPath: params.resolvedPath,
  });
  if (!opened.ok) {
    return opened;
  }
  return {
    fd: opened.fd,
    ok: true,
    path: opened.path,
    rootRealPath: params.rootRealPath,
    stat: opened.stat,
  };
}

function finalizeBoundaryFileOpen(params: {
  resolved: ResolvedBoundaryFilePath | BoundaryFileOpenResult;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  allowedType?: SafeOpenSyncAllowedType;
  ioFs: BoundaryReadFs;
}): BoundaryFileOpenResult {
  if ("ok" in params.resolved) {
    return params.resolved;
  }
  return openBoundaryFileResolved({
    absolutePath: params.resolved.absolutePath,
    allowedType: params.allowedType,
    ioFs: params.ioFs,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    resolvedPath: params.resolved.resolvedPath,
    rootRealPath: params.resolved.rootRealPath,
  });
}

export async function openBoundaryFile(
  params: OpenBoundaryFileParams,
): Promise<BoundaryFileOpenResult> {
  const ioFs = params.ioFs ?? fs;
  const maybeResolved = resolveBoundaryFilePathGeneric({
    absolutePath: params.absolutePath,
    resolve: (absolutePath) =>
      resolveBoundaryPath({
        absolutePath,
        boundaryLabel: params.boundaryLabel,
        policy: params.aliasPolicy,
        rootCanonicalPath: params.rootRealPath,
        rootPath: params.rootPath,
        skipLexicalRootCheck: params.skipLexicalRootCheck,
      }),
  });
  const resolved = maybeResolved instanceof Promise ? await maybeResolved : maybeResolved;
  return finalizeBoundaryFileOpen({
    allowedType: params.allowedType,
    ioFs,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    resolved,
  });
}

function toBoundaryValidationError(error: unknown): BoundaryFileOpenResult {
  return { error, ok: false, reason: "validation" };
}

function mapResolvedBoundaryPath(
  absolutePath: string,
  resolved: ResolvedBoundaryPath,
): ResolvedBoundaryFilePath {
  return {
    absolutePath,
    resolvedPath: resolved.canonicalPath,
    rootRealPath: resolved.rootCanonicalPath,
  };
}

function resolveBoundaryFilePathGeneric(params: {
  absolutePath: string;
  resolve: (absolutePath: string) => ResolvedBoundaryPath | Promise<ResolvedBoundaryPath>;
}):
  | ResolvedBoundaryFilePath
  | BoundaryFileOpenResult
  | Promise<ResolvedBoundaryFilePath | BoundaryFileOpenResult> {
  const absolutePath = path.resolve(params.absolutePath);
  try {
    const resolved = params.resolve(absolutePath);
    if (resolved instanceof Promise) {
      return resolved
        .then((value) => mapResolvedBoundaryPath(absolutePath, value))
        .catch((error) => toBoundaryValidationError(error));
    }
    return mapResolvedBoundaryPath(absolutePath, resolved);
  } catch (error) {
    return toBoundaryValidationError(error);
  }
}
