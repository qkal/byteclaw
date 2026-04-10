import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  formatMemoryDreamingDay,
  resolveSessionTranscriptsDirForAgent,
} from "openclaw/plugin-sdk/memory-core";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { QaBusState } from "./bus-state.js";
import { waitForCronRunCompletion } from "./cron-run-wait.js";
import {
  hasDiscoveryLabels,
  reportsDiscoveryScopeLeak,
  reportsMissingDiscoveryFiles,
} from "./discovery-eval.js";
import { extractQaToolPayload } from "./extract-tool-payload.js";
import { startQaGatewayChild } from "./gateway-child.js";
import type {
  QaLabLatestReport,
  QaLabScenarioOutcome,
  QaLabServerHandle,
  QaLabServerStartParams,
} from "./lab-server.types.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";
import {
  type QaProviderMode,
  defaultQaModelForMode,
  isQaFastModeEnabled,
  normalizeQaProviderMode,
} from "./model-selection.js";
import { hasModelSwitchContinuityEvidence } from "./model-switch-eval.js";
import type { QaThinkingLevel } from "./qa-gateway-config.js";
import { extractQaFailureReplyText } from "./reply-failure.js";
import { type QaReportCheck, type QaReportScenario, renderQaMarkdownReport } from "./report.js";
import { type QaBusMessage, qaChannelPlugin } from "./runtime-api.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";

interface QaSuiteStep {
  name: string;
  run: () => Promise<string | void>;
}

interface QaSuiteScenarioResult {
  name: string;
  status: "pass" | "fail";
  steps: QaReportCheck[];
  details?: string;
}

interface QaSuiteEnvironment {
  lab: QaLabServerHandle;
  mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | null;
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>;
  cfg: OpenClawConfig;
  repoRoot: string;
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
}

export type QaSuiteStartLabFn = (params?: QaLabServerStartParams) => Promise<QaLabServerHandle>;

export interface QaSuiteRunParams {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: QaProviderMode | "live-openai";
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  scenarioIds?: string[];
  lab?: QaLabServerHandle;
  startLab?: QaSuiteStartLabFn;
  concurrency?: number;
}

async function startQaLabServerRuntime(
  params?: QaLabServerStartParams,
): Promise<QaLabServerHandle> {
  const { startQaLabServer } = await import("./lab-server.js");
  return await startQaLabServer(params);
}

const _QA_IMAGE_UNDERSTANDING_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAAAklEQVR4AewaftIAAAK4SURBVO3BAQEAMAwCIG//znsQgXfJBZjUALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsl9wFmNQAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwP4TIF+7ciPkoAAAAASUVORK5CYII=";
const _QA_IMAGE_UNDERSTANDING_LARGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAACuklEQVR4Ae3BAQEAMAwCIG//znsQgXfJBZjUALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsl9wFmNQAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwP4TIF+2YE/z8AAAAASUVORK5CYII=";

const QA_IMAGE_UNDERSTANDING_VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALklEQVR4nO3OoQEAAAyDsP7/9HYGJgJNdtuVDQAAAAAAACAHxH8AAAAAAACAHvBX0fhq85dN7QAAAABJRU5ErkJggg==";

interface QaSkillStatusEntry {
  name?: string;
  eligible?: boolean;
  disabled?: boolean;
  blockedByAllowlist?: boolean;
}

interface QaConfigSnapshot {
  hash?: string;
  config?: Record<string, unknown>;
}

interface QaDreamingStatus {
  enabled?: boolean;
  shortTermCount?: number;
  promotedTotal?: number;
  phaseSignalCount?: number;
  lightPhaseHitCount?: number;
  remPhaseHitCount?: number;
  phases?: {
    deep?: {
      managedCronPresent?: boolean;
      nextRunAtMs?: number;
    };
  };
}

interface QaRawSessionStoreEntry {
  sessionId?: string;
  status?: string;
  spawnedBy?: string;
  label?: string;
  abortedLastRun?: boolean;
  updatedAt?: number;
}

const DEFAULT_QA_SUITE_CONCURRENCY = 64;

function normalizeQaSuiteConcurrency(value: number | undefined, scenarioCount: number) {
  const envValue = Number(process.env.OPENCLAW_QA_SUITE_CONCURRENCY);
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : (Number.isFinite(envValue)
        ? envValue
        : DEFAULT_QA_SUITE_CONCURRENCY);
  return Math.max(1, Math.min(Math.floor(raw), Math.max(1, scenarioCount)));
}

async function mapQaSuiteWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
) {
  const results = Array.from<U>({ length: items.length });
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function splitModelRef(ref: string) {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return null;
  }
  return {
    model: ref.slice(slash + 1),
    provider: ref.slice(0, slash),
  };
}

function liveTurnTimeoutMs(env: QaSuiteEnvironment, fallbackMs: number) {
  return resolveQaLiveTurnTimeoutMs(env, fallbackMs);
}

export interface QaSuiteResult {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  report: string;
  scenarios: QaSuiteScenarioResult[];
  watchUrl: string;
}

function createQaActionConfig(baseUrl: string): OpenClawConfig {
  return {
    channels: {
      "qa-channel": {
        allowFrom: ["*"],
        baseUrl,
        botDisplayName: "OpenClaw QA",
        botUserId: "openclaw",
        enabled: true,
      },
    },
  };
}

async function waitForCondition<T>(
  check: () => T | Promise<T | null | undefined> | null | undefined,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value !== null && value !== undefined) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

