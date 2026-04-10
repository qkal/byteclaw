import type { OpenClawConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import {
  collectPresentOpenClawTools,
  isUpdatePlanToolEnabledForOpenClawTools,
} from "./openclaw-tools.registration.js";
import { wrapToolWorkspaceRootGuardWithOptions } from "./pi-tools.read.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageGenerateTool } from "./tools/image-generate-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createMusicGenerateTool } from "./tools/music-generate-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createPdfTool } from "./tools/pdf-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { createUpdatePlanTool } from "./tools/update-plan-tool.js";
import { createVideoGenerateTool } from "./tools/video-generate-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

interface OpenClawToolsDeps {
  callGateway: typeof callGateway;
  config?: OpenClawConfig;
}

const defaultOpenClawToolsDeps: OpenClawToolsDeps = {
  callGateway,
};

let openClawToolsDeps: OpenClawToolsDeps = defaultOpenClawToolsDeps;

export function createOpenClawTools(
  options?: {
    sandboxBrowserBridgeUrl?: string;
    allowHostBrowserControl?: boolean;
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    /** Delivery target (e.g. telegram:group:123:topic:456) for topic/thread routing. */
    agentTo?: string;
    /** Thread/topic identifier for routing replies to the originating thread. */
    agentThreadId?: string | number;
    agentDir?: string;
    sandboxRoot?: string;
    sandboxContainerWorkdir?: string;
    sandboxFsBridge?: SandboxFsBridge;
    fsPolicy?: ToolFsPolicy;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    pluginToolAllowlist?: string[];
    /** Current channel ID for auto-threading (Slack). */
    currentChannelId?: string;
    /** Current thread timestamp for auto-threading (Slack). */
    currentThreadTs?: string;
    /** Current inbound message id for action fallbacks (e.g. Telegram react). */
    currentMessageId?: string | number;
    /** Reply-to mode for Slack auto-threading. */
    replyToMode?: "off" | "first" | "all" | "batched";
    /** Mutable ref to track if a reply was sent (for "first" mode). */
    hasRepliedRef?: { value: boolean };
    /** If true, the model has native vision capability */
    modelHasVision?: boolean;
    /** Active model provider for provider-specific tool gating. */
    modelProvider?: string;
    /** If true, nodes action="invoke" can call media-returning commands directly. */
    allowMediaInvokeCommands?: boolean;
    /** Explicit agent ID override for cron/hook sessions. */
    requesterAgentIdOverride?: string;
    /** Require explicit message targets (no implicit last-route sends). */
    requireExplicitMessageTarget?: boolean;
    /** If true, omit the message tool from the tool list. */
    disableMessageTool?: boolean;
    /** If true, skip plugin tool resolution and return only shipped core tools. */
    disablePluginTools?: boolean;
    /** Trusted sender id from inbound context (not tool args). */
    requesterSenderId?: string | null;
    /** Whether the requesting sender is an owner. */
    senderIsOwner?: boolean;
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    /**
     * Workspace directory to pass to spawned subagents for inheritance.
     * Defaults to workspaceDir. Use this to pass the actual agent workspace when the
     * session itself is running in a copied-workspace sandbox (`ro` or `none`) so
     * subagents inherit the real workspace path instead of the sandbox copy.
     */
    spawnWorkspaceDir?: string;
    /** Callback invoked when sessions_yield tool is called. */
    onYield?: (message: string) => Promise<void> | void;
    /** Allow plugin tools for this tool set to late-bind the gateway subagent. */
    allowGatewaySubagentBinding?: boolean;
  } & SpawnedToolContext,
): AnyAgentTool[] {
  const resolvedConfig = options?.config ?? openClawToolsDeps.config;
  const sessionAgentId = resolveSessionAgentId({
    config: resolvedConfig,
    sessionKey: options?.agentSessionKey,
  });
  // Fall back to the session agent workspace so plugin loading stays workspace-stable
  // Even when a caller forgets to thread workspaceDir explicitly.
  const inferredWorkspaceDir =
    options?.workspaceDir || !resolvedConfig
      ? undefined
      : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
  const spawnWorkspaceDir = resolveWorkspaceRoot(
    options?.spawnWorkspaceDir ?? options?.workspaceDir ?? inferredWorkspaceDir,
  );
  const deliveryContext = normalizeDeliveryContext({
    accountId: options?.agentAccountId,
    channel: options?.agentChannel,
    threadId: options?.agentThreadId,
    to: options?.agentTo,
  });
  const runtimeWebTools = getActiveRuntimeWebToolsMetadata();
  const sandbox =
    options?.sandboxRoot && options?.sandboxFsBridge
      ? { bridge: options.sandboxFsBridge, root: options.sandboxRoot }
      : undefined;
  const imageTool = options?.agentDir?.trim()
    ? createImageTool({
        agentDir: options.agentDir,
        config: options?.config,
        fsPolicy: options?.fsPolicy,
        modelHasVision: options?.modelHasVision,
        sandbox,
        workspaceDir,
      })
    : null;
  const imageGenerateTool = createImageGenerateTool({
    agentDir: options?.agentDir,
    config: options?.config,
    fsPolicy: options?.fsPolicy,
    sandbox,
    workspaceDir,
  });
  const videoGenerateTool = createVideoGenerateTool({
    agentDir: options?.agentDir,
    agentSessionKey: options?.agentSessionKey,
    config: options?.config,
    fsPolicy: options?.fsPolicy,
    requesterOrigin: deliveryContext ?? undefined,
    sandbox,
    workspaceDir,
  });
  const musicGenerateTool = createMusicGenerateTool({
    agentDir: options?.agentDir,
    agentSessionKey: options?.agentSessionKey,
    config: options?.config,
    fsPolicy: options?.fsPolicy,
    requesterOrigin: deliveryContext ?? undefined,
    sandbox,
    workspaceDir,
  });
  const pdfTool = options?.agentDir?.trim()
    ? createPdfTool({
        agentDir: options.agentDir,
        config: options?.config,
        fsPolicy: options?.fsPolicy,
        sandbox,
        workspaceDir,
      })
    : null;
  const webSearchTool = createWebSearchTool({
    config: options?.config,
    runtimeWebSearch: runtimeWebTools?.search,
    sandboxed: options?.sandboxed,
  });
  const webFetchTool = createWebFetchTool({
    config: options?.config,
    runtimeWebFetch: runtimeWebTools?.fetch,
    sandboxed: options?.sandboxed,
  });
  const messageTool = options?.disableMessageTool
    ? null
    : createMessageTool({
        agentAccountId: options?.agentAccountId,
        agentSessionKey: options?.agentSessionKey,
        config: options?.config,
        currentChannelId: options?.currentChannelId,
        currentChannelProvider: options?.agentChannel,
        currentMessageId: options?.currentMessageId,
        currentThreadTs: options?.currentThreadTs,
        hasRepliedRef: options?.hasRepliedRef,
        replyToMode: options?.replyToMode,
        requesterSenderId: options?.requesterSenderId ?? undefined,
        requireExplicitTarget: options?.requireExplicitMessageTarget,
        sandboxRoot: options?.sandboxRoot,
        sessionId: options?.sessionId,
      });
  const nodesToolBase = createNodesTool({
    agentAccountId: options?.agentAccountId,
    agentChannel: options?.agentChannel,
    agentSessionKey: options?.agentSessionKey,
    allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
    config: options?.config,
    currentChannelId: options?.currentChannelId,
    currentThreadTs: options?.currentThreadTs,
    modelHasVision: options?.modelHasVision,
  });
  const nodesTool =
    options?.fsPolicy?.workspaceOnly === true
      ? wrapToolWorkspaceRootGuardWithOptions(nodesToolBase, options?.sandboxRoot ?? workspaceDir, {
          containerWorkdir: options?.sandboxContainerWorkdir,
          normalizeGuardedPathParams: true,
          pathParamKeys: ["outPath"],
        })
      : nodesToolBase;
  const tools: AnyAgentTool[] = [
    createCanvasTool({ config: options?.config }),
    nodesTool,
    createCronTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    ...(messageTool ? [messageTool] : []),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: options?.config,
    }),
    ...collectPresentOpenClawTools([imageGenerateTool, musicGenerateTool, videoGenerateTool]),
    createGatewayTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    ...(isUpdatePlanToolEnabledForOpenClawTools(resolvedConfig, options?.modelProvider)
      ? [createUpdatePlanTool()]
      : []),
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      callGateway: openClawToolsDeps.callGateway,
      config: resolvedConfig,
      sandboxed: options?.sandboxed,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      callGateway: openClawToolsDeps.callGateway,
      config: resolvedConfig,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSendTool({
      agentChannel: options?.agentChannel,
      agentSessionKey: options?.agentSessionKey,
      callGateway: openClawToolsDeps.callGateway,
      config: resolvedConfig,
      sandboxed: options?.sandboxed,
    }),
    createSessionsYieldTool({
      onYield: options?.onYield,
      sessionId: options?.sessionId,
    }),
    createSessionsSpawnTool({
      agentAccountId: options?.agentAccountId,
      agentChannel: options?.agentChannel,
      agentGroupChannel: options?.agentGroupChannel,
      agentGroupId: options?.agentGroupId,
      agentGroupSpace: options?.agentGroupSpace,
      agentSessionKey: options?.agentSessionKey,
      agentThreadId: options?.agentThreadId,
      agentTo: options?.agentTo,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
      sandboxed: options?.sandboxed,
      workspaceDir: spawnWorkspaceDir,
    }),
    createSubagentsTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: resolvedConfig,
      sandboxed: options?.sandboxed,
    }),
    ...collectPresentOpenClawTools([webSearchTool, webFetchTool, imageTool, pdfTool]),
  ];

  if (options?.disablePluginTools) {
    return tools;
  }

  const wrappedPluginTools = resolveOpenClawPluginToolsForOptions({
    existingToolNames: new Set(tools.map((tool) => tool.name)),
    options,
    resolvedConfig,
  });

  return [...tools, ...wrappedPluginTools];
}

export const __testing = {
  setDepsForTest(overrides?: Partial<OpenClawToolsDeps>) {
    openClawToolsDeps = overrides
      ? {
          ...defaultOpenClawToolsDeps,
          ...overrides,
        }
      : defaultOpenClawToolsDeps;
  },
};
