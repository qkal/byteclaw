import type {
  ChannelApprovalCapability,
  ChannelApprovalKind,
  ChannelApprovalNativeAdapter,
} from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveApprovalOverGateway } from "./approval-gateway-resolver.js";
import {
  CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
  createLazyChannelApprovalNativeRuntimeAdapter,
} from "./approval-handler-adapter-runtime.js";
import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";
import {
  type PreparedChannelNativeApprovalTarget,
  createChannelNativeApprovalRuntime,
} from "./approval-native-runtime.js";
import type {
  ApprovalActionView,
  ApprovalMetadataView,
  ExpiredApprovalView,
  PendingApprovalView,
  ResolvedApprovalView,
} from "./approval-view-model.js";
import {
  buildExpiredApprovalView,
  buildPendingApprovalView,
  buildResolvedApprovalView,
} from "./approval-view-model.js";
import type {
  ExecApprovalChannelRuntime,
  ExecApprovalChannelRuntimeEventKind,
} from "./exec-approval-channel-runtime.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "./exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

export type {
  ApprovalActionView,
  ApprovalMetadataView,
  ApprovalViewModel,
  ExecApprovalExpiredView,
  ExecApprovalPendingView,
  ExecApprovalResolvedView,
  ExpiredApprovalView,
  PendingApprovalView,
  PluginApprovalExpiredView,
  PluginApprovalPendingView,
  PluginApprovalResolvedView,
  ResolvedApprovalView,
} from "./approval-view-model.js";
export { resolveApprovalOverGateway };
export {
  CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
  createLazyChannelApprovalNativeRuntimeAdapter,
};

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;

export type ChannelApprovalHandler<
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
> = ExecApprovalChannelRuntime<TRequest, TResolved>;

export interface ChannelApprovalCapabilityHandlerContext {
  cfg: OpenClawConfig;
  accountId?: string | null;
  gatewayUrl?: string;
  context?: unknown;
}

export type ChannelApprovalNativeFinalAction<TPayload> =
  | { kind: "update"; payload: TPayload }
  | { kind: "delete" }
  | { kind: "clear-actions" }
  | { kind: "leave" };

export interface ChannelApprovalNativeAvailabilityAdapter {
  isConfigured: (params: ChannelApprovalCapabilityHandlerContext) => boolean;
  shouldHandle: (
    params: ChannelApprovalCapabilityHandlerContext & { request: ApprovalRequest },
  ) => boolean;
}

export interface ChannelApprovalNativePresentationAdapter<
  TPendingPayload = unknown,
  TFinalPayload = unknown,
> {
  buildPendingPayload: (
    params: ChannelApprovalCapabilityHandlerContext & {
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      nowMs: number;
      view: PendingApprovalView;
    },
  ) => TPendingPayload | Promise<TPendingPayload>;
  buildResolvedResult: (
    params: ChannelApprovalCapabilityHandlerContext & {
      request: ApprovalRequest;
      resolved: ApprovalResolved;
      view: ResolvedApprovalView;
      entry: unknown;
    },
  ) =>
    | ChannelApprovalNativeFinalAction<TFinalPayload>
    | Promise<ChannelApprovalNativeFinalAction<TFinalPayload>>;
  buildExpiredResult: (
    params: ChannelApprovalCapabilityHandlerContext & {
      request: ApprovalRequest;
      view: ExpiredApprovalView;
      entry: unknown;
    },
  ) =>
    | ChannelApprovalNativeFinalAction<TFinalPayload>
    | Promise<ChannelApprovalNativeFinalAction<TFinalPayload>>;
}

export interface ChannelApprovalNativeTransportAdapter<
  TPreparedTarget = unknown,
  TPendingEntry = unknown,
  TPendingPayload = unknown,
  TFinalPayload = unknown,
> {
  prepareTarget: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: PendingApprovalView;
      pendingPayload: TPendingPayload;
    },
  ) =>
    | PreparedChannelNativeApprovalTarget<TPreparedTarget>
    | null
    | Promise<PreparedChannelNativeApprovalTarget<TPreparedTarget> | null>;
  deliverPending: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      preparedTarget: TPreparedTarget;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: PendingApprovalView;
      pendingPayload: TPendingPayload;
    },
  ) => TPendingEntry | null | Promise<TPendingEntry | null>;
  updateEntry?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      payload: TFinalPayload;
      phase: "resolved" | "expired";
    },
  ) => Promise<void>;
  deleteEntry?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      phase: "resolved" | "expired";
    },
  ) => Promise<void>;
}

