import { shouldLogVerbose } from "../../globals.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { requestHeartbeatNow as requestHeartbeatNowImpl } from "../../infra/heartbeat-wake.js";
import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import { enqueueSystemEvent as enqueueSystemEventImpl } from "../../infra/system-events.js";
import { getProcessSupervisor as getProcessSupervisorImpl } from "../../process/supervisor/index.js";
import { scopedHeartbeatWakeOptions } from "../../routing/session-key.js";
import { prependBootstrapPromptWarning } from "../bootstrap-budget.js";
import {
  type CliOutput,
  createCliJsonlStreamingParser,
  extractCliErrorMessage,
  parseCliOutput,
} from "../cli-output.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { classifyFailoverReason } from "../pi-embedded-helpers.js";
import { applySkillEnvOverridesFromSnapshot } from "../skills.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";
import {
  buildCliArgs,
  buildCliSupervisorScopeKey,
  enqueueCliRun,
  prepareCliPromptImagePayload,
  resolveCliNoOutputTimeoutMs,
  resolveCliRunQueueKey,
  resolvePromptInput,
  resolveSessionIdToSend,
  resolveSystemPromptUsage,
  writeCliSystemPromptFile,
} from "./helpers.js";
import {
  CLI_BACKEND_LOG_OUTPUT_ENV,
  LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV,
  cliBackendLog,
} from "./log.js";
import type { PreparedCliRunContext } from "./types.js";

const executeDeps = {
  enqueueSystemEvent: enqueueSystemEventImpl,
  getProcessSupervisor: getProcessSupervisorImpl,
  requestHeartbeatNow: requestHeartbeatNowImpl,
};

export function setCliRunnerExecuteTestDeps(overrides: Partial<typeof executeDeps>): void {
  Object.assign(executeDeps, overrides);
}

function createCliAbortError(): Error {
  const error = new Error("CLI run aborted");
  error.name = "AbortError";
  return error;
}

