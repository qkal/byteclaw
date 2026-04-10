import process from "node:process";

/**
 * Node.js Permission Model configuration
 * Provides runtime permission restrictions for enhanced security
 */

export interface PermissionConfig {
  allowFsRead?: string[];
  allowFsWrite?: string[];
  allowChildProcess?: boolean;
  allowWorkerThreads?: boolean;
  allowNet?: string[];
}

/**
 * Check if Node.js was started with --permission flag
 */
export function hasPermissionModelEnabled(): boolean {
  return process.execArgv.includes("--permission");
}

/**
 * Get permission configuration from environment variables
 */
export function getPermissionConfig(): PermissionConfig {
  const config: PermissionConfig = {};
  
  // File system read permissions
  if (process.env.OPENCLAW_ALLOW_FS_READ) {
    config.allowFsRead = process.env.OPENCLAW_ALLOW_FS_READ.split(",").map((p) => p.trim());
  }
  
  // File system write permissions
  if (process.env.OPENCLAW_ALLOW_FS_WRITE) {
    config.allowFsWrite = process.env.OPENCLAW_ALLOW_FS_WRITE.split(",").map((p) => p.trim());
  }
  
  // Child process permission
  config.allowChildProcess = process.env.OPENCLAW_ALLOW_CHILD_PROCESS === "1";
  
  // Worker threads permission
  config.allowWorkerThreads = process.env.OPENCLAW_ALLOW_WORKER_THREADS === "1";
  
  // Network permissions
  if (process.env.OPENCLAW_ALLOW_NET) {
    config.allowNet = process.env.OPENCLAW_ALLOW_NET.split(",").map((p) => p.trim());
  }
  
  return config;
}

/**
 * Validate that required permissions are granted
 * Throws if critical permissions are missing
 */
export function validatePermissions(required: PermissionConfig): void {
  if (!hasPermissionModelEnabled()) {
    // If permission model is not enabled, permissions are not enforced
    return;
  }
  
  const config = getPermissionConfig();
  const errors: string[] = [];
  
  // Check file system read permissions
  if (required.allowFsRead) {
    const missing = required.allowFsRead.filter(
      (path) => !config.allowFsRead?.includes(path) && !config.allowFsRead?.includes("*")
    );
    if (missing.length > 0) {
      errors.push(`Missing file system read permissions for: ${missing.join(", ")}`);
    }
  }
  
  // Check file system write permissions
  if (required.allowFsWrite) {
    const missing = required.allowFsWrite.filter(
      (path) => !config.allowFsWrite?.includes(path) && !config.allowFsWrite?.includes("*")
    );
    if (missing.length > 0) {
      errors.push(`Missing file system write permissions for: ${missing.join(", ")}`);
    }
  }
  
  // Check child process permission
  if (required.allowChildProcess && !config.allowChildProcess) {
    errors.push("Child process permission is required but not granted");
  }
  
  // Check worker threads permission
  if (required.allowWorkerThreads && !config.allowWorkerThreads) {
    errors.push("Worker threads permission is required but not granted");
  }
  
  if (errors.length > 0) {
    throw new Error(`Permission validation failed:\n${errors.join("\n")}`);
  }
}

/**
 * Print permission model status
 */
export function printPermissionStatus(): void {
  if (hasPermissionModelEnabled()) {
    const config = getPermissionConfig();
    console.log("[openclaw] Node.js Permission Model is enabled");
    console.log(`  File system read: ${config.allowFsRead?.join(", ") || "none"}`);
    console.log(`  File system write: ${config.allowFsWrite?.join(", ") || "none"}`);
    console.log(`  Child process: ${config.allowChildProcess ? "allowed" : "denied"}`);
    console.log(`  Worker threads: ${config.allowWorkerThreads ? "allowed" : "denied"}`);
    console.log(`  Network: ${config.allowNet?.join(", ") || "none"}`);
  } else {
    console.log("[openclaw] Node.js Permission Model is not enabled");
    console.log("  To enable, run Node.js with --permission flag");
  }
}