export interface ChannelApprovalNativeInteractionAdapter<TPendingEntry = unknown, TBinding = unknown> {
  bindPending?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: PendingApprovalView;
      pendingPayload: unknown;
    },
  ) => TBinding | null | Promise<TBinding | null>;
  unbindPending?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      binding: TBinding;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
    },
  ) => Promise<void> | void;
  clearPendingActions?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      phase: "resolved" | "expired";
    },
  ) => Promise<void>;
}

export interface ChannelApprovalNativeObserveAdapter<
  TPreparedTarget = unknown,
  TPendingPayload = unknown,
  TPendingEntry = unknown,
> {
  onDeliveryError?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      error: unknown;
      plannedTarget: ChannelApprovalNativePlannedTarget;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: PendingApprovalView;
      pendingPayload: TPendingPayload;
    },
  ) => void;
  onDuplicateSkipped?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: PendingApprovalView;
      pendingPayload: TPendingPayload;
    },
  ) => void;
  onDelivered?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: PendingApprovalView;
      pendingPayload: TPendingPayload;
      entry: TPendingEntry;
    },
  ) => void;
}

export interface ChannelApprovalNativeRuntimeAdapter<
  TPendingPayload = unknown,
  TPreparedTarget = unknown,
  TPendingEntry = unknown,
  TBinding = unknown,
  TFinalPayload = unknown,
> {
  eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
  resolveApprovalKind?: (request: ApprovalRequest) => ChannelApprovalKind;
  availability: ChannelApprovalNativeAvailabilityAdapter;
  presentation: ChannelApprovalNativePresentationAdapter<TPendingPayload, TFinalPayload>;
  transport: ChannelApprovalNativeTransportAdapter<
    TPreparedTarget,
    TPendingEntry,
    TPendingPayload,
    TFinalPayload
  >;
  interactions?: ChannelApprovalNativeInteractionAdapter<TPendingEntry, TBinding>;
  observe?: ChannelApprovalNativeObserveAdapter;
}

export interface ChannelApprovalNativeRuntimeSpec<
  TPendingPayload,
  TPreparedTarget,
  TPendingEntry,
  TBinding = unknown,
  TFinalPayload = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
  TResolvedView extends ResolvedApprovalView = ResolvedApprovalView,
  TExpiredView extends ExpiredApprovalView = ExpiredApprovalView,
