import path from "node:path";
import { assertSandboxPath } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

export interface SandboxedBridgeMediaPathConfig {
  root: string;
  bridge: SandboxFsBridge;
  workspaceOnly?: boolean;
}

export function createSandboxBridgeReadFile(params: {
  sandbox: Pick<SandboxedBridgeMediaPathConfig, "root" | "bridge">;
}): (filePath: string) => Promise<Buffer> {
  return async (filePath: string) =>
    await params.sandbox.bridge.readFile({
      cwd: params.sandbox.root,
      filePath,
    });
}

export async function resolveSandboxedBridgeMediaPath(params: {
  sandbox: SandboxedBridgeMediaPathConfig;
  mediaPath: string;
  inboundFallbackDir?: string;
}): Promise<{ resolved: string; rewrittenFrom?: string }> {
  const normalizeFileUrl = (rawPath: string) =>
    rawPath.startsWith("file://") ? rawPath.slice("file://".length) : rawPath;
  const filePath = normalizeFileUrl(params.mediaPath);
  const enforceWorkspaceBoundary = async (hostPath: string) => {
    if (!params.sandbox.workspaceOnly) {
      return;
    }
    await assertSandboxPath({
      cwd: params.sandbox.root,
      filePath: hostPath,
      root: params.sandbox.root,
    });
  };

  const resolveDirect = () =>
    params.sandbox.bridge.resolvePath({
      cwd: params.sandbox.root,
      filePath,
    });
  try {
    const resolved = resolveDirect();
    if (resolved.hostPath) {
      await enforceWorkspaceBoundary(resolved.hostPath);
    }
    return { resolved: resolved.hostPath ?? resolved.containerPath };
  } catch (error) {
    const fallbackDir = params.inboundFallbackDir?.trim();
    if (!fallbackDir) {
      throw error;
    }
    const fallbackPath = path.join(fallbackDir, path.basename(filePath));
    try {
      const stat = await params.sandbox.bridge.stat({
        cwd: params.sandbox.root,
        filePath: fallbackPath,
      });
      if (!stat) {
        throw error;
      }
    } catch {
      throw error;
    }
    const resolvedFallback = params.sandbox.bridge.resolvePath({
      cwd: params.sandbox.root,
      filePath: fallbackPath,
    });
    if (resolvedFallback.hostPath) {
      await enforceWorkspaceBoundary(resolvedFallback.hostPath);
    }
    return {
      resolved: resolvedFallback.hostPath ?? resolvedFallback.containerPath,
      rewrittenFrom: filePath,
    };
  }
}