function findFailureOutboundMessage(
  state: QaBusState,
  options?: { sinceIndex?: number; cursorSpace?: "all" | "outbound" },
) {
  const cursorSpace = options?.cursorSpace ?? "outbound";
  const observedMessages =
    cursorSpace === "all"
      ? state.getSnapshot().messages.slice(options?.sinceIndex ?? 0)
      : state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .slice(options?.sinceIndex ?? 0);
  return observedMessages.find(
    (message) =>
      message.direction === "outbound" && Boolean(extractQaFailureReplyText(message.text)),
  );
}

function createScenarioWaitForCondition(state: QaBusState) {
  const sinceIndex = state.getSnapshot().messages.length;
  return async function waitForScenarioCondition<T>(
    check: () => T | Promise<T | null | undefined> | null | undefined,
    timeoutMs = 15_000,
    intervalMs = 100,
  ): Promise<T> {
    return await waitForCondition(
      async () => {
        const failureMessage = findFailureOutboundMessage(state, {
          cursorSpace: "all",
          sinceIndex,
        });
        if (failureMessage) {
          throw new Error(extractQaFailureReplyText(failureMessage.text) ?? failureMessage.text);
        }
        return await check();
      },
      timeoutMs,
      intervalMs,
    );
  };
}

async function waitForOutboundMessage(
  state: QaBusState,
  predicate: (message: QaBusMessage) => boolean,
  timeoutMs = 15_000,
  options?: { sinceIndex?: number },
) {
  return await waitForCondition(() => {
    const failureMessage = findFailureOutboundMessage(state, options);
    if (failureMessage) {
      throw new Error(extractQaFailureReplyText(failureMessage.text) ?? failureMessage.text);
    }
    const match = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound")
      .slice(options?.sinceIndex ?? 0)
      .find(predicate);
    if (!match) {
      return undefined;
    }
    const failureReply = extractQaFailureReplyText(match.text);
    if (failureReply) {
      throw new Error(failureReply);
    }
    return match;
  }, timeoutMs);
}

async function waitForNoOutbound(state: QaBusState, timeoutMs = 1200) {
  await sleep(timeoutMs);
  const outbound = state
    .getSnapshot()
    .messages.filter((message) => message.direction === "outbound");
  if (outbound.length > 0) {
    throw new Error(`expected no outbound messages, saw ${outbound.length}`);
  }
}

function recentOutboundSummary(state: QaBusState, limit = 5) {
  return state
    .getSnapshot()
    .messages.filter((message) => message.direction === "outbound")
    .slice(-limit)
    .map((message) => `${message.conversation.id}:${message.text}`)
    .join(" | ");
}

function formatConversationTranscript(
  state: QaBusState,
  params: {
    conversationId: string;
    threadId?: string;
    limit?: number;
  },
) {
  const messages = state
    .getSnapshot()
    .messages.filter(
      (message) =>
        message.conversation.id === params.conversationId &&
        (params.threadId ? message.threadId === params.threadId : true),
    );
  const selected = params.limit ? messages.slice(-params.limit) : messages;
  return selected
    .map((message) => {
      const direction = message.direction === "inbound" ? "user" : "assistant";
      const speaker = message.senderName?.trim() || message.senderId;
      const attachmentSummary =
        message.attachments && message.attachments.length > 0
          ? ` [attachments: ${message.attachments
              .map((attachment) => `${attachment.kind}:${attachment.fileName ?? attachment.id}`)
              .join(", ")}]`
          : "";
      return `${direction.toUpperCase()} ${speaker}: ${message.text}${attachmentSummary}`;
    })
    .join("\n\n");
}