> {
  eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
  resolveApprovalKind?: (request: ApprovalRequest) => ChannelApprovalKind;
  availability: ChannelApprovalNativeAvailabilityAdapter;
  presentation: {
    buildPendingPayload: (
      params: ChannelApprovalCapabilityHandlerContext & {
        request: ApprovalRequest;
        approvalKind: ChannelApprovalKind;
        nowMs: number;
        view: TPendingView;
      },
    ) => TPendingPayload | Promise<TPendingPayload>;
    buildResolvedResult: (
      params: ChannelApprovalCapabilityHandlerContext & {
        request: ApprovalRequest;
        resolved: ApprovalResolved;
        view: TResolvedView;
        entry: TPendingEntry;
      },
    ) =>
      | ChannelApprovalNativeFinalAction<TFinalPayload>
      | Promise<ChannelApprovalNativeFinalAction<TFinalPayload>>;
    buildExpiredResult: (
      params: ChannelApprovalCapabilityHandlerContext & {
        request: ApprovalRequest;
        view: TExpiredView;
        entry: TPendingEntry;
      },
    ) =>
      | ChannelApprovalNativeFinalAction<TFinalPayload>
      | Promise<ChannelApprovalNativeFinalAction<TFinalPayload>>;
  };
  transport: {
    prepareTarget: (
      params: ChannelApprovalCapabilityHandlerContext & {
        plannedTarget: ChannelApprovalNativePlannedTarget;
        request: ApprovalRequest;
        approvalKind: ChannelApprovalKind;
        view: TPendingView;
        pendingPayload: TPendingPayload;
      },
    ) =>
      | PreparedChannelNativeApprovalTarget<TPreparedTarget>
      | null
      | Promise<PreparedChannelNativeApprovalTarget<TPreparedTarget> | null>;
    deliverPending: (
      params: ChannelApprovalCapabilityHandlerContext & {
        plannedTarget: ChannelApprovalNativePlannedTarget;
        preparedTarget: TPreparedTarget;
        request: ApprovalRequest;
        approvalKind: ChannelApprovalKind;
        view: TPendingView;
        pendingPayload: TPendingPayload;
      },
    ) => TPendingEntry | null | Promise<TPendingEntry | null>;
    updateEntry?: (
      params: ChannelApprovalCapabilityHandlerContext & {
        entry: TPendingEntry;
        payload: TFinalPayload;
        phase: "resolved" | "expired";
      },
    ) => Promise<void>;
    deleteEntry?: (
      params: ChannelApprovalCapabilityHandlerContext & {
        entry: TPendingEntry;
        phase: "resolved" | "expired";
      },
    ) => Promise<void>;
  };
  interactions?: {
    bindPending?: (
      params: ChannelApprovalCapabilityHandlerContext & {
        entry: TPendingEntry;
        request: ApprovalRequest;
        approvalKind: ChannelApprovalKind;
        view: TPendingView;
        pendingPayload: TPendingPayload;
      },
    ) => TBinding | null | Promise<TBinding | null>;
    unbindPending?: (
      params: ChannelApprovalCapabilityHandlerContext & {
        entry: TPendingEntry;
        binding: TBinding;
        request: ApprovalRequest;
        approvalKind: ChannelApprovalKind;
      },
    ) => Promise<void> | void;
    clearPendingActions?: (
      params: ChannelApprovalCapabilityHandlerContext & {
        entry: TPendingEntry;
        phase: "resolved" | "expired";
      },
    ) => Promise<void>;
  };
  observe?: {
    onDeliveryError?: (
      params: ChannelApprovalCapabilityHandlerContext & {
        error: unknown;
        plannedTarget: ChannelApprovalNativePlannedTarget;
        request: ApprovalRequest;
        approvalKind: ChannelApprovalKind;
        view: TPendingView;
        pendingPayload: TPendingPayload;
      },
    ) => void;
    onDuplicateSkipped?: (
      params: ChannelApprovalCapabilityHandlerContext & {
        plannedTarget: ChannelApprovalNativePlannedTarget;
        preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
        request: ApprovalRequest;
        approvalKind: ChannelApprovalKind;
        view: TPendingView;
        pendingPayload: TPendingPayload;
      },
    ) => void;
    onDelivered?: (
      params: ChannelApprovalCapabilityHandlerContext & {
        plannedTarget: ChannelApprovalNativePlannedTarget;
        preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
        request: ApprovalRequest;
        approvalKind: ChannelApprovalKind;
        view: TPendingView;
        pendingPayload: TPendingPayload;
        entry: TPendingEntry;
      },
    ) => void;
  };
}

interface WrappedPendingEntry {
  entry: unknown;
  binding?: unknown;
}

interface ActiveApprovalEntries {
  request: ApprovalRequest;
  approvalKind: ChannelApprovalKind;
  entries: WrappedPendingEntry[];
}

interface WrappedPendingContent {
  view: PendingApprovalView;
  payload: unknown;
}

function consumeActiveWrappedEntries(
  activeEntries: Map<string, ActiveApprovalEntries>,
  requestId: string,
  fallbackEntries: WrappedPendingEntry[],
): WrappedPendingEntry[] {
  const entries = activeEntries.get(requestId)?.entries ?? fallbackEntries;
  activeEntries.delete(requestId);
  return entries;
}

async function finalizeWrappedEntries(params: {
  entries: WrappedPendingEntry[];
  phase: "resolved" | "expired";
  request: ApprovalRequest;
  log: ReturnType<typeof createSubsystemLogger>;
  runEntry: (wrapped: WrappedPendingEntry) => Promise<void>;
}): Promise<void> {
  for (const wrapped of params.entries) {
    try {
      await params.runEntry(wrapped);
    } catch (error) {
      params.log.error(
        `failed to finalize ${params.phase} native approval entry ` +
          `approval=${params.request.id}: ${String(error)}`,
      );
    }
  }
}

