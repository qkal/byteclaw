import { clearActiveProgressLine } from "./terminal/progress-line.js";
import { restoreTerminalState } from "./terminal/restore.js";

export interface RuntimeEnv {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
}

export type OutputRuntimeEnv = RuntimeEnv & {
  writeStdout: (value: string) => void;
  writeJson: (value: unknown, space?: number) => void;
};

function shouldEmitRuntimeLog(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST !== "true") {
    return true;
  }
  if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") {
    return true;
  }
  const maybeMockedLog = console.log as unknown as { mock?: unknown };
  return typeof maybeMockedLog.mock === "object";
}

function shouldEmitRuntimeStdout(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST !== "true") {
    return true;
  }
  if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") {
    return true;
  }
  const stdout = process.stdout as NodeJS.WriteStream & {
    write: {
      mock?: unknown;
    };
  };
  return typeof stdout.write.mock === "object";
}

function isPipeClosedError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "EPIPE" || code === "EIO";
}

function hasRuntimeOutputWriter(
  runtime: RuntimeEnv | OutputRuntimeEnv,
): runtime is OutputRuntimeEnv {
  return typeof (runtime as Partial<OutputRuntimeEnv>).writeStdout === "function";
}

function writeStdout(value: string): void {
  if (!shouldEmitRuntimeStdout()) {
    return;
  }
  clearActiveProgressLine();
  const line = value.endsWith("\n") ? value : `${value}\n`;
  try {
    process.stdout.write(line);
  } catch (error) {
    if (isPipeClosedError(error)) {
      return;
    }
    throw error;
  }
}

function createRuntimeIo(): Pick<OutputRuntimeEnv, "log" | "error" | "writeStdout" | "writeJson"> {
  return {
    error: (...args: Parameters<typeof console.error>) => {
      clearActiveProgressLine();
      console.error(...args);
    },
    log: (...args: Parameters<typeof console.log>) => {
      if (!shouldEmitRuntimeLog()) {
        return;
      }
      clearActiveProgressLine();
      console.log(...args);
    },
    writeJson: (value: unknown, space = 2) => {
      writeStdout(JSON.stringify(value, null, space > 0 ? space : undefined));
    },
    writeStdout,
  };
}

export const defaultRuntime: OutputRuntimeEnv = {
  ...createRuntimeIo(),
  exit: (code) => {
    restoreTerminalState("runtime exit", { resumeStdinIfPaused: false });
    process.exit(code);
    throw new Error("unreachable"); // Satisfies tests when mocked
  },
};

export function createNonExitingRuntime(): OutputRuntimeEnv {
  return {
    ...createRuntimeIo(),
    exit: (code: number) => {
      throw new Error(`exit ${code}`);
    },
  };
}

export function writeRuntimeJson(
  runtime: RuntimeEnv | OutputRuntimeEnv,
  value: unknown,
  space = 2,
): void {
  if (hasRuntimeOutputWriter(runtime)) {
    runtime.writeJson(value, space);
    return;
  }
  runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
}
