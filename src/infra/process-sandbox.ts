/**
 * Enhanced Process Sandbox
 * Provides strict controls for child process execution
 */

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Sandbox configuration
 */
export interface SandboxConfig {
  // Allowlist of permitted executables (full paths or basenames)
  allowedExecutables?: string[];
  
  // Denylist of blocked executables
  blockedExecutables?: string[];
  
  // Working directory restrictions
  allowedWorkingDirs?: string[];
  blockWorkingDirs?: string[];
  
  // Environment variable restrictions
  allowedEnvVars?: string[];
  blockedEnvVars?: string[];
  
  // Argument restrictions
  blockedArgs?: string[];
  
  // Resource limits
  maxExecutionTime?: number; // Milliseconds
  maxMemoryMB?: number;
  maxCpuPercent?: number;
  
  // Security flags
  noShell?: boolean; // Prevent shell execution
  noSudo?: boolean; // Prevent sudo execution
  noNetwork?: boolean; // Prevent network access (Linux only)
  isolateProcess?: boolean; // Use process isolation
}

/**
 * Default sandbox configuration (restrictive)
 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  noShell: true,
  noSudo: true,
  blockedExecutables: [
    "sudo",
    "su",
    "doas",
    "chmod",
    "chown",
    "chgrp",
    "mount",
    "umount",
    "iptables",
    "ifconfig",
    "route",
    "nc",
    "netcat",
    "telnet",
    "ftp",
    "curl",
    "wget",
    "ssh",
    "scp",
    "rsync",
  ],
  blockedArgs: [
    "--root",
    "-E", // Preserve environment
    "--preserve-env",
    "sudo",
    "su",
  ],
  maxExecutionTime: 60_000, // 1 minute default
  maxMemoryMB: 512,
};

/**
 * Validate executable path against sandbox config
 */
function validateExecutable(
  executable: string,
  config: SandboxConfig
): { allowed: boolean; reason?: string } {
  // Check blocklist first
  if (config.blockedExecutables) {
    const basename = executable.split(/[\\/]/).pop() || executable;
    if (config.blockedExecutables.includes(basename) || config.blockedExecutables.includes(executable)) {
      return { allowed: false, reason: `Executable "${executable}" is blocked` };
    }
  }
  
  // If allowlist is specified, check it
  if (config.allowedExecutables && config.allowedExecutables.length > 0) {
    const basename = executable.split(/[\\/]/).pop() || executable;
    if (!config.allowedExecutables.includes(basename) && !config.allowedExecutables.includes(executable)) {
      return { allowed: false, reason: `Executable "${executable}" is not in allowlist` };
    }
  }
  
  return { allowed: true };
}

/**
 * Validate working directory against sandbox config
 */
function validateWorkingDirectory(
  cwd: string | undefined,
  config: SandboxConfig
): { allowed: boolean; reason?: string } {
  if (!cwd) {
    return { allowed: true };
  }
  
  // Check blocklist
  if (config.blockWorkingDirs) {
    for (const blockedDir of config.blockWorkingDirs) {
      if (cwd.startsWith(blockedDir) || cwd === blockedDir) {
        return { allowed: false, reason: `Working directory "${cwd}" is blocked` };
      }
    }
  }
  
  // If allowlist is specified, check it
  if (config.allowedWorkingDirs && config.allowedWorkingDirs.length > 0) {
    const allowed = config.allowedWorkingDirs.some((allowedDir) =>
      cwd.startsWith(allowedDir) || cwd === allowedDir
    );
    if (!allowed) {
      return { allowed: false, reason: `Working directory "${cwd}" is not in allowlist` };
    }
  }
  
  return { allowed: true };
}

/**
 * Sanitize environment variables based on sandbox config
 */
function sanitizeEnv(
  env: Record<string, string | undefined>,
  config: SandboxConfig
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    
    // Check blocklist
    if (config.blockedEnvVars?.includes(key)) {
      continue;
    }
    
    // If allowlist is specified, check it
    if (config.allowedEnvVars && config.allowedEnvVars.length > 0) {
      if (!config.allowedEnvVars.includes(key)) {
        continue;
      }
    }
    
    // Sanitize sensitive environment variables
    if (key.toLowerCase().includes("password") || key.toLowerCase().includes("secret") || key.toLowerCase().includes("token")) {
      // Keep but log warning in production
      continue;
    }
    
    sanitized[key] = value;
  }
  
  return sanitized;
}