async function unbindWrappedEntries(params: {
  entries: WrappedPendingEntry[];
  request: ApprovalRequest;
  approvalKind: ChannelApprovalKind;
  baseContext: ChannelApprovalCapabilityHandlerContext;
  nativeRuntime: ChannelApprovalNativeRuntimeAdapter;
  log: ReturnType<typeof createSubsystemLogger>;
}): Promise<void> {
  if (!params.nativeRuntime.interactions?.unbindPending) {
    return;
  }
  for (const wrapped of params.entries) {
    if (wrapped.binding === undefined) {
      continue;
    }
    try {
      await params.nativeRuntime.interactions.unbindPending({
        ...params.baseContext,
        approvalKind: params.approvalKind,
        binding: wrapped.binding,
        entry: wrapped.entry,
        request: params.request,
      });
    } catch (error) {
      params.log.error(
        `failed to unbind stopped native approval entry ` +
          `approval=${params.request.id}: ${String(error)}`,
      );
    }
  }
}

async function applyApprovalFinalAction(params: {
  nativeRuntime: ChannelApprovalNativeRuntimeAdapter;
  baseContext: ChannelApprovalCapabilityHandlerContext;
  wrapped: WrappedPendingEntry;
  result: ChannelApprovalNativeFinalAction<unknown>;
  phase: "resolved" | "expired";
}): Promise<void> {
  switch (params.result.kind) {
    case "update": {
      await params.nativeRuntime.transport.updateEntry?.({
        ...params.baseContext,
        entry: params.wrapped.entry,
        payload: params.result.payload,
        phase: params.phase,
      });
      return;
    }
    case "delete": {
      await params.nativeRuntime.transport.deleteEntry?.({
        ...params.baseContext,
        entry: params.wrapped.entry,
        phase: params.phase,
      });
      return;
    }
    case "clear-actions": {
      await params.nativeRuntime.interactions?.clearPendingActions?.({
        ...params.baseContext,
        entry: params.wrapped.entry,
        phase: params.phase,
      });
      return;
    }
    case "leave": {
      return;
    }
  }
}

export function createChannelApprovalNativeRuntimeAdapter<
  TPendingPayload,
  TPreparedTarget,
  TPendingEntry,
  TBinding = unknown,
  TFinalPayload = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
  TResolvedView extends ResolvedApprovalView = ResolvedApprovalView,
  TExpiredView extends ExpiredApprovalView = ExpiredApprovalView,
>(
  spec: ChannelApprovalNativeRuntimeSpec<
    TPendingPayload,
    TPreparedTarget,
    TPendingEntry,
    TBinding,
    TFinalPayload,
    TPendingView,
    TResolvedView,
    TExpiredView
  >,
): ChannelApprovalNativeRuntimeAdapter<
  TPendingPayload,
  TPreparedTarget,
  TPendingEntry,
  TBinding,
  TFinalPayload
