import { format } from "node:util";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  type RuntimeEnv,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../../runtime-api.js";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig, ReplyToMode } from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";
import { resolveConfiguredMatrixBotUserIds } from "../accounts.js";
import { setActiveMatrixClient } from "../active-client.js";
import {
  backfillMatrixAuthDeviceIdAfterStartup,
  isBunRuntime,
  resolveMatrixAuth,
  resolveMatrixAuthContext,
  resolveSharedMatrixClient,
} from "../client.js";
import { releaseSharedClientInstance } from "../client/shared.js";
import type { MatrixClient } from "../sdk.js";
import { isMatrixStartupAbortError } from "../startup-abort.js";
import { createMatrixThreadBindingManager } from "../thread-bindings.js";
import { registerMatrixAutoJoin } from "./auto-join.js";
import { resolveMatrixMonitorConfig } from "./config.js";
import { createDirectRoomTracker } from "./direct.js";
import { registerMatrixMonitorEvents } from "./events.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import {
  type MatrixInboundEventDeduper,
  createMatrixInboundEventDeduper,
} from "./inbound-dedupe.js";
import { shouldPromoteRecentInviteRoom } from "./recent-invite.js";
import { createMatrixRoomInfoResolver } from "./room-info.js";
import { runMatrixStartupMaintenance } from "./startup.js";
import { createMatrixMonitorStatusController } from "./status.js";
import { createMatrixMonitorSyncLifecycle } from "./sync-lifecycle.js";
import { createMatrixMonitorTaskRunner } from "./task-runner.js";

export interface MonitorMatrixOpts {
  runtime?: RuntimeEnv;
  channelRuntime?: import("openclaw/plugin-sdk/channel-core").PluginRuntime["channel"];
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  initialSyncLimit?: number;
  replyToMode?: ReplyToMode;
  accountId?: string | null;
  setStatus?: (next: import("openclaw/plugin-sdk/channel-contract").ChannelAccountSnapshot) => void;
}

const DEFAULT_MEDIA_MAX_MB = 20;

