import path from "node:path";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { resolveSandboxInputPath } from "./sandbox-paths.js";

interface RelativePathOptions {
  allowRoot?: boolean;
  cwd?: string;
  boundaryLabel?: string;
  includeRootInError?: boolean;
}

function throwPathEscapesBoundary(params: {
  options?: RelativePathOptions;
  rootResolved: string;
  candidate: string;
}): never {
  const boundary = params.options?.boundaryLabel ?? "workspace root";
  const suffix = params.options?.includeRootInError ? ` (${params.rootResolved})` : "";
  throw new Error(`Path escapes ${boundary}${suffix}: ${params.candidate}`);
}

function validateRelativePathWithinBoundary(params: {
  relativePath: string;
  isAbsolutePath: (path: string) => boolean;
  options?: RelativePathOptions;
  rootResolved: string;
  candidate: string;
}): string {
  if (params.relativePath === "" || params.relativePath === ".") {
    if (params.options?.allowRoot) {
      return "";
    }
    throwPathEscapesBoundary({
      candidate: params.candidate,
      options: params.options,
      rootResolved: params.rootResolved,
    });
  }
  if (params.relativePath.startsWith("..") || params.isAbsolutePath(params.relativePath)) {
    throwPathEscapesBoundary({
      candidate: params.candidate,
      options: params.options,
      rootResolved: params.rootResolved,
    });
  }
  return params.relativePath;
}

function toRelativePathUnderRoot(params: {
  root: string;
  candidate: string;
  options?: RelativePathOptions;
}): string {
  const resolvedInput = resolveSandboxInputPath(
    params.candidate,
    params.options?.cwd ?? params.root,
  );

  if (process.platform === "win32") {
    const rootResolved = path.win32.resolve(params.root);
    const resolvedCandidate = path.win32.resolve(resolvedInput);
    const rootForCompare = normalizeWindowsPathForComparison(rootResolved);
    const targetForCompare = normalizeWindowsPathForComparison(resolvedCandidate);
    const relative = path.win32.relative(rootForCompare, targetForCompare);
    return validateRelativePathWithinBoundary({
      candidate: params.candidate,
      isAbsolutePath: path.win32.isAbsolute,
      options: params.options,
      relativePath: relative,
      rootResolved,
    });
  }

  const rootResolved = path.resolve(params.root);
  const resolvedCandidate = path.resolve(resolvedInput);
  const relative = path.relative(rootResolved, resolvedCandidate);
  return validateRelativePathWithinBoundary({
    candidate: params.candidate,
    isAbsolutePath: path.isAbsolute,
    options: params.options,
    relativePath: relative,
    rootResolved,
  });
}

function toRelativeBoundaryPath(params: {
  root: string;
  candidate: string;
  options?: Pick<RelativePathOptions, "allowRoot" | "cwd">;
  boundaryLabel: string;
  includeRootInError?: boolean;
}): string {
  return toRelativePathUnderRoot({
    candidate: params.candidate,
    options: {
      allowRoot: params.options?.allowRoot,
      boundaryLabel: params.boundaryLabel,
      cwd: params.options?.cwd,
      includeRootInError: params.includeRootInError,
    },
    root: params.root,
  });
}

export function toRelativeWorkspacePath(
  root: string,
  candidate: string,
  options?: Pick<RelativePathOptions, "allowRoot" | "cwd">,
): string {
  return toRelativeBoundaryPath({
    boundaryLabel: "workspace root",
    candidate,
    options,
    root,
  });
}

export function toRelativeSandboxPath(
  root: string,
  candidate: string,
  options?: Pick<RelativePathOptions, "allowRoot" | "cwd">,
): string {
  return toRelativeBoundaryPath({
    boundaryLabel: "sandbox root",
    candidate,
    includeRootInError: true,
    options,
    root,
  });
}

export function resolvePathFromInput(filePath: string, cwd: string): string {
  return path.normalize(resolveSandboxInputPath(filePath, cwd));
}