> {
  return {
    ...(spec.eventKinds ? { eventKinds: spec.eventKinds } : {}),
    ...(spec.resolveApprovalKind ? { resolveApprovalKind: spec.resolveApprovalKind } : {}),
    availability: {
      isConfigured: spec.availability.isConfigured,
      shouldHandle: spec.availability.shouldHandle,
    },
    presentation: {
      buildExpiredResult: async (params) =>
        await spec.presentation.buildExpiredResult(params as never),
      buildPendingPayload: async (params) =>
        await spec.presentation.buildPendingPayload(params as never),
      buildResolvedResult: async (params) =>
        await spec.presentation.buildResolvedResult(params as never),
    },
    transport: {
      deliverPending: async (params) => await spec.transport.deliverPending(params as never),
      prepareTarget: async (params) => await spec.transport.prepareTarget(params as never),
      ...(spec.transport.updateEntry
        ? {
            updateEntry: async (
              params: {
                entry: unknown;
                payload: unknown;
                phase: "resolved" | "expired";
              } & ChannelApprovalCapabilityHandlerContext,
            ) => await spec.transport.updateEntry?.(params as never),
          }
        : {}),
      ...(spec.transport.deleteEntry
        ? {
            deleteEntry: async (
              params: {
                entry: unknown;
                phase: "resolved" | "expired";
              } & ChannelApprovalCapabilityHandlerContext,
            ) => await spec.transport.deleteEntry?.(params as never),
          }
        : {}),
    },
    ...(spec.interactions
      ? {
          interactions: {
            ...(spec.interactions.bindPending
              ? {
                  bindPending: async (params) =>
                    (await spec.interactions!.bindPending!(params as never)) ?? null,
                }
              : {}),
            ...(spec.interactions.unbindPending
              ? {
                  unbindPending: async (params) =>
                    await spec.interactions?.unbindPending?.(params as never),
                }
              : {}),
            ...(spec.interactions.clearPendingActions
              ? {
                  clearPendingActions: async (params) =>
                    await spec.interactions?.clearPendingActions?.(params as never),
                }
              : {}),
          },
        }
      : {}),
    ...(spec.observe
      ? {
          observe: {
            ...(spec.observe.onDeliveryError
              ? {
                  onDeliveryError: (params) => spec.observe?.onDeliveryError?.(params as never),
                }
              : {}),
            ...(spec.observe.onDuplicateSkipped
              ? {
                  onDuplicateSkipped: (params) =>
                    spec.observe?.onDuplicateSkipped?.(params as never),
                }
              : {}),
            ...(spec.observe.onDelivered
              ? {
                  onDelivered: (params) => spec.observe?.onDelivered?.(params as never),
                }
              : {}),
          },
        }
      : {}),
  };
}

export interface ChannelApprovalHandlerRuntimeSpec<TRequest extends ApprovalRequest> {
  label: string;
  clientDisplayName: string;
  cfg: OpenClawConfig;
  gatewayUrl?: string;
  eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  nativeAdapter?: ChannelApprovalNativeAdapter | null;
  resolveApprovalKind?: (request: TRequest) => ChannelApprovalKind;
  isConfigured: () => boolean;
  shouldHandle: (request: TRequest) => boolean;
  nowMs?: () => number;
}

export interface ChannelApprovalHandlerContentSpec<
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
> {
  buildPendingContent: (params: {
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    nowMs: number;
  }) => TPendingContent | Promise<TPendingContent>;
}

export interface ChannelApprovalHandlerTransportSpec<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
> {
  prepareTarget: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
  }) =>
    | PreparedChannelNativeApprovalTarget<TPreparedTarget>
    | null
    | Promise<PreparedChannelNativeApprovalTarget<TPreparedTarget> | null>;
  deliverTarget: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: TPreparedTarget;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
  }) => TPendingEntry | null | Promise<TPendingEntry | null>;
}

export interface ChannelApprovalHandlerLifecycleSpec<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
> {
  onDeliveryError?: (params: {
    error: unknown;
    plannedTarget: ChannelApprovalNativePlannedTarget;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
  }) => void;
  onDuplicateSkipped?: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
  }) => void;
  onDelivered?: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
    entry: TPendingEntry;
  }) => void;
  finalizeResolved: (params: {
    request: TRequest;
    resolved: TResolved;
    entries: TPendingEntry[];
  }) => Promise<void>;
  finalizeExpired?: (params: { request: TRequest; entries: TPendingEntry[] }) => Promise<void>;
  onStopped?: () => Promise<void> | void;
}

export interface ChannelApprovalHandlerAdapter<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
> {
  runtime: ChannelApprovalHandlerRuntimeSpec<TRequest>;
  content: ChannelApprovalHandlerContentSpec<TPendingContent, TRequest>;
  transport: ChannelApprovalHandlerTransportSpec<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest
  >;
  lifecycle: ChannelApprovalHandlerLifecycleSpec<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest,
    TResolved
  >;
}