async function runScenario(name: string, steps: QaSuiteStep[]): Promise<QaSuiteScenarioResult> {
  const stepResults: QaReportCheck[] = [];
  for (const step of steps) {
    try {
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] start scenario="${name}" step="${step.name}"`);
      }
      const details = await step.run();
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] pass scenario="${name}" step="${step.name}"`);
      }
      stepResults.push({
        name: step.name,
        status: "pass",
        ...(details ? { details } : {}),
      });
    } catch (error) {
      const details = formatErrorMessage(error);
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] fail scenario="${name}" step="${step.name}" details=${details}`);
      }
      stepResults.push({
        details,
        name: step.name,
        status: "fail",
      });
      return {
        details,
        name,
        status: "fail",
        steps: stepResults,
      };
    }
  }
  return {
    name,
    status: "pass",
    steps: stepResults,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    auditContext: "qa-lab-suite-fetch-json",
    policy: { allowPrivateNetwork: true },
    url,
  });
  try {
    if (!response.ok) {
      throw new Error(`request failed ${response.status}: ${url}`);
    }
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

async function waitForGatewayHealthy(env: QaSuiteEnvironment, timeoutMs = 45_000) {
  await waitForCondition(
    async () => {
      try {
        const { response, release } = await fetchWithSsrFGuard({
          auditContext: "qa-lab-suite-wait-for-gateway-healthy",
          policy: { allowPrivateNetwork: true },
          url: `${env.gateway.baseUrl}/readyz`,
        });
        try {
          return response.ok ? true : undefined;
        } finally {
          await release();
        }
      } catch {
        return undefined;
      }
    },
    timeoutMs,
    250,
  );
}

async function waitForQaChannelReady(env: QaSuiteEnvironment, timeoutMs = 45_000) {
  await waitForCondition(
    async () => {
      try {
        const payload = (await env.gateway.call(
          "channels.status",
          { probe: false, timeoutMs: 2000 },
          { timeoutMs: 5000 },
        )) as {
          channelAccounts?: Record<
            string,
            {
              accountId?: string;
              running?: boolean;
              restartPending?: boolean;
            }[]
          >;
        };
        const accounts = payload.channelAccounts?.["qa-channel"] ?? [];
        const account = accounts.find((entry) => entry.accountId === "default") ?? accounts[0];
        if (account?.running && account.restartPending !== true) {
          return true;
        }
        return undefined;
      } catch {
        return undefined;
      }
    },
    timeoutMs,
    500,
  );
}

async function waitForConfigRestartSettle(
  env: QaSuiteEnvironment,
  restartDelayMs = 1000,
  timeoutMs = 60_000,
) {
  // Config.patch/config.apply can still restart asynchronously after the RPC returns
  // In reload-off or restart-required hot-mode paths. Give that window time to fire.
  await sleep(restartDelayMs + 750);
  await waitForGatewayHealthy(env, timeoutMs);
}

function isGatewayRestartRace(error: unknown) {
  const text = formatGatewayPrimaryErrorText(error);
  return (
    text.includes("gateway closed (1012)") ||
    text.includes("gateway closed (1006") ||
    text.includes("abnormal closure") ||
    text.includes("service restart")
  );
}

function isConfigHashConflict(error: unknown) {
  return formatGatewayPrimaryErrorText(error).includes("config changed since last load");
}

function formatGatewayPrimaryErrorText(error: unknown) {
  const text = formatErrorMessage(error);
  const gatewayLogsIndex = text.indexOf("\nGateway logs:");
  return (gatewayLogsIndex !== -1 ? text.slice(0, gatewayLogsIndex) : text).trim();
}

function getGatewayRetryAfterMs(error: unknown) {
  const text = formatGatewayPrimaryErrorText(error);
  const millisecondsMatch = /retryAfterMs["=: ]+(\d+)/i.exec(text);
  if (millisecondsMatch) {
    const parsed = Number(millisecondsMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const secondsMatch = /retry after (\d+)s/i.exec(text);
  if (secondsMatch) {
    const parsed = Number(secondsMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed * 1000;
    }
  }
  return null;
}

async function readConfigSnapshot(env: QaSuiteEnvironment) {
  const snapshot = (await env.gateway.call(
    "config.get",
    {},
    { timeoutMs: 60_000 },
  )) as QaConfigSnapshot;
  if (!snapshot.hash || !snapshot.config) {
    throw new Error("config.get returned no hash/config");
  }
  return {
    config: snapshot.config,
    hash: snapshot.hash,
  } satisfies { hash: string; config: Record<string, unknown> };
}

async function runConfigMutation(params: {
  env: QaSuiteEnvironment;
  action: "config.patch" | "config.apply";
  raw: string;
  sessionKey?: string;
  note?: string;
  restartDelayMs?: number;
}) {
  const restartDelayMs = params.restartDelayMs ?? 1000;
  let lastConflict: unknown = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const snapshot = await readConfigSnapshot(params.env);
    try {
      const result = await params.env.gateway.call(
        params.action,
        {
          raw: params.raw,
          baseHash: snapshot.hash,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(params.note ? { note: params.note } : {}),
          restartDelayMs,
        },
        { timeoutMs: 45_000 },
      );
      await waitForConfigRestartSettle(params.env, restartDelayMs);
      return result;
    } catch (error) {
      if (isConfigHashConflict(error)) {
        lastConflict = error;
        await waitForGatewayHealthy(params.env, Math.max(15_000, restartDelayMs + 10_000)).catch(
          () => undefined,
        );
        continue;
      }
      const retryAfterMs = getGatewayRetryAfterMs(error);
      if (retryAfterMs && attempt < 8) {
        await sleep(retryAfterMs + 500);
        await waitForGatewayHealthy(params.env, Math.max(15_000, restartDelayMs + 10_000)).catch(
          () => undefined,
        );
        continue;
      }
      if (!isGatewayRestartRace(error)) {
        throw error;
      }
      await waitForConfigRestartSettle(params.env, restartDelayMs);
      return { ok: true, restarted: true };
    }
  }
  throw lastConflict ?? new Error(`${params.action} failed after retrying config hash conflicts`);
}

async function patchConfig(params: {
  env: QaSuiteEnvironment;
  patch: Record<string, unknown>;
  sessionKey?: string;
  note?: string;
  restartDelayMs?: number;
}) {
  return await runConfigMutation({
    action: "config.patch",
    env: params.env,
    note: params.note,
    raw: JSON.stringify(params.patch, null, 2),
    restartDelayMs: params.restartDelayMs,
    sessionKey: params.sessionKey,
  });
}

async function applyConfig(params: {
  env: QaSuiteEnvironment;
  nextConfig: Record<string, unknown>;
  sessionKey?: string;
  note?: string;
  restartDelayMs?: number;
}) {
  return await runConfigMutation({
    action: "config.apply",
    env: params.env,
    note: params.note,
    raw: JSON.stringify(params.nextConfig, null, 2),
    restartDelayMs: params.restartDelayMs,
    sessionKey: params.sessionKey,
  });
}

async function createSession(env: QaSuiteEnvironment, label: string, key?: string) {
  const created = (await env.gateway.call(
    "sessions.create",
    {
      label,
      ...(key ? { key } : {}),
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 60_000),
    },
  )) as { key?: string };
  const sessionKey = created.key?.trim();
  if (!sessionKey) {
    throw new Error("sessions.create returned no key");
  }
  return sessionKey;
}

async function readEffectiveTools(env: QaSuiteEnvironment, sessionKey: string) {
  const payload = (await env.gateway.call(
    "tools.effective",
    {
      sessionKey,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 90_000),
    },
  )) as {
    groups?: { tools?: { id?: string }[] }[];
  };
  const ids = new Set<string>();
  for (const group of payload.groups ?? []) {
    for (const tool of group.tools ?? []) {
      if (tool.id?.trim()) {
        ids.add(tool.id.trim());
      }
    }
  }
  return ids;
}

async function readSkillStatus(env: QaSuiteEnvironment, agentId = "qa") {
  const payload = (await env.gateway.call(
    "skills.status",
    {
      agentId,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 45_000),
    },
  )) as {
    skills?: QaSkillStatusEntry[];
  };
  return payload.skills ?? [];
}

async function readRawQaSessionStore(env: QaSuiteEnvironment) {
  const storePath = path.join(
    env.gateway.tempRoot,
    "state",
    "agents",
    "qa",
    "sessions",
    "sessions.json",
  );
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return JSON.parse(raw) as Record<string, QaRawSessionStoreEntry>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function runQaCli(
  env: QaSuiteEnvironment,
  args: string[],
  opts?: { timeoutMs?: number; json?: boolean },
) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const distEntryPath = path.join(env.repoRoot, "dist", "index.js");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [distEntryPath, ...args], {
      cwd: env.gateway.tempRoot,
      env: env.gateway.runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`qa cli timed out: openclaw ${args.join(" ")}`));
    }, opts?.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `qa cli failed (${code ?? "unknown"}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ),
      );
    });
  });
  const text = Buffer.concat(stdout).toString("utf8").trim();
  if (!opts?.json) {
    return text;
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

function extractMediaPathFromText(text: string | undefined): string | undefined {
  return /MEDIA:([^\n]+)/.exec(text ?? "")?.[1]?.trim();
}

async function resolveGeneratedImagePath(params: {
  env: QaSuiteEnvironment;
  promptSnippet: string;
  startedAtMs: number;
  timeoutMs: number;
}) {
  return await waitForCondition(
    async () => {
      if (params.env.mock) {
        const requests = await fetchJson<{ allInputText?: string; toolOutput?: string }[]>(
          `${params.env.mock.baseUrl}/debug/requests`,
        );
        for (let index = requests.length - 1; index >= 0; index -= 1) {
          const request = requests[index];
          if (!String(request.allInputText ?? "").includes(params.promptSnippet)) {
            continue;
          }
          const mediaPath = extractMediaPathFromText(request.toolOutput);
          if (mediaPath) {
            return mediaPath;
          }
        }
      }

      const mediaDir = path.join(
        params.env.gateway.tempRoot,
        "state",
        "media",
        "tool-image-generation",
      );
      const entries = await fs.readdir(mediaDir).catch(() => []);
      const candidates = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(mediaDir, entry);
          const stat = await fs.stat(fullPath).catch(() => null);
          if (!stat?.isFile()) {
            return null;
          }
          return {
            fullPath,
            mtimeMs: stat.mtimeMs,
          };
        }),
      );
      return candidates
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .filter((entry) => entry.mtimeMs >= params.startedAtMs - 1000)
        .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
        .at(0)?.fullPath;
    },
    params.timeoutMs,
    250,
  );
}