function buildCliLogArgs(params: {
  args: string[];
  systemPromptArg?: string;
  sessionArg?: string;
  modelArg?: string;
  imageArg?: string;
  argsPrompt?: string;
}): string[] {
  const logArgs: string[] = [];
  for (let i = 0; i < params.args.length; i += 1) {
    const arg = params.args[i] ?? "";
    if (arg === params.systemPromptArg) {
      const systemPromptValue = params.args[i + 1] ?? "";
      logArgs.push(arg, `<systemPrompt:${systemPromptValue.length} chars>`);
      i += 1;
      continue;
    }
    if (arg === params.sessionArg) {
      logArgs.push(arg, params.args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === params.modelArg) {
      logArgs.push(arg, params.args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === params.imageArg) {
      logArgs.push(arg, "<image>");
      i += 1;
      continue;
    }
    logArgs.push(arg);
  }
  if (params.argsPrompt) {
    const promptIndex = logArgs.indexOf(params.argsPrompt);
    if (promptIndex !== -1) {
      logArgs[promptIndex] = `<prompt:${params.argsPrompt.length} chars>`;
    }
  }
  return logArgs;
}

const CLI_ENV_AUTH_LOG_KEYS = [
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "AZURE_OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "OPENAI_API_KEY",
  "OPENAI_STEIPETE_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

const CLI_BACKEND_PRESERVE_ENV = "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV";

function parseCliBackendPreserveEnv(raw: string | undefined): Set<string> {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return new Set();
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return new Set(
        Array.isArray(parsed)
          ? parsed.filter((entry): entry is string => typeof entry === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  }
  return new Set(
    trimmed
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function listPresentCliAuthEnvKeys(env: Record<string, string | undefined>): string[] {
  return CLI_ENV_AUTH_LOG_KEYS.filter((key) => {
    const value = env[key];
    return typeof value === "string" && value.length > 0;
  });
}

function formatCliEnvKeyList(keys: readonly string[]): string {
  return keys.length > 0 ? keys.join(",") : "none";
}

export function buildCliEnvAuthLog(childEnv: Record<string, string>): string {
  const hostKeys = listPresentCliAuthEnvKeys(process.env);
  const childKeys = listPresentCliAuthEnvKeys(childEnv);
  const childKeySet = new Set(childKeys);
  const clearedKeys = hostKeys.filter((key) => !childKeySet.has(key));
  return [
    `host=${formatCliEnvKeyList(hostKeys)}`,
    `child=${formatCliEnvKeyList(childKeys)}`,
    `cleared=${formatCliEnvKeyList(clearedKeys)}`,
  ].join(" ");
}

export async function executePreparedCliRun(
  context: PreparedCliRunContext,
  cliSessionIdToUse?: string,
): Promise<CliOutput> {
  const { params } = context;
  if (params.abortSignal?.aborted) {
    throw createCliAbortError();
  }
  const { backend } = context.preparedBackend;
  const { sessionId: resolvedSessionId, isNew } = resolveSessionIdToSend({
    backend,
    cliSessionId: cliSessionIdToUse,
  });
  const useResume = Boolean(
    cliSessionIdToUse && resolvedSessionId && backend.resumeArgs && backend.resumeArgs.length > 0,
  );
  const systemPromptArg = resolveSystemPromptUsage({
    backend,
    isNewSession: isNew,
    systemPrompt: context.systemPrompt,
  });
  const systemPromptFile =
    !useResume && systemPromptArg
      ? await writeCliSystemPromptFile({
          backend,
          systemPrompt: systemPromptArg,
        })
      : undefined;

  let prompt = prependBootstrapPromptWarning(params.prompt, context.bootstrapPromptWarningLines, {
    preserveExactPrompt: context.heartbeatPrompt,
  });
  const {
    prompt: promptWithImages,
    imagePaths,
    cleanupImages,
  } = await prepareCliPromptImagePayload({
    backend,
    images: params.images,
    prompt,
    workspaceDir: context.workspaceDir,
  });
  prompt = promptWithImages;

  const { argsPrompt, stdin } = resolvePromptInput({
    backend,
    prompt,
  });
  const stdinPayload = stdin ?? "";
  const baseArgs = useResume ? (backend.resumeArgs ?? backend.args ?? []) : (backend.args ?? []);
  const resolvedArgs = useResume
    ? baseArgs.map((entry) => entry.replaceAll("{sessionId}", resolvedSessionId ?? ""))
    : baseArgs;
  const claudeSkillsPlugin = await prepareClaudeCliSkillsPlugin({
    backendId: context.backendResolved.id,
    skillsSnapshot: params.skillsSnapshot,
  });
  const args = buildCliArgs({
    backend,
    baseArgs:
      claudeSkillsPlugin.args.length > 0
        ? [...resolvedArgs, ...claudeSkillsPlugin.args]
        : resolvedArgs,
    imagePaths,
    modelId: context.normalizedModel,
    promptArg: argsPrompt,
    sessionId: resolvedSessionId,
    systemPrompt: systemPromptArg,
    systemPromptFilePath: systemPromptFile?.filePath,
    useResume,
  });

  const queueKey = resolveCliRunQueueKey({
    backendId: context.backendResolved.id,
    cliSessionId: useResume ? resolvedSessionId : undefined,
    runId: params.runId,
    serialize: backend.serialize,
    workspaceDir: context.workspaceDir,
  });

  try {
    return await enqueueCliRun(queueKey, async () => {
      const restoreSkillEnv = params.skillsSnapshot
        ? applySkillEnvOverridesFromSnapshot({
            config: params.config,
            snapshot: params.skillsSnapshot,
          })
        : undefined;
      try {
        cliBackendLog.info(
          `cli exec: provider=${params.provider} model=${context.normalizedModel} promptChars=${params.prompt.length}`,
        );
        const logOutputText =
          isTruthyEnvValue(process.env[CLI_BACKEND_LOG_OUTPUT_ENV]) ||
          isTruthyEnvValue(process.env[LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV]);
        const env = (() => {
          const next = sanitizeHostExecEnv({
            baseEnv: process.env,
            blockPathOverrides: true,
          });
          const preservedEnv = parseCliBackendPreserveEnv(process.env[CLI_BACKEND_PRESERVE_ENV]);
          for (const key of backend.clearEnv ?? []) {
            if (preservedEnv.has(key)) {
              continue;
            }
            delete next[key];
          }
          if (backend.env && Object.keys(backend.env).length > 0) {
            Object.assign(
              next,
              sanitizeHostExecEnv({
                baseEnv: {},
                blockPathOverrides: true,
                overrides: backend.env,
              }),
            );
          }
          Object.assign(next, context.preparedBackend.env);

          // Never mark Claude CLI as host-managed. That marker routes runs into
          // Anthropic's separate host-managed usage tier instead of normal CLI
          // Subscription behavior.
          delete next["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"];

          return next;
        })();
        if (logOutputText) {
          const logArgs = buildCliLogArgs({
            args,
            argsPrompt,
            imageArg: backend.imageArg,
            modelArg: backend.modelArg,
            sessionArg: backend.sessionArg,
            systemPromptArg: backend.systemPromptArg,
          });
          cliBackendLog.info(`cli argv: ${backend.command} ${logArgs.join(" ")}`);
          cliBackendLog.info(`cli env auth: ${buildCliEnvAuthLog(env)}`);
        }

        const noOutputTimeoutMs = resolveCliNoOutputTimeoutMs({
          backend,
          timeoutMs: params.timeoutMs,
          useResume,
        });
        const streamingParser =
          backend.output === "jsonl"
            ? createCliJsonlStreamingParser({
                backend,
                onAssistantDelta: ({ text, delta }) => {
                  emitAgentEvent({
                    data: {
                      delta,
                      text,
                    },
                    runId: params.runId,
                    stream: "assistant",
                  });
                },
                providerId: context.backendResolved.id,
              })
            : null;
        const supervisor = executeDeps.getProcessSupervisor();
        const scopeKey = buildCliSupervisorScopeKey({
          backend,
          backendId: context.backendResolved.id,
          cliSessionId: useResume ? resolvedSessionId : undefined,
        });

        const managedRun = await supervisor.spawn({
          argv: [backend.command, ...args],
          backendId: context.backendResolved.id,
          cwd: context.workspaceDir,
          env,
          input: stdinPayload,
          mode: "child",
          noOutputTimeoutMs,
          onStdout: streamingParser ? (chunk: string) => streamingParser.push(chunk) : undefined,
          replaceExistingScope: Boolean(useResume && scopeKey),
          scopeKey,
          sessionId: params.sessionId,
          timeoutMs: params.timeoutMs,
        });
        const replyBackendHandle = params.replyOperation
          ? {
              cancel: () => {
                managedRun.cancel("manual-cancel");
              },
              isStreaming: () => false,
              kind: "cli" as const,
            }
          : undefined;
        if (replyBackendHandle) {
          params.replyOperation?.attachBackend(replyBackendHandle);
        }
        const abortManagedRun = () => {
          managedRun.cancel("manual-cancel");
        };
        params.abortSignal?.addEventListener("abort", abortManagedRun, { once: true });
        if (params.abortSignal?.aborted) {
          abortManagedRun();
        }
        let result: Awaited<ReturnType<typeof managedRun.wait>>;
        try {
          result = await managedRun.wait();
        } finally {
          if (replyBackendHandle) {
            params.replyOperation?.detachBackend(replyBackendHandle);
          }
          params.abortSignal?.removeEventListener("abort", abortManagedRun);
        }
        streamingParser?.finish();
        if (params.abortSignal?.aborted && result.reason === "manual-cancel") {
          throw createCliAbortError();
        }

        const stdout = result.stdout.trim();
        const stderr = result.stderr.trim();
        if (logOutputText) {
          if (stdout) {
            cliBackendLog.info(`cli stdout:\n${stdout}`);
          }
          if (stderr) {
            cliBackendLog.info(`cli stderr:\n${stderr}`);
          }
        }
        if (shouldLogVerbose()) {
          if (stdout) {
            cliBackendLog.debug(`cli stdout:\n${stdout}`);
          }
          if (stderr) {
            cliBackendLog.debug(`cli stderr:\n${stderr}`);
          }
        }

        if (result.exitCode !== 0 || result.reason !== "exit") {
          if (result.reason === "no-output-timeout" || result.noOutputTimedOut) {
            const timeoutReason = `CLI produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`;
            cliBackendLog.warn(
              `cli watchdog timeout: provider=${params.provider} model=${context.modelId} session=${resolvedSessionId ?? params.sessionId} noOutputTimeoutMs=${noOutputTimeoutMs} pid=${managedRun.pid ?? "unknown"}`,
            );
            if (params.sessionKey) {
              const stallNotice = [
                `CLI agent (${params.provider}) produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`,
                "It may have been waiting for interactive input or an approval prompt.",
                "For Claude Code, prefer --permission-mode bypassPermissions --print.",
              ].join(" ");
              executeDeps.enqueueSystemEvent(stallNotice, { sessionKey: params.sessionKey });
              executeDeps.requestHeartbeatNow(
                scopedHeartbeatWakeOptions(params.sessionKey, { reason: "cli:watchdog:stall" }),
              );
            }
            throw new FailoverError(timeoutReason, {
              model: context.modelId,
              provider: params.provider,
              reason: "timeout",
              status: resolveFailoverStatus("timeout"),
            });
          }
          if (result.reason === "overall-timeout") {
            const timeoutReason = `CLI exceeded timeout (${Math.round(params.timeoutMs / 1000)}s) and was terminated.`;
            throw new FailoverError(timeoutReason, {
              model: context.modelId,
              provider: params.provider,
              reason: "timeout",
              status: resolveFailoverStatus("timeout"),
            });
          }
          const primaryErrorText = stderr || stdout;
          const structuredError =
            extractCliErrorMessage(primaryErrorText) ??
            (stderr ? extractCliErrorMessage(stdout) : null);
          const err = structuredError || primaryErrorText || "CLI failed.";
          const reason = classifyFailoverReason(err, { provider: params.provider }) ?? "unknown";
          const status = resolveFailoverStatus(reason);
          throw new FailoverError(err, {
            model: context.modelId,
            provider: params.provider,
            reason,
            status,
          });
        }

        return parseCliOutput({
          backend,
          fallbackSessionId: resolvedSessionId,
          outputMode: useResume ? (backend.resumeOutput ?? backend.output) : backend.output,
          providerId: context.backendResolved.id,
          raw: stdout,
        });
      } finally {
        restoreSkillEnv?.();
      }
    });
  } finally {
    await claudeSkillsPlugin.cleanup();
    if (systemPromptFile) {
      await systemPromptFile.cleanup();
    }
    if (cleanupImages) {
      await cleanupImages();
    }
  }
}