export function createChannelApprovalHandler<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
>(
  adapter: ChannelApprovalHandlerAdapter<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest,
    TResolved
  >,
): ChannelApprovalHandler<TRequest, TResolved> {
  return createChannelNativeApprovalRuntime<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest,
    TResolved
  >({
    accountId: adapter.runtime.accountId,
    buildPendingContent: adapter.content.buildPendingContent,
    cfg: adapter.runtime.cfg,
    channel: adapter.runtime.channel,
    channelLabel: adapter.runtime.channelLabel,
    clientDisplayName: adapter.runtime.clientDisplayName,
    deliverTarget: adapter.transport.deliverTarget,
    eventKinds: adapter.runtime.eventKinds,
    finalizeExpired: adapter.lifecycle.finalizeExpired,
    finalizeResolved: adapter.lifecycle.finalizeResolved,
    gatewayUrl: adapter.runtime.gatewayUrl,
    isConfigured: adapter.runtime.isConfigured,
    label: adapter.runtime.label,
    nativeAdapter: adapter.runtime.nativeAdapter,
    nowMs: adapter.runtime.nowMs,
    onDelivered: adapter.lifecycle.onDelivered,
    onDeliveryError: adapter.lifecycle.onDeliveryError,
    onDuplicateSkipped: adapter.lifecycle.onDuplicateSkipped,
    onStopped: adapter.lifecycle.onStopped,
    prepareTarget: adapter.transport.prepareTarget,
    resolveApprovalKind: adapter.runtime.resolveApprovalKind,
    shouldHandle: adapter.runtime.shouldHandle,
  });
}