async function startAgentRun(
  env: QaSuiteEnvironment,
  params: {
    sessionKey: string;
    message: string;
    to?: string;
    threadId?: string;
    provider?: string;
    model?: string;
    timeoutMs?: number;
    attachments?: {
      mimeType: string;
      fileName: string;
      content: string;
    }[];
  },
) {
  const target = params.to ?? "dm:qa-operator";
  const started = (await env.gateway.call(
    "agent",
    {
      agentId: "qa",
      channel: "qa-channel",
      deliver: true,
      idempotencyKey: randomUUID(),
      message: params.message,
      replyChannel: "qa-channel",
      replyTo: target,
      sessionKey: params.sessionKey,
      to: target,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.attachments ? { attachments: params.attachments } : {}),
    },
    {
      timeoutMs: params.timeoutMs ?? 30_000,
    },
  )) as { runId?: string; status?: string };
  if (!started.runId) {
    throw new Error(`agent call did not return a runId: ${JSON.stringify(started)}`);
  }
  return started;
}

async function waitForAgentRun(env: QaSuiteEnvironment, runId: string, timeoutMs = 30_000) {
  return (await env.gateway.call(
    "agent.wait",
    {
      runId,
      timeoutMs,
    },
    {
      timeoutMs: timeoutMs + 5000,
    },
  )) as { status?: string; error?: string };
}

async function listCronJobs(env: QaSuiteEnvironment) {
  const payload = (await env.gateway.call(
    "cron.list",
    {
      includeDisabled: true,
      limit: 200,
      sortBy: "name",
      sortDir: "asc",
    },
    { timeoutMs: 30_000 },
  )) as {
    jobs?: {
      id?: string;
      name?: string;
      payload?: { kind?: string; text?: string };
      state?: { nextRunAtMs?: number };
    }[];
  };
  return payload.jobs ?? [];
}

async function readDoctorMemoryStatus(env: QaSuiteEnvironment) {
  return (await env.gateway.call("doctor.memory.status", {}, { timeoutMs: 30_000 })) as {
    dreaming?: QaDreamingStatus;
  };
}

async function forceMemoryIndex(params: {
  env: QaSuiteEnvironment;
  query: string;
  expectedNeedle: string;
}) {
  await waitForGatewayHealthy(params.env, 60_000);
  await waitForQaChannelReady(params.env, 60_000);
  await runQaCli(params.env, ["memory", "index", "--agent", "qa", "--force"], {
    timeoutMs: liveTurnTimeoutMs(params.env, 60_000),
  });
  const payload = await waitForCondition(
    async () => {
      const result = (await runQaCli(
        params.env,
        ["memory", "search", "--agent", "qa", "--json", "--query", params.query],
        {
          json: true,
          timeoutMs: liveTurnTimeoutMs(params.env, 60_000),
        },
      )) as { results?: { snippet?: string; text?: string; path?: string }[] };
      const haystack = JSON.stringify(result.results ?? []);
      return haystack.includes(params.expectedNeedle) ? result : undefined;
    },
    liveTurnTimeoutMs(params.env, 20_000),
    500,
  );
  const haystack = JSON.stringify(payload.results ?? []);
  if (!haystack.includes(params.expectedNeedle)) {
    throw new Error(`memory index missing expected fact after reindex: ${haystack}`);
  }
}