export async function monitorMatrixProvider(opts: MonitorMatrixOpts = {}): Promise<void> {
  // Fast-cancel callers should not pay the full Matrix startup/import cost.
  if (opts.abortSignal?.aborted) {
    return;
  }
  if (isBunRuntime()) {
    throw new Error("Matrix provider requires Node (bun runtime not supported)");
  }
  const core = getMatrixRuntime();
  let cfg = core.config.loadConfig() as CoreConfig;
  if (cfg.channels?.["matrix"]?.enabled === false) {
    return;
  }

  const logger = core.logging.getChildLogger({ module: "matrix-auto-reply" });
  const formatRuntimeMessage = (...args: Parameters<RuntimeEnv["log"]>) => format(...args);
  const runtime: RuntimeEnv = opts.runtime ?? {
    error: (...args) => {
      logger.error(formatRuntimeMessage(...args));
    },
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
    log: (...args) => {
      logger.info(formatRuntimeMessage(...args));
    },
  };
  const logVerboseMessage = (message: string) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    logger.debug?.(message);
  };

  const authContext = resolveMatrixAuthContext({
    accountId: opts.accountId,
    cfg,
  });
  const effectiveAccountId = authContext.accountId;

  // Resolve account-specific config for multi-account support
  const accountConfig = resolveMatrixAccountConfig({
    accountId: effectiveAccountId,
    cfg,
  });

  const allowlistOnly = accountConfig.allowlistOnly === true;
  const accountAllowBots = accountConfig.allowBots;
  let allowFrom: string[] = (accountConfig.dm?.allowFrom ?? []).map(String);
  let groupAllowFrom: string[] = (accountConfig.groupAllowFrom ?? []).map(String);
  let roomsConfig = accountConfig.groups ?? accountConfig.rooms;
  let needsRoomAliasesForConfig = false;
  const configuredBotUserIds = resolveConfiguredMatrixBotUserIds({
    accountId: effectiveAccountId,
    cfg,
  });

  ({ allowFrom, groupAllowFrom, roomsConfig } = await resolveMatrixMonitorConfig({
    accountId: effectiveAccountId,
    allowFrom,
    cfg,
    groupAllowFrom,
    roomsConfig,
    runtime,
  }));
  needsRoomAliasesForConfig = Boolean(
    roomsConfig && Object.keys(roomsConfig).some((key) => key.trim().startsWith("#")),
  );

  cfg = {
    ...cfg,
    channels: {
      ...cfg.channels,
      matrix: {
        ...cfg.channels?.["matrix"],
        dm: {
          ...cfg.channels?.["matrix"]?.dm,
          allowFrom,
        },
        groupAllowFrom,
        ...(roomsConfig ? { groups: roomsConfig } : {}),
      },
    },
  };

  const auth = await resolveMatrixAuth({ accountId: effectiveAccountId, cfg });
  const resolvedInitialSyncLimit =
    typeof opts.initialSyncLimit === "number"
      ? Math.max(0, Math.floor(opts.initialSyncLimit))
      : auth.initialSyncLimit;
  const authWithLimit =
    resolvedInitialSyncLimit === auth.initialSyncLimit
      ? auth
      : { ...auth, initialSyncLimit: resolvedInitialSyncLimit };
  const statusController = createMatrixMonitorStatusController({
    accountId: auth.accountId,
    baseUrl: auth.homeserver,
    statusSink: opts.setStatus,
  });
  let cleanedUp = false;
  let client: MatrixClient | null = null;
  let threadBindingManager: { accountId: string; stop: () => void } | null = null;
  let inboundDeduper: MatrixInboundEventDeduper | null = null;
  const monitorTaskRunner = createMatrixMonitorTaskRunner({
    logVerboseMessage,
    logger,
  });
  let syncLifecycle: ReturnType<typeof createMatrixMonitorSyncLifecycle> | null = null;
  const cleanup = async (mode: "persist" | "stop" = "persist") => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    try {
      client?.stopSyncWithoutPersist();
      if (client && mode === "persist") {
        await client.drainPendingDecryptions("matrix monitor shutdown");
      }
      if (mode === "persist") {
        await monitorTaskRunner.waitForIdle();
      }
      threadBindingManager?.stop();
      await inboundDeduper?.stop();
      if (client) {
        await releaseSharedClientInstance(client, mode);
      }
    } finally {
      syncLifecycle?.dispose();
      statusController.markStopped();
      setActiveMatrixClient(null, auth.accountId);
    }
  };

  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy: groupPolicyRaw, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      defaultGroupPolicy,
      groupPolicy: accountConfig.groupPolicy,
      providerConfigPresent: cfg.channels?.["matrix"] !== undefined,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    accountId: effectiveAccountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (message) => logVerboseMessage(message),
    providerKey: "matrix",
    providerMissingFallbackApplied,
  });
  const groupPolicy = allowlistOnly && groupPolicyRaw === "open" ? "allowlist" : groupPolicyRaw;
  const replyToMode = opts.replyToMode ?? accountConfig.replyToMode ?? "off";
  const threadReplies = accountConfig.threadReplies ?? "inbound";
  const dmThreadReplies = accountConfig.dm?.threadReplies;
  const threadBindingIdleTimeoutMs = resolveThreadBindingIdleTimeoutMsForChannel({
    accountId: effectiveAccountId,
    cfg,
    channel: "matrix",
  });
  const threadBindingMaxAgeMs = resolveThreadBindingMaxAgeMsForChannel({
    accountId: effectiveAccountId,
    cfg,
    channel: "matrix",
  });
  const dmConfig = accountConfig.dm;
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicyRaw = dmConfig?.policy ?? "pairing";
  const dmPolicy = allowlistOnly && dmPolicyRaw !== "disabled" ? "allowlist" : dmPolicyRaw;
  const dmSessionScope = dmConfig?.sessionScope ?? "per-user";
  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "matrix", effectiveAccountId);
  const globalGroupChatHistoryLimit = (
    cfg.messages as { groupChat?: { historyLimit?: number } } | undefined
  )?.groupChat?.historyLimit;
  const historyLimit = Math.max(0, accountConfig.historyLimit ?? globalGroupChatHistoryLimit ?? 0);
  const mediaMaxMb = opts.mediaMaxMb ?? accountConfig.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const mediaMaxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const streaming: "partial" | "quiet" | "off" =
    accountConfig.streaming === true || accountConfig.streaming === "partial"
      ? "partial"
      : (accountConfig.streaming === "quiet"
        ? "quiet"
        : "off");
  const blockStreamingEnabled = accountConfig.blockStreaming === true;
  const startupMs = Date.now();
  const startupGraceMs = 0;
  const warnedEncryptedRooms = new Set<string>();
  const warnedCryptoMissingRooms = new Set<string>();

  try {
    client = await resolveSharedMatrixClient({
      accountId: auth.accountId,
      auth: authWithLimit,
      cfg,
      startClient: false,
    });
    setActiveMatrixClient(client, auth.accountId);
    inboundDeduper = await createMatrixInboundEventDeduper({
      auth,
      env: process.env,
    });
    syncLifecycle = createMatrixMonitorSyncLifecycle({
      client,
      isStopping: () => cleanedUp || opts.abortSignal?.aborted === true,
      statusController,
    });
    // Cold starts should ignore old room history, but once we have a persisted
    // /sync cursor we want restart backlogs to replay just like other channels.
    const dropPreStartupMessages = !client.hasPersistedSyncState();
    const { getRoomInfo, getMemberDisplayName } = createMatrixRoomInfoResolver(client);
    const directTracker = createDirectRoomTracker(client, {
      canPromoteRecentInvite: async (roomId) =>
        shouldPromoteRecentInviteRoom({
          roomId,
          roomInfo: await getRoomInfo(roomId, { includeAliases: true }),
          rooms: roomsConfig,
        }),
      log: logVerboseMessage,
      shouldKeepLocallyPromotedDirectRoom: async (roomId) => {
        try {
          const roomInfo = await getRoomInfo(roomId, { includeAliases: true });
          if (!roomInfo.nameResolved || !roomInfo.aliasesResolved) {
            return undefined;
          }
          return shouldPromoteRecentInviteRoom({
            roomId,
            roomInfo,
            rooms: roomsConfig,
          });
        } catch (error) {
          logVerboseMessage(
            `matrix: local promotion revalidation failed room=${roomId} (${String(error)})`,
          );
          return undefined;
        }
      },
    });
    registerMatrixAutoJoin({ accountConfig, client, runtime });
    const handleRoomMessage = createMatrixRoomMessageHandler({
      accountAllowBots,
      accountId: effectiveAccountId,
      allowFrom,
      blockStreamingEnabled,
      cfg,
      client,
      configuredBotUserIds,
      core,
      directTracker,
      dmEnabled,
      dmPolicy,
      dmSessionScope,
      dmThreadReplies,
      dropPreStartupMessages,
      getMemberDisplayName,
      getRoomInfo,
      groupAllowFrom,
      groupPolicy,
      historyLimit,
      inboundDeduper,
      logVerboseMessage,
      logger,
      mediaMaxBytes,
      needsRoomAliasesForConfig,
      replyToMode,
      roomsConfig,
      runtime,
      startupGraceMs,
      startupMs,
      streaming,
      textLimit,
      threadReplies,
    });
    threadBindingManager = await createMatrixThreadBindingManager({
      accountId: effectiveAccountId,
      auth,
      client,
      env: process.env,
      idleTimeoutMs: threadBindingIdleTimeoutMs,
      logVerboseMessage,
      maxAgeMs: threadBindingMaxAgeMs,
    });
    logVerboseMessage(
      `matrix: thread bindings ready account=${threadBindingManager.accountId} idleMs=${threadBindingIdleTimeoutMs} maxAgeMs=${threadBindingMaxAgeMs}`,
    );

    registerMatrixMonitorEvents({
      allowFrom,
      auth,
      cfg,
      client,
      directTracker,
      dmEnabled,
      dmPolicy,
      formatNativeDependencyHint: core.system.formatNativeDependencyHint,
      logVerboseMessage,
      logger,
      onRoomMessage: handleRoomMessage,
      readStoreAllowFrom: async () =>
        await core.channel.pairing
          .readAllowFromStore({
            accountId: effectiveAccountId,
            channel: "matrix",
            env: process.env,
          })
          .catch(() => []),
      runDetachedTask: monitorTaskRunner.runDetachedTask,
      warnedCryptoMissingRooms,
      warnedEncryptedRooms,
    });

    // Register Matrix thread bindings before the client starts syncing so threaded
    // Commands during startup never observe Matrix as "unavailable".
    logVerboseMessage("matrix: starting client");
    await resolveSharedMatrixClient({
      abortSignal: opts.abortSignal,
      accountId: auth.accountId,
      auth: authWithLimit,
      cfg,
    });
    logVerboseMessage("matrix: client started");

    // Shared client is already started via resolveSharedMatrixClient.
    logger.info(`matrix: logged in as ${auth.userId}`);
    void backfillMatrixAuthDeviceIdAfterStartup({
      abortSignal: opts.abortSignal,
      auth,
      env: process.env,
    }).catch((error) => {
      logVerboseMessage(`matrix: failed to backfill deviceId after startup (${String(error)})`);
    });

    registerChannelRuntimeContext({
      abortSignal: opts.abortSignal,
      accountId: effectiveAccountId,
      capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
      channelId: "matrix",
      channelRuntime: opts.channelRuntime,
      context: {
        client,
      },
    });

    await runMatrixStartupMaintenance({
      abortSignal: opts.abortSignal,
      accountConfig,
      accountId: effectiveAccountId,
      auth,
      client,
      effectiveAccountId,
      env: process.env,
      loadConfig: () => core.config.loadConfig() as CoreConfig,
      loadWebMedia: async (url, maxBytes) => await core.media.loadWebMedia(url, maxBytes),
      logVerboseMessage,
      logger,
      writeConfigFile: async (nextCfg) => await core.config.writeConfigFile(nextCfg),
    });

    await Promise.race([
      waitUntilAbort(opts.abortSignal, async () => {
        try {
          logVerboseMessage("matrix: stopping client");
          await cleanup();
        } catch (error) {
          logger.warn("matrix: failed during monitor shutdown cleanup", {
            error: String(error),
          });
        }
      }),
      syncLifecycle.waitForFatalStop(),
    ]);
  } catch (error) {
    if (opts.abortSignal?.aborted === true && isMatrixStartupAbortError(error)) {
      await cleanup("stop");
      return;
    }
    statusController.noteUnexpectedError(error);
    await cleanup();
    throw error;
  }
}