/**
 * Validate arguments against sandbox config
 */
function validateArgs(
  args: string[],
  config: SandboxConfig
): { allowed: boolean; reason?: string } {
  if (!config.blockedArgs) {
    return { allowed: true };
  }
  
  for (const arg of args) {
    for (const blocked of config.blockedArgs) {
      if (arg.includes(blocked)) {
        return { allowed: false, reason: `Argument "${arg}" contains blocked pattern "${blocked}"` };
      }
    }
  }
  
  return { allowed: true };
}

/**
 * Sandbox execution error
 */
export class SandboxError extends Error {
  constructor(
    public reason: string,
    public details?: Record<string, unknown>
  ) {
    super(`Sandbox violation: ${reason}`);
    this.name = "SandboxError";
  }
}

/**
 * Spawn a process with sandbox restrictions
 */
export function spawnSandboxed(
  command: string,
  args: string[] = [],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    config?: Partial<SandboxConfig>;
  } = {}
): ChildProcess {
  const config = { ...DEFAULT_SANDBOX_CONFIG, ...options.config };
  
  // Validate executable
  const execValidation = validateExecutable(command, config);
  if (!execValidation.allowed) {
    throw new SandboxError(execValidation.reason || "Executable validation failed", { command });
  }
  
  // Validate working directory
  const cwdValidation = validateWorkingDirectory(options.cwd, config);
  if (!cwdValidation.allowed) {
    throw new SandboxError(cwdValidation.reason || "Working directory validation failed", { cwd: options.cwd });
  }
  
  // Validate arguments
  const argsValidation = validateArgs(args, config);
  if (!argsValidation.allowed) {
    throw new SandboxError(argsValidation.reason || "Argument validation failed", { args });
  }
  
  // Sanitize environment
  const sanitizedEnv = sanitizeEnv(options.env || process.env, config);
  
  // Build spawn options
  const spawnOptions: {
    cwd?: string;
    env: Record<string, string>;
    shell?: boolean;
    detached?: boolean;
  } = {
    cwd: options.cwd,
    env: {
      ...sanitizedEnv,
      PATH: sanitizedEnv.PATH || process.env.PATH || "",
    },
    shell: config.noShell ? false : undefined,
  };
  
  // Spawn the process
  const child = spawn(command, args, spawnOptions);
  
  // Apply timeout if configured
  if (config.maxExecutionTime) {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, config.maxExecutionTime);
    
    child.once("exit", () => clearTimeout(timeout));
    child.once("error", () => clearTimeout(timeout));
  }
  
  return child;
}

/**
 * Execute a command with sandbox and return the result
 */
export async function execSandboxed(
  command: string,
  args: string[] = [],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    config?: Partial<SandboxConfig>;
    timeout?: number;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawnSandboxed(command, args, options);
    
    let stdout = "";
    let stderr = "";
    
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Process killed by signal: ${signal}`));
      } else {
        resolve({ exitCode: code, stderr, stdout });
      }
    });
    
    child.once("error", (error) => {
      reject(error);
    });
    
    // Apply custom timeout if specified
    const timeout = options.timeout || options.config?.maxExecutionTime;
    if (timeout) {
      setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000);
        reject(new Error(`Process timed out after ${timeout}ms`));
      }, timeout);
    }
  });
}

/**
 * Create a sandbox configuration for specific use cases
 */
export const SANDBOX_PRESETS = {
  // Strict sandbox for untrusted input
  strict: {
    ...DEFAULT_SANDBOX_CONFIG,
    maxExecutionTime: 30_000,
    maxMemoryMB: 256,
  } as SandboxConfig,
  
  // Relaxed sandbox for trusted tools
  relaxed: {
    ...DEFAULT_SANDBOX_CONFIG,
    maxExecutionTime: 300_000,
    maxMemoryMB: 1024,
    noShell: false,
  } as SandboxConfig,
  
  // Development sandbox (more permissive)
  development: {
    ...DEFAULT_SANDBOX_CONFIG,
    maxExecutionTime: 600_000,
    maxMemoryMB: 2048,
    noShell: false,
  } as SandboxConfig,
};