function findSkill(skills: QaSkillStatusEntry[], name: string) {
  return skills.find((skill) => skill.name === name);
}

async function writeWorkspaceSkill(params: {
  env: QaSuiteEnvironment;
  name: string;
  body: string;
}) {
  const skillDir = path.join(params.env.gateway.workspaceDir, "skills", params.name);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillPath, `${params.body.trim()}\n`, "utf8");
  return skillPath;
}

async function callPluginToolsMcp(params: {
  env: QaSuiteEnvironment;
  toolName: string;
  args: Record<string, unknown>;
}) {
  const transportEnv = Object.fromEntries(
    Object.entries(params.env.gateway.runtimeEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const transport = new StdioClientTransport({
    args: ["--import", "tsx", "src/mcp/plugin-tools-serve.ts"],
    command: process.execPath,
    env: transportEnv,
    stderr: "pipe",
  });
  const client = new Client({ name: "openclaw-qa-suite", version: "0.0.0" }, {});
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tool = listed.tools.find((entry) => entry.name === params.toolName);
    if (!tool) {
      throw new Error(`MCP tool missing: ${params.toolName}`);
    }
    return await client.callTool({
      arguments: params.args,
      name: params.toolName,
    });
  } finally {
    await client.close().catch(() => {});
  }
}

async function runAgentPrompt(
  env: QaSuiteEnvironment,
  params: {
    sessionKey: string;
    message: string;
    to?: string;
    threadId?: string;
    provider?: string;
    model?: string;
    timeoutMs?: number;
    attachments?: {
      mimeType: string;
      fileName: string;
      content: string;
    }[];
  },
) {
  const started = await startAgentRun(env, params);
  const waited = await waitForAgentRun(env, started.runId!, params.timeoutMs ?? 30_000);
  if (waited.status !== "ok") {
    throw new Error(
      `agent.wait returned ${String(waited.status ?? "unknown")}: ${waited.error ?? "no error"}`,
    );
  }
  return {
    started,
    waited,
  };
}

async function ensureImageGenerationConfigured(env: QaSuiteEnvironment) {
  const imageModelRef = "openai/gpt-image-1";
  await patchConfig({
    env,
    patch:
      env.providerMode === "mock-openai"
        ? {
            agents: {
              defaults: {
                imageGenerationModel: {
                  primary: imageModelRef,
                },
              },
            },
            models: {
              providers: {
                openai: {
                  api: "openai-responses",
                  apiKey: "test",
                  baseUrl: `${env.mock?.baseUrl}/v1`,
                  models: [
                    {
                      api: "openai-responses",
                      contextWindow: 128_000,
                      cost: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 0,
                        output: 0,
                      },
                      id: "gpt-image-1",
                      input: ["text"],
                      maxTokens: 4096,
                      name: "gpt-image-1",
                      reasoning: false,
                    },
                  ],
                },
              },
            },
            plugins: {
              allow: ["memory-core", "openai", "qa-channel"],
              entries: {
                openai: {
                  enabled: true,
                },
              },
            },
          }
        : {
            agents: {
              defaults: {
                imageGenerationModel: {
                  primary: imageModelRef,
                },
              },
            },
          },
  });
  await waitForGatewayHealthy(env);
  await waitForQaChannelReady(env, 60_000);
}

type QaActionName = "delete" | "edit" | "react" | "thread-create";

async function handleQaAction(params: {
  env: QaSuiteEnvironment;
  action: QaActionName;
  args: Record<string, unknown>;
}) {
  const result = await qaChannelPlugin.actions?.handleAction?.({
    accountId: "default",
    action: params.action,
    cfg: params.env.cfg,
    channel: "qa-channel",
    params: params.args,
  });
  return extractQaToolPayload(result);
}

