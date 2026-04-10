/**
 * Resource limits for spawned processes to prevent resource exhaustion.
 * Enforces CPU, memory, and other resource constraints.
 */

export interface ResourceLimits {
  maxMemoryMB?: number;
  maxCpuTimeMs?: number;
  maxWallTimeMs?: number;
  maxProcesses?: number;
  maxFiles?: number;
}

export interface ResourceLimitResult {
  exceeded: boolean;
  limit: string;
  actual: number;
  limitValue: number;
}

/**
 * Apply resource limits to a child process spawn options.
 */
export function applyResourceLimits(
  options: Record<string, unknown>,
  limits: ResourceLimits,
): Record<string, unknown> {
  const result = { ...options };

  if (limits.maxMemoryMB) {
    result.resourceLimits = {
      ...(result.resourceLimits as Record<string, unknown> | undefined),
      maxRSS: limits.maxMemoryMB * 1024 * 1024, // Convert MB to bytes
    };
  }

  if (limits.maxCpuTimeMs) {
    result.resourceLimits = {
      ...(result.resourceLimits as Record<string, unknown> | undefined),
      maxCPU: limits.maxCpuTimeMs / 1000, // Convert ms to seconds
    };
  }

  return result;
}

/**
 * Check if a process exceeds resource limits.
 */
export function checkResourceLimits(
  pid: number,
  limits: ResourceLimits,
): ResourceLimitResult | null {
  // This is a placeholder implementation
  // In a real implementation, you would query the OS for actual resource usage
  // using platform-specific APIs (e.g., /proc on Linux, tasklist on Windows)
  return null;
}

/**
 * Default resource limits for different process types.
 */
export const DEFAULT_RESOURCE_LIMITS: Record<string, ResourceLimits> = {
  shortLived: {
    maxMemoryMB: 512,
    maxCpuTimeMs: 30000,
    maxWallTimeMs: 60000,
  },
  mediumLived: {
    maxMemoryMB: 1024,
    maxCpuTimeMs: 300000,
    maxWallTimeMs: 600000,
  },
  longLived: {
    maxMemoryMB: 2048,
    maxCpuTimeMs: Number.POSITIVE_INFINITY,
    maxWallTimeMs: Number.POSITIVE_INFINITY,
  },
};

/**
 * Get resource limits for a process type.
 */
export function getResourceLimits(type: keyof typeof DEFAULT_RESOURCE_LIMITS): ResourceLimits {
  return DEFAULT_RESOURCE_LIMITS[type] ?? DEFAULT_RESOURCE_LIMITS.mediumLived;
}
