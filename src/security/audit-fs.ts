import fs from "node:fs/promises";
import {
  type ExecFn,
  formatIcaclsResetCommand,
  formatWindowsAclSummary,
  inspectWindowsAcl,
} from "./windows-acl.js";

export interface PermissionCheck {
  ok: boolean;
  isSymlink: boolean;
  isDir: boolean;
  mode: number | null;
  bits: number | null;
  source: "posix" | "windows-acl" | "unknown";
  worldWritable: boolean;
  groupWritable: boolean;
  worldReadable: boolean;
  groupReadable: boolean;
  aclSummary?: string;
  error?: string;
}

export interface PermissionCheckOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
}

export async function safeStat(targetPath: string): Promise<{
  ok: boolean;
  isSymlink: boolean;
  isDir: boolean;
  mode: number | null;
  uid: number | null;
  gid: number | null;
  error?: string;
}> {
  try {
    const lst = await fs.lstat(targetPath);
    return {
      gid: typeof lst.gid === "number" ? lst.gid : null,
      isDir: lst.isDirectory(),
      isSymlink: lst.isSymbolicLink(),
      mode: typeof lst.mode === "number" ? lst.mode : null,
      ok: true,
      uid: typeof lst.uid === "number" ? lst.uid : null,
    };
  } catch (error) {
    return {
      error: String(error),
      gid: null,
      isDir: false,
      isSymlink: false,
      mode: null,
      ok: false,
      uid: null,
    };
  }
}

export async function inspectPathPermissions(
  targetPath: string,
  opts?: PermissionCheckOptions,
): Promise<PermissionCheck> {
  const st = await safeStat(targetPath);
  if (!st.ok) {
    return {
      bits: null,
      error: st.error,
      groupReadable: false,
      groupWritable: false,
      isDir: false,
      isSymlink: false,
      mode: null,
      ok: false,
      source: "unknown",
      worldReadable: false,
      worldWritable: false,
    };
  }

  let effectiveMode = st.mode;
  let effectiveIsDir = st.isDir;
  if (st.isSymlink) {
    try {
      const target = await fs.stat(targetPath);
      effectiveMode = typeof target.mode === "number" ? target.mode : st.mode;
      effectiveIsDir = target.isDirectory();
    } catch {
      // Keep lstat-derived metadata when target lookup fails.
    }
  }

  const bits = modeBits(effectiveMode);
  const platform = opts?.platform ?? process.platform;

  if (platform === "win32") {
    const acl = await inspectWindowsAcl(targetPath, { env: opts?.env, exec: opts?.exec });
    if (!acl.ok) {
      return {
        bits,
        error: acl.error,
        groupReadable: false,
        groupWritable: false,
        isDir: effectiveIsDir,
        isSymlink: st.isSymlink,
        mode: effectiveMode,
        ok: true,
        source: "unknown",
        worldReadable: false,
        worldWritable: false,
      };
    }
    return {
      aclSummary: formatWindowsAclSummary(acl),
      bits,
      groupReadable: acl.untrustedGroup.some((entry) => entry.canRead),
      groupWritable: acl.untrustedGroup.some((entry) => entry.canWrite),
      isDir: effectiveIsDir,
      isSymlink: st.isSymlink,
      mode: effectiveMode,
      ok: true,
      source: "windows-acl",
      worldReadable: acl.untrustedWorld.some((entry) => entry.canRead),
      worldWritable: acl.untrustedWorld.some((entry) => entry.canWrite),
    };
  }

  return {
    bits,
    groupReadable: isGroupReadable(bits),
    groupWritable: isGroupWritable(bits),
    isDir: effectiveIsDir,
    isSymlink: st.isSymlink,
    mode: effectiveMode,
    ok: true,
    source: "posix",
    worldReadable: isWorldReadable(bits),
    worldWritable: isWorldWritable(bits),
  };
}

export function formatPermissionDetail(targetPath: string, perms: PermissionCheck): string {
  if (perms.source === "windows-acl") {
    const summary = perms.aclSummary ?? "unknown";
    return `${targetPath} acl=${summary}`;
  }
  return `${targetPath} mode=${formatOctal(perms.bits)}`;
}

export function formatPermissionRemediation(params: {
  targetPath: string;
  perms: PermissionCheck;
  isDir: boolean;
  posixMode: number;
  env?: NodeJS.ProcessEnv;
}): string {
  if (params.perms.source === "windows-acl") {
    return formatIcaclsResetCommand(params.targetPath, { env: params.env, isDir: params.isDir });
  }
  const mode = params.posixMode.toString(8).padStart(3, "0");
  return `chmod ${mode} ${params.targetPath}`;
}

export function modeBits(mode: number | null): number | null {
  if (mode == null) {
    return null;
  }
  return mode & 0o777;
}

export function formatOctal(bits: number | null): string {
  if (bits == null) {
    return "unknown";
  }
  return bits.toString(8).padStart(3, "0");
}

export function isWorldWritable(bits: number | null): boolean {
  if (bits == null) {
    return false;
  }
  return (bits & 0o002) !== 0;
}

export function isGroupWritable(bits: number | null): boolean {
  if (bits == null) {
    return false;
  }
  return (bits & 0o020) !== 0;
}

export function isWorldReadable(bits: number | null): boolean {
  if (bits == null) {
    return false;
  }
  return (bits & 0o004) !== 0;
}

export function isGroupReadable(bits: number | null): boolean {
  if (bits == null) {
    return false;
  }
  return (bits & 0o040) !== 0;
}