interface QaScenarioFlowApi {
  env: QaSuiteEnvironment;
  lab: QaSuiteEnvironment["lab"];
  state: QaBusState;
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number];
  config: Record<string, unknown>;
  fs: typeof fs;
  path: typeof path;
  sleep: typeof sleep;
  randomUUID: typeof randomUUID;
  runScenario: typeof runScenario;
  waitForCondition: typeof waitForCondition;
  waitForOutboundMessage: typeof waitForOutboundMessage;
  waitForNoOutbound: typeof waitForNoOutbound;
  recentOutboundSummary: typeof recentOutboundSummary;
  formatConversationTranscript: typeof formatConversationTranscript;
  fetchJson: typeof fetchJson;
  waitForGatewayHealthy: typeof waitForGatewayHealthy;
  waitForQaChannelReady: typeof waitForQaChannelReady;
  waitForConfigRestartSettle: typeof waitForConfigRestartSettle;
  patchConfig: typeof patchConfig;
  applyConfig: typeof applyConfig;
  readConfigSnapshot: typeof readConfigSnapshot;
  createSession: typeof createSession;
  readEffectiveTools: typeof readEffectiveTools;
  readSkillStatus: typeof readSkillStatus;
  readRawQaSessionStore: typeof readRawQaSessionStore;
  runQaCli: typeof runQaCli;
  extractMediaPathFromText: typeof extractMediaPathFromText;
  resolveGeneratedImagePath: typeof resolveGeneratedImagePath;
  startAgentRun: typeof startAgentRun;
  waitForAgentRun: typeof waitForAgentRun;
  listCronJobs: typeof listCronJobs;
  waitForCronRunCompletion: typeof waitForCronRunCompletion;
  readDoctorMemoryStatus: typeof readDoctorMemoryStatus;
  forceMemoryIndex: typeof forceMemoryIndex;
  findSkill: typeof findSkill;
  writeWorkspaceSkill: typeof writeWorkspaceSkill;
  callPluginToolsMcp: typeof callPluginToolsMcp;
  runAgentPrompt: typeof runAgentPrompt;
  ensureImageGenerationConfigured: typeof ensureImageGenerationConfigured;
  handleQaAction: typeof handleQaAction;
  extractQaToolPayload: typeof extractQaToolPayload;
  formatMemoryDreamingDay: typeof formatMemoryDreamingDay;
  resolveSessionTranscriptsDirForAgent: typeof resolveSessionTranscriptsDirForAgent;
  buildAgentSessionKey: typeof buildAgentSessionKey;
  normalizeLowercaseStringOrEmpty: typeof normalizeLowercaseStringOrEmpty;
  formatErrorMessage: typeof formatErrorMessage;
  liveTurnTimeoutMs: typeof liveTurnTimeoutMs;
  resolveQaLiveTurnTimeoutMs: typeof resolveQaLiveTurnTimeoutMs;
  splitModelRef: typeof splitModelRef;
  qaChannelPlugin: typeof qaChannelPlugin;
  hasDiscoveryLabels: typeof hasDiscoveryLabels;
  reportsDiscoveryScopeLeak: typeof reportsDiscoveryScopeLeak;
  reportsMissingDiscoveryFiles: typeof reportsMissingDiscoveryFiles;
  hasModelSwitchContinuityEvidence: typeof hasModelSwitchContinuityEvidence;
  imageUnderstandingPngBase64: string;
  imageUnderstandingLargePngBase64: string;
  imageUnderstandingValidPngBase64: string;
  resetBus: () => Promise<void>;
  reset: () => Promise<void>;
}

function createScenarioFlowApi(
  env: QaSuiteEnvironment,
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number],
): QaScenarioFlowApi {
  return {
    applyConfig,
    buildAgentSessionKey,
    callPluginToolsMcp,
    config: scenario.execution.config ?? {},
    createSession,
    ensureImageGenerationConfigured,
    env,
    extractMediaPathFromText,
    extractQaToolPayload,
    fetchJson,
    findSkill,
    forceMemoryIndex,
    formatConversationTranscript,
    formatErrorMessage,
    formatMemoryDreamingDay,
    fs,
    handleQaAction,
    hasDiscoveryLabels,
    hasModelSwitchContinuityEvidence,
    imageUnderstandingLargePngBase64: _QA_IMAGE_UNDERSTANDING_LARGE_PNG_BASE64,
    imageUnderstandingPngBase64: _QA_IMAGE_UNDERSTANDING_PNG_BASE64,
    imageUnderstandingValidPngBase64: QA_IMAGE_UNDERSTANDING_VALID_PNG_BASE64,
    lab: env.lab,
    listCronJobs,
    liveTurnTimeoutMs,
    normalizeLowercaseStringOrEmpty,
    patchConfig,
    path,
    qaChannelPlugin,
    randomUUID,
    readConfigSnapshot,
    readDoctorMemoryStatus,
    readEffectiveTools,
    readRawQaSessionStore,
    readSkillStatus,
    recentOutboundSummary,
    reportsDiscoveryScopeLeak,
    reportsMissingDiscoveryFiles,
    reset: async () => {
      env.lab.state.reset();
      await sleep(100);
    },
    resetBus: async () => {
      env.lab.state.reset();
      await sleep(100);
    },
    resolveGeneratedImagePath,
    resolveQaLiveTurnTimeoutMs,
    resolveSessionTranscriptsDirForAgent,
    runAgentPrompt,
    runQaCli,
    runScenario,
    scenario,
    sleep,
    splitModelRef,
    startAgentRun,
    state: env.lab.state,
    waitForAgentRun,
    waitForCondition: createScenarioWaitForCondition(env.lab.state),
    waitForConfigRestartSettle,
    waitForCronRunCompletion,
    waitForGatewayHealthy,
    waitForNoOutbound,
    waitForOutboundMessage,
    waitForQaChannelReady,
    writeWorkspaceSkill,
  };
}

export const qaSuiteTesting = {
  createScenarioWaitForCondition,
  findFailureOutboundMessage,
  getGatewayRetryAfterMs,
  isConfigHashConflict,
  mapQaSuiteWithConcurrency,
  normalizeQaSuiteConcurrency,
  waitForOutboundMessage,
};

async function runScenarioDefinition(
  env: QaSuiteEnvironment,
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number],
) {
  const api = createScenarioFlowApi(env, scenario);
  if (!scenario.execution.flow) {
    throw new Error(`scenario missing flow: ${scenario.id}`);
  }
  return await runScenarioFlow({
    api,
    flow: scenario.execution.flow,
    scenarioTitle: scenario.title,
  });
}

function createQaSuiteReportNotes(params: {
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
}) {
  return [
    params.providerMode === "mock-openai"
      ? "Runs against qa-channel + qa-lab bus + real gateway child + mock OpenAI provider."
      : `Runs against qa-channel + qa-lab bus + real gateway child + live frontier models (${params.primaryModel}, ${params.alternateModel})${params.fastMode ? " with fast mode enabled" : ""}.`,
    params.concurrency > 1
      ? `Scenarios run in isolated gateway workers with concurrency ${params.concurrency}.`
      : "Scenarios run serially in one gateway worker.",
    "Cron uses a one-minute schedule assertion plus forced execution for fast verification.",
  ];
}

