import { codingTools, createReadTool, readTool } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelCompatConfig } from "../config/types.models.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { resolveMergedSafeBinProfileFixtures } from "../infra/exec-safe-bin-runtime-policy.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { resolveGatewayMessageChannel } from "../utils/message-channel.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { createApplyPatchTool } from "./apply-patch.js";
import {
  type ExecToolDefaults,
  type ProcessToolDefaults,
  createExecTool,
  createProcessTool,
  describeExecTool,
  describeProcessTool,
} from "./bash-tools.js";
import { listChannelAgentTools } from "./channel-tools.js";
import { shouldSuppressManagedWebSearchTool } from "./codex-native-web-search.js";
import { resolveImageSanitizationLimits } from "./image-sanitization.js";
import type { ModelAuthMode } from "./model-auth.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";
import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import { filterToolsByMessageProvider } from "./pi-tools.message-provider-policy.js";
import {
  isToolAllowedByPolicies,
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicyForSession,
} from "./pi-tools.policy.js";
import {
  assertRequiredParams,
  createHostWorkspaceEditTool,
  createHostWorkspaceWriteTool,
  createOpenClawReadTool,
  createSandboxedEditTool,
  createSandboxedReadTool,
  createSandboxedWriteTool,
  getToolParamsRecord,
  wrapToolMemoryFlushAppendOnlyWrite,
  wrapToolParamValidation,
  wrapToolWorkspaceRootGuard,
  wrapToolWorkspaceRootGuardWithOptions,
} from "./pi-tools.read.js";
import { cleanToolSchemaForGemini, normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxContext } from "./sandbox.js";
import { createToolFsPolicy, resolveToolFsConfig } from "./tool-fs-policy.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "./tool-policy-pipeline.js";
import {
  applyOwnerOnlyToolPolicy,
  collectExplicitAllowlist,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "./tool-policy.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

function isOpenAIProvider(provider?: string) {
  const normalized = normalizeOptionalLowercaseString(provider);
  return normalized === "openai" || normalized === "openai-codex";
}

const MEMORY_FLUSH_ALLOWED_TOOL_NAMES = new Set(["read", "write"]);

function applyModelProviderToolPolicy(
  tools: AnyAgentTool[],
  params?: {
    config?: OpenClawConfig;
    modelProvider?: string;
    modelApi?: string;
    modelId?: string;
    agentDir?: string;
    modelCompat?: ModelCompatConfig;
  },
): AnyAgentTool[] {
  if (
    shouldSuppressManagedWebSearchTool({
      agentDir: params?.agentDir,
      config: params?.config,
      modelApi: params?.modelApi,
      modelProvider: params?.modelProvider,
    })
  ) {
    return tools.filter((tool) => tool.name !== "web_search");
  }

  return tools;
}

function applyDeferredFollowupToolDescriptions(
  tools: AnyAgentTool[],
  params?: { agentId?: string },
): AnyAgentTool[] {
  const hasCronTool = tools.some((tool) => tool.name === "cron");
  return tools.map((tool) => {
    if (tool.name === "exec") {
      return {
        ...tool,
        description: describeExecTool({ agentId: params?.agentId, hasCronTool }),
      };
    }
    if (tool.name === "process") {
      return {
        ...tool,
        description: describeProcessTool({ hasCronTool }),
      };
    }
    return tool;
  });
}

function isApplyPatchAllowedForModel(params: {
  modelProvider?: string;
  modelId?: string;
  allowModels?: string[];
}) {
  const allowModels = Array.isArray(params.allowModels) ? params.allowModels : [];
  if (allowModels.length === 0) {
    return true;
  }
  const modelId = params.modelId?.trim();
  if (!modelId) {
    return false;
  }
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  const provider = normalizeOptionalLowercaseString(params.modelProvider);
  const normalizedFull =
    provider && !normalizedModelId.includes("/")
      ? `${provider}/${normalizedModelId}`
      : normalizedModelId;
  return allowModels.some((entry) => {
    const normalized = normalizeOptionalLowercaseString(entry);
    if (!normalized) {
      return false;
    }
    return normalized === normalizedModelId || normalized === normalizedFull;
  });
}

function resolveExecConfig(params: { cfg?: OpenClawConfig; agentId?: string }) {
  const {cfg} = params;
  const globalExec = cfg?.tools?.exec;
  const agentExec =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.exec : undefined;
  return {
    applyPatch: agentExec?.applyPatch ?? globalExec?.applyPatch,
    approvalRunningNoticeMs:
      agentExec?.approvalRunningNoticeMs ?? globalExec?.approvalRunningNoticeMs,
    ask: agentExec?.ask ?? globalExec?.ask,
    backgroundMs: agentExec?.backgroundMs ?? globalExec?.backgroundMs,
    cleanupMs: agentExec?.cleanupMs ?? globalExec?.cleanupMs,
    host: agentExec?.host ?? globalExec?.host,
    node: agentExec?.node ?? globalExec?.node,
    notifyOnExit: agentExec?.notifyOnExit ?? globalExec?.notifyOnExit,
    notifyOnExitEmptySuccess:
      agentExec?.notifyOnExitEmptySuccess ?? globalExec?.notifyOnExitEmptySuccess,
    pathPrepend: agentExec?.pathPrepend ?? globalExec?.pathPrepend,
    safeBinProfiles: resolveMergedSafeBinProfileFixtures({
      global: globalExec,
      local: agentExec,
    }),
    safeBinTrustedDirs: agentExec?.safeBinTrustedDirs ?? globalExec?.safeBinTrustedDirs,
    safeBins: agentExec?.safeBins ?? globalExec?.safeBins,
    security: agentExec?.security ?? globalExec?.security,
    strictInlineEval: agentExec?.strictInlineEval ?? globalExec?.strictInlineEval,
    timeoutSec: agentExec?.timeoutSec ?? globalExec?.timeoutSec,
  };
}

export function resolveToolLoopDetectionConfig(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): ToolLoopDetectionConfig | undefined {
  const global = params.cfg?.tools?.loopDetection;
  const agent =
    params.agentId && params.cfg
      ? resolveAgentConfig(params.cfg, params.agentId)?.tools?.loopDetection
      : undefined;

  if (!agent) {
    return global;
  }
  if (!global) {
    return agent;
  }

  return {
    ...global,
    ...agent,
    detectors: {
      ...global.detectors,
      ...agent.detectors,
    },
  };
}

export const __testing = {
  applyModelProviderToolPolicy,
  assertRequiredParams,
  cleanToolSchemaForGemini,
  getToolParamsRecord,
  wrapToolParamValidation,
} as const;

export function createOpenClawCodingTools(options?: {
  agentId?: string;
  exec?: ExecToolDefaults & ProcessToolDefaults;
  messageProvider?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  sandbox?: SandboxContext | null;
  sessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  /** Stable run identifier for this agent invocation. */
  runId?: string;
  /** What initiated this run (for trigger-specific tool restrictions). */
  trigger?: string;
  /** Relative workspace path that memory-triggered writes may append to. */
  memoryFlushWritePath?: string;
  agentDir?: string;
  workspaceDir?: string;
  /**
   * Workspace directory that spawned subagents should inherit.
   * When sandboxing uses a copied workspace (`ro` or `none`), workspaceDir is the
   * sandbox copy but subagents should inherit the real agent workspace instead.
   * Defaults to workspaceDir when not set.
   */
  spawnWorkspaceDir?: string;
  config?: OpenClawConfig;
  abortSignal?: AbortSignal;
  /**
   * Provider of the currently selected model (used for provider-specific tool quirks).
   * Example: "anthropic", "openai", "google", "openai-codex".
   */
  modelProvider?: string;
  /** Model id for the current provider (used for model-specific tool gating). */
  modelId?: string;
  /** Model API for the current provider (used for provider-native tool arbitration). */
  modelApi?: string;
  /** Model context window in tokens (used to scale read-tool output budget). */
  modelContextWindowTokens?: number;
  /** Resolved runtime model compatibility hints. */
  modelCompat?: ModelCompatConfig;
  /**
   * Auth mode for the current provider. We only need this for Anthropic OAuth
   * tool-name blocking quirks.
   */
  modelAuthMode?: ModelAuthMode;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Current inbound message id for action fallbacks (e.g. Telegram react). */
  currentMessageId?: string | number;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Parent session key for subagent group policy inheritance. */
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** Allow plugin tools for this run to late-bind the gateway subagent. */
  allowGatewaySubagentBinding?: boolean;
  /** If true, the model has native vision capability */
  modelHasVision?: boolean;
  /** Require explicit message targets (no implicit last-route sends). */
  requireExplicitMessageTarget?: boolean;
  /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean;
  /** Whether the sender is an owner (required for owner-only tools). */
  senderIsOwner?: boolean;
  /** Callback invoked when sessions_yield tool is called. */
  onYield?: (message: string) => Promise<void> | void;
}): AnyAgentTool[] {
  const execToolName = "exec";
  const sandbox = options?.sandbox?.enabled ? options.sandbox : undefined;
  const isMemoryFlushRun = options?.trigger === "memory";
  if (isMemoryFlushRun && !options?.memoryFlushWritePath) {
    throw new Error("memoryFlushWritePath required for memory-triggered tool runs");
  }
  const memoryFlushWritePath = isMemoryFlushRun ? options.memoryFlushWritePath : undefined;
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({
    agentId: options?.agentId,
    config: options?.config,
    modelId: options?.modelId,
    modelProvider: options?.modelProvider,
    sessionKey: options?.sessionKey,
  });
  // Prefer the already-resolved sandbox context policy. Recomputing from
  // SessionKey/config can lose the real sandbox agent when callers pass a
  // Legacy alias like `main` instead of an agent session key.
  const sandboxToolPolicy = sandbox?.tools;
  const groupPolicy = resolveGroupToolPolicy({
    accountId: options?.agentAccountId,
    config: options?.config,
    groupChannel: options?.groupChannel,
    groupId: options?.groupId,
    groupSpace: options?.groupSpace,
    messageProvider: options?.messageProvider,
    senderE164: options?.senderE164,
    senderId: options?.senderId,
    senderName: options?.senderName,
    senderUsername: options?.senderUsername,
    sessionKey: options?.sessionKey,
    spawnedBy: options?.spawnedBy,
  });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);

  const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  // Prefer sessionKey for process isolation scope to prevent cross-session process visibility/killing.
  // Fallback to agentId if no sessionKey is available (e.g. legacy or global contexts).
  const scopeKey =
    options?.exec?.scopeKey ?? options?.sessionKey ?? (agentId ? `agent:${agentId}` : undefined);
  const subagentPolicy =
    isSubagentSessionKey(options?.sessionKey) && options?.sessionKey
      ? resolveSubagentToolPolicyForSession(options.config, options.sessionKey)
      : undefined;
  const allowBackground = isToolAllowedByPolicies("process", [
    profilePolicyWithAlsoAllow,
    providerProfilePolicyWithAlsoAllow,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    sandboxToolPolicy,
    subagentPolicy,
  ]);
  const execConfig = resolveExecConfig({ agentId, cfg: options?.config });
  const fsConfig = resolveToolFsConfig({ agentId, cfg: options?.config });
  const fsPolicy = createToolFsPolicy({
    workspaceOnly: isMemoryFlushRun || fsConfig.workspaceOnly,
  });
  const sandboxRoot = sandbox?.workspaceDir;
  const sandboxFsBridge = sandbox?.fsBridge;
  const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";
  const workspaceRoot = resolveWorkspaceRoot(options?.workspaceDir);
  const {workspaceOnly} = fsPolicy;
  const applyPatchConfig = execConfig.applyPatch;
  // Secure by default: apply_patch is workspace-contained unless explicitly disabled.
  // (tools.fs.workspaceOnly is a separate umbrella flag for read/write/edit/apply_patch.)
  const applyPatchWorkspaceOnly = workspaceOnly || applyPatchConfig?.workspaceOnly !== false;
  const applyPatchEnabled =
    applyPatchConfig?.enabled !== false &&
    isOpenAIProvider(options?.modelProvider) &&
    isApplyPatchAllowedForModel({
      allowModels: applyPatchConfig?.allowModels,
      modelId: options?.modelId,
      modelProvider: options?.modelProvider,
    });

  if (sandboxRoot && !sandboxFsBridge) {
    throw new Error("Sandbox filesystem bridge is unavailable.");
  }
  const imageSanitization = resolveImageSanitizationLimits(options?.config);

  const base = (codingTools as unknown as AnyAgentTool[]).flatMap((tool) => {
    if (tool.name === readTool.name) {
      if (sandboxRoot) {
        const sandboxed = createSandboxedReadTool({
          bridge: sandboxFsBridge!,
          imageSanitization,
          modelContextWindowTokens: options?.modelContextWindowTokens,
          root: sandboxRoot,
        });
        return [
          workspaceOnly
            ? wrapToolWorkspaceRootGuardWithOptions(sandboxed, sandboxRoot, {
                containerWorkdir: sandbox.containerWorkdir,
              })
            : sandboxed,
        ];
      }
      const freshReadTool = createReadTool(workspaceRoot);
      const wrapped = createOpenClawReadTool(freshReadTool, {
        imageSanitization,
        modelContextWindowTokens: options?.modelContextWindowTokens,
      });
      return [workspaceOnly ? wrapToolWorkspaceRootGuard(wrapped, workspaceRoot) : wrapped];
    }
    if (tool.name === "bash" || tool.name === execToolName) {
      return [];
    }
    if (tool.name === "write") {
      if (sandboxRoot) {
        return [];
      }
      const wrapped = createHostWorkspaceWriteTool(workspaceRoot, { workspaceOnly });
      return [workspaceOnly ? wrapToolWorkspaceRootGuard(wrapped, workspaceRoot) : wrapped];
    }
    if (tool.name === "edit") {
      if (sandboxRoot) {
        return [];
      }
      const wrapped = createHostWorkspaceEditTool(workspaceRoot, { workspaceOnly });
      return [workspaceOnly ? wrapToolWorkspaceRootGuard(wrapped, workspaceRoot) : wrapped];
    }
    return [tool];
  });
  const { cleanupMs: cleanupMsOverride, ...execDefaults } = options?.exec ?? {};
  const execTool = createExecTool({
    ...execDefaults,
    accountId: options?.agentAccountId,
    agentId,
    allowBackground,
    approvalRunningNoticeMs:
      options?.exec?.approvalRunningNoticeMs ?? execConfig.approvalRunningNoticeMs,
    ask: options?.exec?.ask ?? execConfig.ask,
    backgroundMs: options?.exec?.backgroundMs ?? execConfig.backgroundMs,
    currentChannelId: options?.currentChannelId,
    currentThreadTs: options?.currentThreadTs,
    cwd: workspaceRoot,
    host: options?.exec?.host ?? execConfig.host,
    messageProvider: options?.messageProvider,
    node: options?.exec?.node ?? execConfig.node,
    notifyOnExit: options?.exec?.notifyOnExit ?? execConfig.notifyOnExit,
    notifyOnExitEmptySuccess:
      options?.exec?.notifyOnExitEmptySuccess ?? execConfig.notifyOnExitEmptySuccess,
    pathPrepend: options?.exec?.pathPrepend ?? execConfig.pathPrepend,
    safeBinProfiles: options?.exec?.safeBinProfiles ?? execConfig.safeBinProfiles,
    safeBinTrustedDirs: options?.exec?.safeBinTrustedDirs ?? execConfig.safeBinTrustedDirs,
    safeBins: options?.exec?.safeBins ?? execConfig.safeBins,
    sandbox: sandbox
      ? {
          buildExecSpec: sandbox.backend?.buildExecSpec.bind(sandbox.backend),
          containerName: sandbox.containerName,
          containerWorkdir: sandbox.containerWorkdir,
          env: sandbox.backend?.env ?? sandbox.docker.env,
          finalizeExec: sandbox.backend?.finalizeExec?.bind(sandbox.backend),
          workspaceDir: sandbox.workspaceDir,
        }
      : undefined,
    scopeKey,
    security: options?.exec?.security ?? execConfig.security,
    sessionKey: options?.sessionKey,
    strictInlineEval: options?.exec?.strictInlineEval ?? execConfig.strictInlineEval,
    timeoutSec: options?.exec?.timeoutSec ?? execConfig.timeoutSec,
    trigger: options?.trigger,
  });
  const processTool = createProcessTool({
    cleanupMs: cleanupMsOverride ?? execConfig.cleanupMs,
    scopeKey,
  });
  const applyPatchTool =
    !applyPatchEnabled || (sandboxRoot && !allowWorkspaceWrites)
      ? null
      : createApplyPatchTool({
          cwd: sandboxRoot ?? workspaceRoot,
          sandbox:
            sandboxRoot && allowWorkspaceWrites
              ? { bridge: sandboxFsBridge!, root: sandboxRoot }
              : undefined,
          workspaceOnly: applyPatchWorkspaceOnly,
        });
  const tools: AnyAgentTool[] = [
    ...base,
    ...(sandboxRoot
      ? (allowWorkspaceWrites
        ? [
            workspaceOnly
              ? wrapToolWorkspaceRootGuardWithOptions(
                  createSandboxedEditTool({ bridge: sandboxFsBridge!, root: sandboxRoot }),
                  sandboxRoot,
                  {
                    containerWorkdir: sandbox.containerWorkdir,
                  },
                )
              : createSandboxedEditTool({ bridge: sandboxFsBridge!, root: sandboxRoot }),
            workspaceOnly
              ? wrapToolWorkspaceRootGuardWithOptions(
                  createSandboxedWriteTool({ bridge: sandboxFsBridge!, root: sandboxRoot }),
                  sandboxRoot,
                  {
                    containerWorkdir: sandbox.containerWorkdir,
                  },
                )
              : createSandboxedWriteTool({ bridge: sandboxFsBridge!, root: sandboxRoot }),
          ]
        : [])
      : []),
    ...(applyPatchTool ? [applyPatchTool as unknown as AnyAgentTool] : []),
    execTool as unknown as AnyAgentTool,
    processTool as unknown as AnyAgentTool,
    // Channel docking: include channel-defined agent tools (login, etc.).
    ...listChannelAgentTools({ cfg: options?.config }),
    ...createOpenClawTools({
      agentAccountId: options?.agentAccountId,
      agentChannel: resolveGatewayMessageChannel(options?.messageProvider),
      agentDir: options?.agentDir,
      agentGroupChannel: options?.groupChannel ?? null,
      agentGroupId: options?.groupId ?? null,
      agentGroupSpace: options?.groupSpace ?? null,
      agentSessionKey: options?.sessionKey,
      agentThreadId: options?.messageThreadId,
      agentTo: options?.messageTo,
      allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding,
      allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true,
      config: options?.config,
      currentChannelId: options?.currentChannelId,
      currentMessageId: options?.currentMessageId,
      currentThreadTs: options?.currentThreadTs,
      disableMessageTool: options?.disableMessageTool,
      fsPolicy,
      hasRepliedRef: options?.hasRepliedRef,
      modelHasVision: options?.modelHasVision,
      modelProvider: options?.modelProvider,
      onYield: options?.onYield,
      pluginToolAllowlist: collectExplicitAllowlist([
        profilePolicy,
        providerProfilePolicy,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        sandboxToolPolicy,
        subagentPolicy,
      ]),
      replyToMode: options?.replyToMode,
      requesterAgentIdOverride: agentId,
      requesterSenderId: options?.senderId,
      requireExplicitMessageTarget: options?.requireExplicitMessageTarget,
      sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl,
      sandboxContainerWorkdir: sandbox?.containerWorkdir,
      sandboxFsBridge,
      sandboxRoot,
      sandboxed: Boolean(sandbox),
      senderIsOwner: options?.senderIsOwner,
      sessionId: options?.sessionId,
      spawnWorkspaceDir: options?.spawnWorkspaceDir
        ? resolveWorkspaceRoot(options.spawnWorkspaceDir)
        : undefined,
      workspaceDir: workspaceRoot,
    }),
  ];
  const toolsForMemoryFlush =
    isMemoryFlushRun && memoryFlushWritePath
      ? tools.flatMap((tool) => {
          if (!MEMORY_FLUSH_ALLOWED_TOOL_NAMES.has(tool.name)) {
            return [];
          }
          if (tool.name === "write") {
            return [
              wrapToolMemoryFlushAppendOnlyWrite(tool, {
                containerWorkdir: sandbox?.containerWorkdir,
                relativePath: memoryFlushWritePath,
                root: sandboxRoot ?? workspaceRoot,
                sandbox:
                  sandboxRoot && sandboxFsBridge
                    ? { bridge: sandboxFsBridge, root: sandboxRoot }
                    : undefined,
              }),
            ];
          }
          return [tool];
        })
      : tools;
  const toolsForMessageProvider = filterToolsByMessageProvider(
    toolsForMemoryFlush,
    options?.messageProvider,
  );
  const toolsForModelProvider = applyModelProviderToolPolicy(toolsForMessageProvider, {
    agentDir: options?.agentDir,
    config: options?.config,
    modelApi: options?.modelApi,
    modelCompat: options?.modelCompat,
    modelId: options?.modelId,
    modelProvider: options?.modelProvider,
  });
  // Security: treat unknown/undefined as unauthorized (opt-in, not opt-out)
  const senderIsOwner = options?.senderIsOwner === true;
  const toolsByAuthorization = applyOwnerOnlyToolPolicy(toolsForModelProvider, senderIsOwner);
  const subagentFiltered = applyToolPolicyPipeline({
    steps: [
      ...buildDefaultToolPolicyPipelineSteps({
        agentId,
        agentPolicy,
        agentProviderPolicy,
        globalPolicy,
        globalProviderPolicy,
        groupPolicy,
        profile,
        profilePolicy: profilePolicyWithAlsoAllow,
        profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
        providerProfile,
        providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
        providerProfileUnavailableCoreWarningAllowlist: providerProfilePolicy?.allow,
      }),
      { label: "sandbox tools.allow", policy: sandboxToolPolicy },
      { label: "subagent tools.allow", policy: subagentPolicy },
    ],
    toolMeta: (tool) => getPluginToolMeta(tool),
    tools: toolsByAuthorization,
    warn: logWarn,
  });
  // Always normalize tool JSON Schemas before handing them to pi-agent/pi-ai.
  // Without this, some providers (notably OpenAI) will reject root-level union schemas.
  // Provider-specific cleaning: Gemini needs constraint keywords stripped, but Anthropic expects them.
  const normalized = subagentFiltered.map((tool) =>
    normalizeToolParameters(tool, {
      modelCompat: options?.modelCompat,
      modelId: options?.modelId,
      modelProvider: options?.modelProvider,
    }),
  );
  const withHooks = normalized.map((tool) =>
    wrapToolWithBeforeToolCallHook(tool, {
      agentId,
      loopDetection: resolveToolLoopDetectionConfig({ agentId, cfg: options?.config }),
      runId: options?.runId,
      sessionId: options?.sessionId,
      sessionKey: options?.sessionKey,
    }),
  );
  const withAbort = options?.abortSignal
    ? withHooks.map((tool) => wrapToolWithAbortSignal(tool, options.abortSignal))
    : withHooks;
  const withDeferredFollowupDescriptions = applyDeferredFollowupToolDescriptions(withAbort, {
    agentId,
  });

  // NOTE: Keep canonical (lowercase) tool names here.
  // Pi-ai's Anthropic OAuth transport remaps tool names to Claude Code-style names
  // On the wire and maps them back for tool dispatch.
  return withDeferredFollowupDescriptions;
}