export async function createChannelApprovalHandlerFromCapability(params: {
  capability?: Pick<ChannelApprovalCapability, "native" | "nativeRuntime"> | null;
  label: string;
  clientDisplayName: string;
  channel: string;
  channelLabel: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
  gatewayUrl?: string;
  context?: unknown;
  nowMs?: () => number;
}): Promise<ChannelApprovalHandler | null> {
  const nativeRuntime = params.capability?.nativeRuntime;
  if (!nativeRuntime) {
    return null;
  }
  const log = createSubsystemLogger(params.label);
  const activeEntries = new Map<string, ActiveApprovalEntries>();
  const resolveApprovalKind =
    nativeRuntime.resolveApprovalKind ??
    ((request: ApprovalRequest) =>
      request.id.startsWith("plugin:") ? "plugin" : ("exec" as const));
  const baseContext: ChannelApprovalCapabilityHandlerContext = {
    accountId: params.accountId,
    cfg: params.cfg,
    context: params.context,
    gatewayUrl: params.gatewayUrl,
  };
  return createChannelApprovalHandler<WrappedPendingEntry, unknown, WrappedPendingContent>({
    content: {
      buildPendingContent: async ({ request, approvalKind, nowMs }) => {
        const view = buildPendingApprovalView(request);
        return {
          payload: await nativeRuntime.presentation.buildPendingPayload({
            ...baseContext,
            request,
            approvalKind,
            nowMs,
            view,
          }),
          view,
        };
      },
    },
    lifecycle: {
      finalizeExpired: async ({ request, entries }) => {
        const expiredEntries = consumeActiveWrappedEntries(activeEntries, request.id, entries);
        const view = buildExpiredApprovalView(request);
        await finalizeWrappedEntries({
          entries: expiredEntries,
          log,
          phase: "expired",
          request,
          runEntry: async (wrapped) => {
            if (wrapped.binding !== undefined) {
              await nativeRuntime.interactions?.unbindPending?.({
                ...baseContext,
                entry: wrapped.entry,
                binding: wrapped.binding,
                request,
                approvalKind: resolveApprovalKind(request),
              });
            }
            const result = await nativeRuntime.presentation.buildExpiredResult({
              ...baseContext,
              request,
              view,
              entry: wrapped.entry,
            });
            await applyApprovalFinalAction({
              nativeRuntime,
              baseContext,
              wrapped,
              result,
              phase: "expired",
            });
          },
        });
      },
      finalizeResolved: async ({ request, resolved, entries }) => {
        const resolvedEntries = consumeActiveWrappedEntries(activeEntries, request.id, entries);
        const view = buildResolvedApprovalView(request, resolved);
        await finalizeWrappedEntries({
          entries: resolvedEntries,
          log,
          phase: "resolved",
          request,
          runEntry: async (wrapped) => {
            if (wrapped.binding !== undefined) {
              await nativeRuntime.interactions?.unbindPending?.({
                ...baseContext,
                entry: wrapped.entry,
                binding: wrapped.binding,
                request,
                approvalKind: resolveApprovalKind(request),
              });
            }
            const result = await nativeRuntime.presentation.buildResolvedResult({
              ...baseContext,
              request,
              resolved,
              view,
              entry: wrapped.entry,
            });
            await applyApprovalFinalAction({
              nativeRuntime,
              baseContext,
              wrapped,
              result,
              phase: "resolved",
            });
          },
        });
      },
      onDelivered: ({
        plannedTarget,
        preparedTarget,
        request,
        approvalKind,
        pendingContent,
        entry,
      }) => {
        nativeRuntime.observe?.onDelivered?.({
          ...baseContext,
          approvalKind,
          entry: entry.entry,
          pendingPayload: pendingContent.payload,
          plannedTarget,
          preparedTarget,
          request,
          view: pendingContent.view,
        });
      },
      onDeliveryError: ({ error, plannedTarget, request, approvalKind, pendingContent }) => {
        nativeRuntime.observe?.onDeliveryError?.({
          ...baseContext,
          approvalKind,
          error,
          pendingPayload: pendingContent.payload,
          plannedTarget,
          request,
          view: pendingContent.view,
        });
      },
      onDuplicateSkipped: ({
        plannedTarget,
        preparedTarget,
        request,
        approvalKind,
        pendingContent,
      }) => {
        nativeRuntime.observe?.onDuplicateSkipped?.({
          ...baseContext,
          approvalKind,
          pendingPayload: pendingContent.payload,
          plannedTarget,
          preparedTarget,
          request,
          view: pendingContent.view,
        });
      },
      onStopped: async () => {
        if (activeEntries.size === 0) {
          activeEntries.clear();
          return;
        }
        for (const activeRequest of activeEntries.values()) {
          await unbindWrappedEntries({
            approvalKind: activeRequest.approvalKind,
            baseContext,
            entries: activeRequest.entries,
            log,
            nativeRuntime,
            request: activeRequest.request,
          });
        }
        activeEntries.clear();
      },
    },
    runtime: {
      accountId: params.accountId,
      cfg: params.cfg,
      channel: params.channel,
      channelLabel: params.channelLabel,
      clientDisplayName: params.clientDisplayName,
      eventKinds: nativeRuntime.eventKinds,
      gatewayUrl: params.gatewayUrl,
      isConfigured: () => nativeRuntime.availability.isConfigured(baseContext),
      label: params.label,
      nativeAdapter: params.capability?.native as ChannelApprovalNativeAdapter | null,
      nowMs: params.nowMs,
      resolveApprovalKind,
      shouldHandle: (request) =>
        nativeRuntime.availability.shouldHandle({ ...baseContext, request }),
    },
    transport: {
      deliverTarget: async ({
        plannedTarget,
        preparedTarget,
        request,
        approvalKind,
        pendingContent,
      }) => {
        const entry = await nativeRuntime.transport.deliverPending({
          ...baseContext,
          approvalKind,
          pendingPayload: pendingContent.payload,
          plannedTarget,
          preparedTarget,
          request,
          view: pendingContent.view,
        });
        if (!entry) {
          return null;
        }
        const binding = await nativeRuntime.interactions?.bindPending?.({
          ...baseContext,
          approvalKind,
          entry,
          pendingPayload: pendingContent.payload,
          request,
          view: pendingContent.view,
        });
        const wrapped: WrappedPendingEntry = {
          entry,
          ...(binding === undefined || binding === null ? {} : { binding }),
        };
        const activeRequest = activeEntries.get(request.id) ?? {
          approvalKind,
          entries: [],
          request,
        };
        activeRequest.entries.push(wrapped);
        activeEntries.set(request.id, activeRequest);
        return wrapped;
      },
      prepareTarget: async ({ plannedTarget, request, approvalKind, pendingContent }) => await nativeRuntime.transport.prepareTarget({
          ...baseContext,
          plannedTarget,
          request,
          approvalKind,
          view: pendingContent.view,
          pendingPayload: pendingContent.payload,
        }),
    },
  });
}