async function writeQaSuiteArtifacts(params: {
  outputDir: string;
  startedAt: Date;
  finishedAt: Date;
  scenarios: QaSuiteScenarioResult[];
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
}) {
  const report = renderQaMarkdownReport({
    checks: [],
    finishedAt: params.finishedAt,
    notes: createQaSuiteReportNotes(params),
    scenarios: params.scenarios.map((scenario) => ({
      details: scenario.details,
      name: scenario.name,
      status: scenario.status,
      steps: scenario.steps,
    })) satisfies QaReportScenario[],
    startedAt: params.startedAt,
    title: "OpenClaw QA Scenario Suite",
  });
  const reportPath = path.join(params.outputDir, "qa-suite-report.md");
  const summaryPath = path.join(params.outputDir, "qa-suite-summary.json");
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(
    summaryPath,
    `${JSON.stringify(
      {
        counts: {
          failed: params.scenarios.filter((scenario) => scenario.status === "fail").length,
          passed: params.scenarios.filter((scenario) => scenario.status === "pass").length,
          total: params.scenarios.length,
        },
        scenarios: params.scenarios,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { report, reportPath, summaryPath };
}

export async function runQaSuite(params?: QaSuiteRunParams): Promise<QaSuiteResult> {
  const startedAt = new Date();
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const providerMode = normalizeQaProviderMode(params?.providerMode ?? "mock-openai");
  const primaryModel = params?.primaryModel ?? defaultQaModelForMode(providerMode);
  const alternateModel =
    params?.alternateModel ?? defaultQaModelForMode(providerMode, { alternate: true });
  const fastMode =
    typeof params?.fastMode === "boolean"
      ? params.fastMode
      : isQaFastModeEnabled({ alternateModel, primaryModel });
  const outputDir =
    params?.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `suite-${Date.now().toString(36)}`);
  await fs.mkdir(outputDir, { recursive: true });
  const catalog = readQaBootstrapScenarioCatalog();
  const requestedScenarioIds =
    params?.scenarioIds && params.scenarioIds.length > 0 ? new Set(params.scenarioIds) : null;
  const selectedCatalogScenarios = requestedScenarioIds
    ? catalog.scenarios.filter((scenario) => requestedScenarioIds.has(scenario.id))
    : catalog.scenarios;
  if (requestedScenarioIds) {
    const foundScenarioIds = new Set(selectedCatalogScenarios.map((scenario) => scenario.id));
    const missingScenarioIds = [...requestedScenarioIds].filter(
      (scenarioId) => !foundScenarioIds.has(scenarioId),
    );
    if (missingScenarioIds.length > 0) {
      throw new Error(`unknown QA scenario id(s): ${missingScenarioIds.join(", ")}`);
    }
  }
  const concurrency = normalizeQaSuiteConcurrency(
    params?.concurrency,
    selectedCatalogScenarios.length,
  );

  if (concurrency > 1 && selectedCatalogScenarios.length > 1) {
    const ownsLab = !params?.lab;
    const startLab = params?.startLab ?? startQaLabServerRuntime;
    const lab =
      params?.lab ??
      (await startLab({
        embeddedGateway: "disabled",
        host: "127.0.0.1",
        port: 0,
        repoRoot,
      }));
    const liveScenarioOutcomes: QaLabScenarioOutcome[] = selectedCatalogScenarios.map(
      (scenario) => ({
        id: scenario.id,
        name: scenario.title,
        status: "pending",
      }),
    );
    const updateScenarioRun = () =>
      lab.setScenarioRun({
        kind: "suite",
        scenarios: [...liveScenarioOutcomes],
        startedAt: startedAt.toISOString(),
        status: "running",
      });

    try {
      updateScenarioRun();
      const scenarios: QaSuiteScenarioResult[] = await mapQaSuiteWithConcurrency(
        selectedCatalogScenarios,
        concurrency,
        async (scenario, index): Promise<QaSuiteScenarioResult> => {
          liveScenarioOutcomes[index] = {
            id: scenario.id,
            name: scenario.title,
            startedAt: new Date().toISOString(),
            status: "running",
          };
          updateScenarioRun();
          try {
            const scenarioOutputDir = path.join(outputDir, "scenarios", scenario.id);
            const result: QaSuiteResult = await runQaSuite({
              alternateModel,
              concurrency: 1,
              fastMode,
              outputDir: scenarioOutputDir,
              primaryModel,
              providerMode,
              repoRoot,
              scenarioIds: [scenario.id],
              thinkingDefault: params?.thinkingDefault,
            });
            const scenarioResult: QaSuiteScenarioResult =
              result.scenarios[0] ??
              ({
                details: "isolated scenario run returned no scenario result",
                name: scenario.title,
                status: "fail",
                steps: [
                  {
                    details: "isolated scenario run returned no scenario result",
                    name: "isolated scenario worker",
                    status: "fail",
                  },
                ],
              } satisfies QaSuiteScenarioResult);
            liveScenarioOutcomes[index] = {
              details: scenarioResult.details,
              finishedAt: new Date().toISOString(),
              id: scenario.id,
              name: scenario.title,
              startedAt: liveScenarioOutcomes[index]?.startedAt,
              status: scenarioResult.status,
              steps: scenarioResult.steps,
            };
            updateScenarioRun();
            return scenarioResult;
          } catch (error) {
            const details = formatErrorMessage(error);
            const scenarioResult = {
              details,
              name: scenario.title,
              status: "fail",
              steps: [
                {
                  details,
                  name: "isolated scenario worker",
                  status: "fail",
                },
              ],
            } satisfies QaSuiteScenarioResult;
            liveScenarioOutcomes[index] = {
              details,
              finishedAt: new Date().toISOString(),
              id: scenario.id,
              name: scenario.title,
              startedAt: liveScenarioOutcomes[index]?.startedAt,
              status: "fail",
              steps: scenarioResult.steps,
            };
            updateScenarioRun();
            return scenarioResult;
          }
        },
      );
      const finishedAt = new Date();
      lab.setScenarioRun({
        finishedAt: finishedAt.toISOString(),
        kind: "suite",
        scenarios: [...liveScenarioOutcomes],
        startedAt: startedAt.toISOString(),
        status: "completed",
      });
      const { report, reportPath, summaryPath } = await writeQaSuiteArtifacts({
        alternateModel,
        concurrency,
        fastMode,
        finishedAt,
        outputDir,
        primaryModel,
        providerMode,
        scenarios,
        startedAt,
      });
      lab.setLatestReport({
        generatedAt: finishedAt.toISOString(),
        markdown: report,
        outputPath: reportPath,
      } satisfies QaLabLatestReport);
      return {
        outputDir,
        report,
        reportPath,
        scenarios,
        summaryPath,
        watchUrl: lab.baseUrl,
      } satisfies QaSuiteResult;
    } finally {
      if (ownsLab) {
        await lab.stop();
      }
    }
  }

  const ownsLab = !params?.lab;
  const startLab = params?.startLab ?? startQaLabServerRuntime;
  const lab =
    params?.lab ??
    (await startLab({
      embeddedGateway: "disabled",
      host: "127.0.0.1",
      port: 0,
      repoRoot,
    }));
  const mock =
    providerMode === "mock-openai"
      ? await startQaMockOpenAiServer({
          host: "127.0.0.1",
          port: 0,
        })
      : null;
  const gateway = await startQaGatewayChild({
    alternateModel,
    controlUiAllowedOrigins: [lab.listenUrl],
    controlUiEnabled: true,
    fastMode,
    primaryModel,
    providerBaseUrl: mock ? `${mock.baseUrl}/v1` : undefined,
    providerMode,
    qaBusBaseUrl: lab.listenUrl,
    repoRoot,
    thinkingDefault: params?.thinkingDefault,
  });
  lab.setControlUi({
    controlUiProxyTarget: gateway.baseUrl,
    controlUiToken: gateway.token,
  });
  const env: QaSuiteEnvironment = {
    alternateModel,
    cfg: createQaActionConfig(lab.listenUrl),
    gateway,
    lab,
    mock,
    primaryModel,
    providerMode,
    repoRoot,
  };

  try {
    // The gateway child already waits for /readyz before returning, but qa-channel
    // Can still be finishing its account startup. Pay that readiness cost once here
    // So the first scenario does not race channel bootstrap.
    await waitForQaChannelReady(env, 120_000).catch(async () => {
      await waitForGatewayHealthy(env, 120_000);
      await waitForQaChannelReady(env, 120_000);
    });
    await sleep(1000);
    const scenarios: QaSuiteScenarioResult[] = [];
    const liveScenarioOutcomes: QaLabScenarioOutcome[] = selectedCatalogScenarios.map(
      (scenario) => ({
        id: scenario.id,
        name: scenario.title,
        status: "pending",
      }),
    );

    lab.setScenarioRun({
      kind: "suite",
      scenarios: liveScenarioOutcomes,
      startedAt: startedAt.toISOString(),
      status: "running",
    });

    for (const [index, scenario] of selectedCatalogScenarios.entries()) {
      liveScenarioOutcomes[index] = {
        id: scenario.id,
        name: scenario.title,
        startedAt: new Date().toISOString(),
        status: "running",
      };
      lab.setScenarioRun({
        kind: "suite",
        scenarios: [...liveScenarioOutcomes],
        startedAt: startedAt.toISOString(),
        status: "running",
      });

      const result = await runScenarioDefinition(env, scenario);
      scenarios.push(result);
      liveScenarioOutcomes[index] = {
        details: result.details,
        finishedAt: new Date().toISOString(),
        id: scenario.id,
        name: scenario.title,
        startedAt: liveScenarioOutcomes[index]?.startedAt,
        status: result.status,
        steps: result.steps,
      };
      lab.setScenarioRun({
        kind: "suite",
        scenarios: [...liveScenarioOutcomes],
        startedAt: startedAt.toISOString(),
        status: "running",
      });
    }

    const finishedAt = new Date();
    lab.setScenarioRun({
      finishedAt: finishedAt.toISOString(),
      kind: "suite",
      scenarios: [...liveScenarioOutcomes],
      startedAt: startedAt.toISOString(),
      status: "completed",
    });
    const { report, reportPath, summaryPath } = await writeQaSuiteArtifacts({
      alternateModel,
      concurrency,
      fastMode,
      finishedAt,
      outputDir,
      primaryModel,
      providerMode,
      scenarios,
      startedAt,
    });
    const latestReport = {
      generatedAt: finishedAt.toISOString(),
      markdown: report,
      outputPath: reportPath,
    } satisfies QaLabLatestReport;
    lab.setLatestReport(latestReport);

    return {
      outputDir,
      report,
      reportPath,
      scenarios,
      summaryPath,
      watchUrl: lab.baseUrl,
    } satisfies QaSuiteResult;
  } finally {
    const keepTemp = process.env.OPENCLAW_QA_KEEP_TEMP === "1" || false;
    await gateway.stop({
      keepTemp,
    });
    await mock?.stop();
    if (ownsLab) {
      await lab.stop();
    } else {
      lab.setControlUi({
        controlUiProxyTarget: null,
        controlUiToken: null,
        controlUiUrl: null,
      });
    }
  }
}
