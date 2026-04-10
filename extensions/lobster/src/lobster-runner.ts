import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  lowercasePreservingWhitespace,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/text-runtime";

export type LobsterEnvelope =
  | {
      ok: true;
      status: "ok" | "needs_approval" | "cancelled";
      output: unknown[];
      requiresApproval: null | {
        type: "approval_request";
        prompt: string;
        items: unknown[];
        resumeToken?: string;
      };
    }
  | {
      ok: false;
      error: { type?: string; message: string };
    };

export interface LobsterRunnerParams {
  action: "run" | "resume";
  pipeline?: string;
  argsJson?: string;
  token?: string;
  approve?: boolean;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
}

export interface LobsterRunner {
  run: (params: LobsterRunnerParams) => Promise<LobsterEnvelope>;
}

interface EmbeddedToolContext {
  cwd?: string;
  env?: Record<string, string | undefined>;
  mode?: "tool" | "human" | "sdk";
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  signal?: AbortSignal;
  registry?: unknown;
  llmAdapters?: Record<string, unknown>;
}

interface EmbeddedToolEnvelope {
  protocolVersion?: number;
  ok: boolean;
  status?: "ok" | "needs_approval" | "cancelled";
  output?: unknown[];
  requiresApproval?: {
    type?: "approval_request";
    prompt: string;
    items: unknown[];
    preview?: string;
    resumeToken?: string;
  } | null;
  error?: {
    type?: string;
    message: string;
  };
}

interface EmbeddedToolRuntime {
  runToolRequest: (params: {
    pipeline?: string;
    filePath?: string;
    args?: Record<string, unknown>;
    ctx?: EmbeddedToolContext;
  }) => Promise<EmbeddedToolEnvelope>;
  resumeToolRequest: (params: {
    token: string;
    approved: boolean;
    ctx?: EmbeddedToolContext;
  }) => Promise<EmbeddedToolEnvelope>;
}

interface ToolRuntimeDeps {
  createDefaultRegistry: () => unknown;
  parsePipeline: (pipeline: string) => {
    name: string;
    args: Record<string, unknown>;
    raw: string;
  }[];
  decodeResumeToken: (token: string) => {
    kind?: string;
    stateKey?: string;
    filePath?: string;
  };
  encodeToken: (payload: Record<string, unknown>) => string;
  runPipeline: (params: {
    pipeline: { name: string; args: Record<string, unknown>; raw: string }[];
    registry: unknown;
    input: AsyncIterable<unknown> | unknown[];
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
    env: Record<string, string | undefined>;
    mode: "tool";
    cwd: string;
    llmAdapters?: Record<string, unknown>;
    signal?: AbortSignal;
  }) => Promise<{
    items: unknown[];
    halted?: boolean;
    haltedAt?: { index?: number };
  }>;
  runWorkflowFile: (params: {
    filePath: string;
    args?: Record<string, unknown>;
    ctx: EmbeddedToolContext;
    resume?: Record<string, unknown>;
    approved?: boolean;
  }) => Promise<{
    status: "ok" | "needs_approval" | "cancelled";
    output: unknown[];
    requiresApproval?: EmbeddedToolEnvelope["requiresApproval"];
  }>;
  readStateJson: (params: {
    env: Record<string, string | undefined>;
    key: string;
  }) => Promise<unknown>;
  writeStateJson: (params: {
    env: Record<string, string | undefined>;
    key: string;
    value: unknown;
  }) => Promise<void>;
  deleteStateJson: (params: {
    env: Record<string, string | undefined>;
    key: string;
  }) => Promise<void>;
}

interface PipelineResumeState {
  pipeline: { name: string; args: Record<string, unknown>; raw: string }[];
  resumeAtIndex: number;
  items: unknown[];
  prompt?: string;
  createdAt: string;
}

type LoadEmbeddedToolRuntime = () => Promise<EmbeddedToolRuntime>;

interface ApprovalRequestItem {
  type: "approval_request";
  prompt: string;
  items: unknown[];
  resumeToken?: string;
}

interface PipelineRuntimeContext {
  registry: unknown;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: Record<string, string | undefined>;
  cwd: string;
  llmAdapters?: Record<string, unknown>;
  signal?: AbortSignal;
}

function normalizeForCwdSandbox(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === "win32" ? lowercasePreservingWhitespace(normalized) : normalized;
}

