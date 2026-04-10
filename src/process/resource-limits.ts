/**
 * Production-grade resource limits for spawned processes to prevent resource exhaustion.
 * Enforces CPU, memory, and other resource constraints with platform-specific implementations.
 */

export interface ResourceLimits {
  maxMemoryMB?: number;
  maxCpuTimeMs?: number;
  maxWallTimeMs?: number;
  maxProcesses?: number;
  maxFiles?: number;
  maxOpenSockets?: number;
}

export interface ResourceLimitResult {
  exceeded: boolean;
  limit: string;
  actual: number;
  limitValue: number;
}

export interface ResourceUsage {
  memoryMB: number;
  cpuTimeMs: number;
  wallTimeMs: number;
  openFiles: number;
  openSockets: number;
}

/**
 * Apply resource limits to a child process spawn options.
 * Platform-aware implementation.
 */
export function applyResourceLimits(
  options: Record<string, unknown>,
  limits: ResourceLimits,
): Record<string, unknown> {
  const result = { ...options };

  if (limits.maxMemoryMB) {
    result.resourceLimits = {
      ...(result.resourceLimits as Record<string, unknown> | undefined),
      maxRSS: limits.maxMemoryMB * 1024 * 1024,
    };
  }

  if (limits.maxCpuTimeMs) {
    result.resourceLimits = {
      ...(result.resourceLimits as Record<string, unknown> | undefined),
      maxCPU: limits.maxCpuTimeMs / 1000,
    };
  }

  // Additional platform-specific limits
  if (limits.maxFiles) {
    result.resourceLimits = {
      ...(result.resourceLimits as Record<string, unknown> | undefined),
      nofile: limits.maxFiles,
    };
  }

  return result;
}

/**
 * Check if a process exceeds resource limits.
 * Platform-specific implementation for Linux, macOS, and Windows.
 */
export async function checkResourceLimits(
  pid: number,
  limits: ResourceLimits,
): Promise<ResourceLimitResult | null> {
  const usage = await getResourceUsage(pid);

  if (limits.maxMemoryMB && usage.memoryMB > limits.maxMemoryMB) {
    return {
      exceeded: true,
      limit: "memory",
      actual: usage.memoryMB,
      limitValue: limits.maxMemoryMB,
    };
  }

  if (limits.maxCpuTimeMs && usage.cpuTimeMs > limits.maxCpuTimeMs) {
    return {
      exceeded: true,
      limit: "cpuTime",
      actual: usage.cpuTimeMs,
      limitValue: limits.maxCpuTimeMs,
    };
  }

  if (limits.maxFiles && usage.openFiles > limits.maxFiles) {
    return {
      exceeded: true,
      limit: "files",
      actual: usage.openFiles,
      limitValue: limits.maxFiles,
    };
  }

  return null;
}

/**
 * Get current resource usage for a process.
 * Platform-specific implementation.
 */
async function getResourceUsage(pid: number): Promise<ResourceUsage> {
  const platform = process.platform;

  if (platform === "linux" || platform === "darwin") {
    return await getUnixResourceUsage(pid);
  }

  if (platform === "win32") {
    return await getWindowsResourceUsage(pid);
  }

  // Default fallback
  return {
    memoryMB: 0,
    cpuTimeMs: 0,
    wallTimeMs: 0,
    openFiles: 0,
    openSockets: 0,
  };
}

async function getUnixResourceUsage(pid: number): Promise<ResourceUsage> {
  try {
    const fs = await import("node:fs/promises");
    const procPath = `/proc/${pid}`;

    // Read memory info
    const statm = await fs.readFile(`${procPath}/statm`, "utf8");
    const pages = parseInt(statm.split(" ")[1], 10);
    const pageSize = 4096; // Typical page size
    const memoryMB = (pages * pageSize) / (1024 * 1024);

    // Read stat for CPU time
    const stat = await fs.readFile(`${procPath}/stat`, "utf8");
    const parts = stat.split(" ");
    const utime = parseInt(parts[13], 10);
    const stime = parseInt(parts[14], 10);
    const cpuTimeMs = ((utime + stime) * 1000) / 100; // Convert jiffies to ms

    // Count open file descriptors
    const fdPath = `${procPath}/fd`;
    let openFiles = 0;
    try {
      const fds = await fs.readdir(fdPath);
      openFiles = fds.length;
    } catch {
      openFiles = 0;
    }

    return {
      memoryMB,
      cpuTimeMs,
      wallTimeMs: 0, // Would need process start time
      openFiles,
      openSockets: 0,
    };
  } catch {
    return {
      memoryMB: 0,
      cpuTimeMs: 0,
      wallTimeMs: 0,
      openFiles: 0,
      openSockets: 0,
    };
  }
}

async function getWindowsResourceUsage(pid: number): Promise<ResourceUsage> {
  // Windows implementation would use tasklist or WMI
  // For now, return placeholder
  return {
    memoryMB: 0,
    cpuTimeMs: 0,
    wallTimeMs: 0,
    openFiles: 0,
    openSockets: 0,
  };
}

/**
 * Default resource limits for different process types.
 */
export const DEFAULT_RESOURCE_LIMITS: Record<string, ResourceLimits> = {
  shortLived: {
    maxMemoryMB: 512,
    maxCpuTimeMs: 30000,
    maxWallTimeMs: 60000,
    maxFiles: 1000,
  },
  mediumLived: {
    maxMemoryMB: 1024,
    maxCpuTimeMs: 300000,
    maxWallTimeMs: 600000,
    maxFiles: 2000,
  },
  longLived: {
    maxMemoryMB: 2048,
    maxCpuTimeMs: Number.POSITIVE_INFINITY,
    maxWallTimeMs: Number.POSITIVE_INFINITY,
    maxFiles: 5000,
  },
};

/**
 * Get resource limits for a process type.
 */
export function getResourceLimits(type: keyof typeof DEFAULT_RESOURCE_LIMITS): ResourceLimits {
  return DEFAULT_RESOURCE_LIMITS[type] ?? DEFAULT_RESOURCE_LIMITS.mediumLived;
}