export function resolveLobsterCwd(cwdRaw: unknown): string {
  if (typeof cwdRaw !== "string" || !cwdRaw.trim()) {
    return process.cwd();
  }
  const cwd = cwdRaw.trim();
  if (path.isAbsolute(cwd)) {
    throw new Error("cwd must be a relative path");
  }
  const base = process.cwd();
  const resolved = path.resolve(base, cwd);

  const rel = path.relative(normalizeForCwdSandbox(base), normalizeForCwdSandbox(resolved));
  if (rel === "" || rel === ".") {
    return resolved;
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("cwd must stay within the gateway working directory");
  }
  return resolved;
}

function createLimitedSink(maxBytes: number, label: "stdout" | "stderr") {
  let bytes = 0;
  return new Writable({
    write(chunk, _encoding, callback) {
      bytes += Buffer.byteLength(String(chunk), "utf8");
      if (bytes > maxBytes) {
        callback(new Error(`lobster ${label} exceeded maxStdoutBytes`));
        return;
      }
      callback();
    },
  });
}

function normalizeEnvelope(envelope: EmbeddedToolEnvelope): LobsterEnvelope {
  if (envelope.ok) {
    return {
      ok: true,
      output: Array.isArray(envelope.output) ? envelope.output : [],
      requiresApproval: envelope.requiresApproval
        ? {
            items: envelope.requiresApproval.items,
            prompt: envelope.requiresApproval.prompt,
            type: "approval_request",
            ...(envelope.requiresApproval.resumeToken
              ? { resumeToken: envelope.requiresApproval.resumeToken }
              : {}),
          }
        : null,
      status: envelope.status ?? "ok",
    };
  }
  return {
    error: {
      message: envelope.error?.message ?? "lobster runtime failed",
      type: envelope.error?.type,
    },
    ok: false,
  };
}

function throwOnErrorEnvelope(envelope: LobsterEnvelope): Extract<LobsterEnvelope, { ok: true }> {
  if (envelope.ok) {
    return envelope;
  }
  throw new Error(envelope.error.message);
}

function asApprovalRequestItem(item: unknown): ApprovalRequestItem | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const candidate = item as Partial<ApprovalRequestItem>;
  if (candidate.type !== "approval_request") {
    return null;
  }
  if (typeof candidate.prompt !== "string" || !Array.isArray(candidate.items)) {
    return null;
  }
  return candidate as ApprovalRequestItem;
}

function normalizeWorkflowOutput(
  okEnvelope: (
    status: "ok" | "needs_approval" | "cancelled",
    output: unknown[],
    requiresApproval: EmbeddedToolEnvelope["requiresApproval"],
  ) => EmbeddedToolEnvelope,
  output: {
    status: "ok" | "needs_approval" | "cancelled";
    output: unknown[];
    requiresApproval?: EmbeddedToolEnvelope["requiresApproval"];
  },
): EmbeddedToolEnvelope {
  if (output.status === "needs_approval") {
    return okEnvelope("needs_approval", [], output.requiresApproval ?? null);
  }
  if (output.status === "cancelled") {
    return okEnvelope("cancelled", [], null);
  }
  return okEnvelope("ok", output.output, null);
}

async function runPipelineWithRuntime(
  deps: ToolRuntimeDeps,
  params: {
    pipeline: { name: string; args: Record<string, unknown>; raw: string }[];
    input: AsyncIterable<unknown> | unknown[];
    runtime: PipelineRuntimeContext;
  },
) {
  return await deps.runPipeline({
    cwd: params.runtime.cwd,
    env: params.runtime.env,
    input: params.input,
    llmAdapters: params.runtime.llmAdapters,
    mode: "tool",
    pipeline: params.pipeline,
    registry: params.runtime.registry,
    signal: params.runtime.signal,
    stderr: params.runtime.stderr,
    stdin: params.runtime.stdin,
    stdout: params.runtime.stdout,
  });
}

async function resolveWorkflowFile(candidate: string, cwd: string) {
  const { stat } = await import("node:fs/promises");
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) {
    throw new Error("Workflow path is not a file");
  }
  const ext = normalizeLowercaseStringOrEmpty(path.extname(resolved));
  if (![".lobster", ".yaml", ".yml", ".json"].includes(ext)) {
    throw new Error("Workflow file must end in .lobster, .yaml, .yml, or .json");
  }
  return resolved;
}

async function detectWorkflowFile(candidate: string, cwd: string) {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("|")) {
    return null;
  }
  try {
    return await resolveWorkflowFile(trimmed, cwd);
  } catch {
    return null;
  }
}

function parseWorkflowArgs(argsJson: string) {
  return JSON.parse(argsJson) as Record<string, unknown>;
}

function createEmbeddedToolContext(
  params: LobsterRunnerParams,
  signal?: AbortSignal,
): EmbeddedToolContext {
  const env = { ...process.env } as Record<string, string | undefined>;
  return {
    cwd: params.cwd,
    env,
    mode: "tool",
    signal,
    stderr: createLimitedSink(Math.max(1024, params.maxStdoutBytes), "stderr"),
    stdin: Readable.from([]),
    stdout: createLimitedSink(Math.max(1024, params.maxStdoutBytes), "stdout"),
  };
}

async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = Math.max(200, timeoutMs);
  const controller = new AbortController();
  return await new Promise<T>((resolve, reject) => {
    const onTimeout = () => {
      const error = new Error("lobster runtime timed out");
      controller.abort(error);
      reject(error);
    };

    const timer = setTimeout(onTimeout, timeout);
    void fn(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createFallbackEmbeddedToolRuntime(deps: ToolRuntimeDeps): EmbeddedToolRuntime {
  const createToolContext = (ctx: EmbeddedToolContext = {}) => ({
    cwd: ctx.cwd ?? process.cwd(),
    env: { ...process.env, ...ctx.env },
    llmAdapters: ctx.llmAdapters,
    mode: "tool" as const,
    registry: ctx.registry ?? deps.createDefaultRegistry(),
    signal: ctx.signal,
    stderr: ctx.stderr ?? createLimitedSink(512_000, "stderr"),
    stdin: ctx.stdin ?? Readable.from([]),
    stdout: ctx.stdout ?? createLimitedSink(512_000, "stdout"),
  });

  const okEnvelope = (
    status: "ok" | "needs_approval" | "cancelled",
    output: unknown[],
    requiresApproval: EmbeddedToolEnvelope["requiresApproval"],
  ): EmbeddedToolEnvelope => ({
    ok: true,
    output,
    protocolVersion: 1,
    requiresApproval,
    status,
  });

  const errorEnvelope = (type: string, message: string): EmbeddedToolEnvelope => ({
    error: { message, type },
    ok: false,
    protocolVersion: 1,
  });

  const streamFromItems = (items: unknown[]) =>
    (async function* streamFromItems() {
      for (const item of items) {
        yield item;
      }
    })();

  const savePipelineResumeState = async (
    env: Record<string, string | undefined>,
    state: PipelineResumeState,
  ) => {
    const stateKey = `pipeline_resume_${randomUUID()}`;
    await deps.writeStateJson({ env, key: stateKey, value: state });
    return stateKey;
  };

  const loadPipelineResumeState = async (
    env: Record<string, string | undefined>,
    stateKey: string,
  ) => {
    const stored = await deps.readStateJson({ env, key: stateKey });
    if (!stored || typeof stored !== "object") {
      throw new Error("Pipeline resume state not found");
    }
    const data = stored as Partial<PipelineResumeState>;
    if (!Array.isArray(data.pipeline)) {
      throw new Error("Invalid pipeline resume state");
    }
    if (typeof data.resumeAtIndex !== "number") {
      throw new Error("Invalid pipeline resume state");
    }
    if (!Array.isArray(data.items)) {
      throw new Error("Invalid pipeline resume state");
    }
    return data as PipelineResumeState;
  };

  return {
    async resumeToolRequest({ token, approved, ctx = {} }) {
      const runtime = createToolContext(ctx);
      let payload: { kind?: string; stateKey?: string; filePath?: string };

      try {
        payload = deps.decodeResumeToken(token);
      } catch (error) {
        return errorEnvelope("parse_error", formatErrorMessage(error));
      }

      if (!approved) {
        if (payload.kind === "workflow-file" && payload.stateKey) {
          await deps.deleteStateJson({ env: runtime.env, key: payload.stateKey });
        }
        if (payload.kind === "pipeline-resume" && payload.stateKey) {
          await deps.deleteStateJson({ env: runtime.env, key: payload.stateKey });
        }
        return okEnvelope("cancelled", [], null);
      }

      if (payload.kind === "workflow-file" && payload.filePath) {
        try {
          const output = await deps.runWorkflowFile({
            approved: true,
            ctx: runtime,
            filePath: payload.filePath,
            resume: payload as Record<string, unknown>,
          });
          return normalizeWorkflowOutput(okEnvelope, output);
        } catch (error) {
          return errorEnvelope("runtime_error", formatErrorMessage(error));
        }
      }

      try {
        const resumeState = await loadPipelineResumeState(runtime.env, payload.stateKey ?? "");
        const remaining = resumeState.pipeline.slice(resumeState.resumeAtIndex);

        const output = await runPipelineWithRuntime(deps, {
          input: streamFromItems(resumeState.items),
          pipeline: remaining,
          runtime,
        });

        const approval =
          output.halted && output.items.length === 1
            ? asApprovalRequestItem(output.items[0])
            : null;

        if (approval) {
          const nextStateKey = await savePipelineResumeState(runtime.env, {
            createdAt: new Date().toISOString(),
            items: approval.items,
            pipeline: remaining,
            prompt: approval.prompt,
            resumeAtIndex: (output.haltedAt?.index ?? -1) + 1,
          });
          if (payload.stateKey) {
            await deps.deleteStateJson({ env: runtime.env, key: payload.stateKey });
          }

          const resumeToken = deps.encodeToken({
            kind: "pipeline-resume",
            protocolVersion: 1,
            stateKey: nextStateKey,
            v: 1,
          });

          return okEnvelope("needs_approval", [], {
            items: approval.items,
            prompt: approval.prompt,
            resumeToken,
            type: "approval_request",
          });
        }

        if (payload.stateKey) {
          await deps.deleteStateJson({ env: runtime.env, key: payload.stateKey });
        }
        return okEnvelope("ok", output.items, null);
      } catch (error) {
        return errorEnvelope("runtime_error", formatErrorMessage(error));
      }
    },

    async runToolRequest({ pipeline, filePath, args, ctx = {} }) {
      const runtime = createToolContext(ctx);
      const hasPipeline = typeof pipeline === "string" && pipeline.trim().length > 0;
      const hasFile = typeof filePath === "string" && filePath.trim().length > 0;

      if (!hasPipeline && !hasFile) {
        return errorEnvelope("parse_error", "run requires either pipeline or filePath");
      }
      if (hasPipeline && hasFile) {
        return errorEnvelope("parse_error", "run accepts either pipeline or filePath, not both");
      }

      if (hasFile) {
        try {
          const output = await deps.runWorkflowFile({
            filePath,
            args,
            ctx: runtime,
          });
          return normalizeWorkflowOutput(okEnvelope, output);
        } catch (error) {
          return errorEnvelope("runtime_error", formatErrorMessage(error));
        }
      }

      let parsed;
      try {
        parsed = deps.parsePipeline(String(pipeline));
      } catch (error) {
        return errorEnvelope("parse_error", formatErrorMessage(error));
      }

      try {
        const output = await runPipelineWithRuntime(deps, {
          input: [],
          pipeline: parsed,
          runtime,
        });

        const approval =
          output.halted && output.items.length === 1
            ? asApprovalRequestItem(output.items[0])
            : null;

        if (approval) {
          const stateKey = await savePipelineResumeState(runtime.env, {
            createdAt: new Date().toISOString(),
            items: approval.items,
            pipeline: parsed,
            prompt: approval.prompt,
            resumeAtIndex: (output.haltedAt?.index ?? -1) + 1,
          });

          const resumeToken = deps.encodeToken({
            kind: "pipeline-resume",
            protocolVersion: 1,
            stateKey,
            v: 1,
          });

          return okEnvelope("needs_approval", [], {
            items: approval.items,
            prompt: approval.prompt,
            resumeToken,
            type: "approval_request",
          });
        }

        return okEnvelope("ok", output.items, null);
      } catch (error) {
        return errorEnvelope("runtime_error", formatErrorMessage(error));
      }
    },
  };
}

async function importInstalledLobsterModule<T>(
  lobsterRoot: string,
  relativePath: string,
): Promise<T> {
  const target = path.join(lobsterRoot, relativePath);
  return (await import(pathToFileURL(target).href)) as T;
}

function resolveInstalledLobsterRoot() {
  const require = createRequire(import.meta.url);
  const sdkEntry = require.resolve("@clawdbot/lobster");
  let currentDir = path.dirname(sdkEntry);

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error("Unable to resolve the installed @clawdbot/lobster package root");
    }
    currentDir = parentDir;
  }
}

async function loadEmbeddedToolRuntimeFromPackage(): Promise<EmbeddedToolRuntime> {
  const lobsterRoot = resolveInstalledLobsterRoot();
  const coreIndexPath = path.join(lobsterRoot, "dist/src/core/index.js");

  try {
    const core = await import(pathToFileURL(coreIndexPath).href);
    if (typeof core.runToolRequest === "function" && typeof core.resumeToolRequest === "function") {
      return {
        resumeToolRequest: core.resumeToolRequest as EmbeddedToolRuntime["resumeToolRequest"],
        runToolRequest: core.runToolRequest as EmbeddedToolRuntime["runToolRequest"],
      };
    }
  } catch {
    // The current published npm package does not export/ship ./core yet.
  }

  const [
    registryModule,
    parserModule,
    resumeModule,
    tokenModule,
    runtimeModule,
    workflowModule,
    storeModule,
  ] = await Promise.all([
    importInstalledLobsterModule<{
      createDefaultRegistry: ToolRuntimeDeps["createDefaultRegistry"];
    }>(lobsterRoot, "dist/src/commands/registry.js"),
    importInstalledLobsterModule<{ parsePipeline: ToolRuntimeDeps["parsePipeline"] }>(
      lobsterRoot,
      "dist/src/parser.js",
    ),
    importInstalledLobsterModule<{ decodeResumeToken: ToolRuntimeDeps["decodeResumeToken"] }>(
      lobsterRoot,
      "dist/src/resume.js",
    ),
    importInstalledLobsterModule<{ encodeToken: ToolRuntimeDeps["encodeToken"] }>(
      lobsterRoot,
      "dist/src/token.js",
    ),
    importInstalledLobsterModule<{ runPipeline: ToolRuntimeDeps["runPipeline"] }>(
      lobsterRoot,
      "dist/src/runtime.js",
    ),
    importInstalledLobsterModule<{ runWorkflowFile: ToolRuntimeDeps["runWorkflowFile"] }>(
      lobsterRoot,
      "dist/src/workflows/file.js",
    ),
    importInstalledLobsterModule<{
      readStateJson: ToolRuntimeDeps["readStateJson"];
      writeStateJson: ToolRuntimeDeps["writeStateJson"];
      deleteStateJson: ToolRuntimeDeps["deleteStateJson"];
    }>(lobsterRoot, "dist/src/state/store.js"),
  ]);

  return createFallbackEmbeddedToolRuntime({
    createDefaultRegistry: registryModule.createDefaultRegistry,
    decodeResumeToken: resumeModule.decodeResumeToken,
    deleteStateJson: storeModule.deleteStateJson,
    encodeToken: tokenModule.encodeToken,
    parsePipeline: parserModule.parsePipeline,
    readStateJson: storeModule.readStateJson,
    runPipeline: runtimeModule.runPipeline,
    runWorkflowFile: workflowModule.runWorkflowFile,
    writeStateJson: storeModule.writeStateJson,
  });
}

export function createEmbeddedLobsterRunner(options?: {
  loadRuntime?: LoadEmbeddedToolRuntime;
}): LobsterRunner {
  const loadRuntime = options?.loadRuntime ?? loadEmbeddedToolRuntimeFromPackage;
  let runtimePromise: Promise<EmbeddedToolRuntime> | undefined;

  const getRuntime = () => {
    runtimePromise ??= loadRuntime().catch((error) => {
      runtimePromise = undefined;
      throw error;
    });
    return runtimePromise;
  };

  return {
    async run(params) {
      const runtime = await getRuntime();
      return await withTimeout(params.timeoutMs, async (signal) => {
        const ctx = createEmbeddedToolContext(params, signal);

        if (params.action === "run") {
          const pipeline = params.pipeline?.trim() ?? "";
          if (!pipeline) {
            throw new Error("pipeline required");
          }

          const filePath = await detectWorkflowFile(pipeline, params.cwd);
          if (filePath) {
            const parsedArgsJson = params.argsJson?.trim() ?? "";
            let args: Record<string, unknown> | undefined;
            if (parsedArgsJson) {
              try {
                args = parseWorkflowArgs(parsedArgsJson);
              } catch {
                throw new Error("run --args-json must be valid JSON");
              }
            }
            return throwOnErrorEnvelope(
              normalizeEnvelope(await runtime.runToolRequest({ args, ctx, filePath })),
            );
          }

          return throwOnErrorEnvelope(
            normalizeEnvelope(await runtime.runToolRequest({ ctx, pipeline })),
          );
        }

        const token = params.token?.trim() ?? "";
        if (!token) {
          throw new Error("token required");
        }
        if (typeof params.approve !== "boolean") {
          throw new Error("approve required");
        }

        return throwOnErrorEnvelope(
          normalizeEnvelope(
            await runtime.resumeToolRequest({
              approved: params.approve,
              ctx,
              token,
            }),
          ),
        );
      });
    },
  };
}
