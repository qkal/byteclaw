import type {
  ChannelApprovalKind,
  ChannelApprovalNativeAdapter,
} from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  type ChannelApprovalNativeDeliveryPlan,
  type ChannelApprovalNativePlannedTarget,
  resolveChannelNativeApprovalDeliveryPlan,
} from "./approval-native-delivery.js";
import { createApprovalNativeRouteReporter } from "./approval-native-route-coordinator.js";
import {
  type ExecApprovalChannelRuntime,
  type ExecApprovalChannelRuntimeAdapter,
  type ExecApprovalChannelRuntimeEventKind,
  createExecApprovalChannelRuntime,
} from "./exec-approval-channel-runtime.js";
import type { ExecApprovalResolved } from "./exec-approvals.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalResolved } from "./plugin-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;

export interface PreparedChannelNativeApprovalTarget<TPreparedTarget> {
  dedupeKey: string;
  target: TPreparedTarget;
}

export interface ChannelNativeApprovalPlanDeliveryResult<TPendingEntry> {
  entries: TPendingEntry[];
  deliveryPlan: ChannelApprovalNativeDeliveryPlan;
  deliveredTargets: ChannelApprovalNativePlannedTarget[];
}

export async function deliverApprovalRequestViaChannelNativePlan<
  TPreparedTarget,
  TPendingEntry,
  TRequest extends ApprovalRequest = ApprovalRequest,
>(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
  request: TRequest;
  adapter?: ChannelApprovalNativeAdapter | null;
  prepareTarget: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    request: TRequest;
  }) =>
    | PreparedChannelNativeApprovalTarget<TPreparedTarget>
    | null
    | Promise<PreparedChannelNativeApprovalTarget<TPreparedTarget> | null>;
  deliverTarget: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: TPreparedTarget;
    request: TRequest;
  }) => TPendingEntry | null | Promise<TPendingEntry | null>;
  onDeliveryError?: (params: {
    error: unknown;
    plannedTarget: ChannelApprovalNativePlannedTarget;
    request: TRequest;
  }) => void;
  onDuplicateSkipped?: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
    request: TRequest;
  }) => void;
  onDelivered?: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
    request: TRequest;
    entry: TPendingEntry;
  }) => void;
}): Promise<ChannelNativeApprovalPlanDeliveryResult<TPendingEntry>> {
  const deliveryPlan = await resolveChannelNativeApprovalDeliveryPlan({
    accountId: params.accountId,
    adapter: params.adapter,
    approvalKind: params.approvalKind,
    cfg: params.cfg,
    request: params.request,
  });

  const deliveredKeys = new Set<string>();
  const pendingEntries: TPendingEntry[] = [];
  const deliveredTargets: ChannelApprovalNativePlannedTarget[] = [];
  for (const plannedTarget of deliveryPlan.targets) {
    try {
      const preparedTarget = await params.prepareTarget({
        plannedTarget,
        request: params.request,
      });
      if (!preparedTarget) {
        continue;
      }
      if (deliveredKeys.has(preparedTarget.dedupeKey)) {
        params.onDuplicateSkipped?.({
          plannedTarget,
          preparedTarget,
          request: params.request,
        });
        continue;
      }

      const entry = await params.deliverTarget({
        plannedTarget,
        preparedTarget: preparedTarget.target,
        request: params.request,
      });
      if (!entry) {
        continue;
      }

      deliveredKeys.add(preparedTarget.dedupeKey);
      pendingEntries.push(entry);
      deliveredTargets.push(plannedTarget);
      params.onDelivered?.({
        entry,
        plannedTarget,
        preparedTarget,
        request: params.request,
      });
    } catch (error) {
      params.onDeliveryError?.({
        error,
        plannedTarget,
        request: params.request,
      });
    }
  }

  return {
    deliveredTargets,
    deliveryPlan,
    entries: pendingEntries,
  };
}

function defaultResolveApprovalKind(request: ApprovalRequest): ChannelApprovalKind {
  return request.id.startsWith("plugin:") ? "plugin" : "exec";
}

type ChannelNativeApprovalRuntimeAdapter<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
> = Omit<
  ExecApprovalChannelRuntimeAdapter<TPendingEntry, TRequest, TResolved>,
  "deliverRequested"
> & {
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  nativeAdapter?: ChannelApprovalNativeAdapter | null;
  resolveApprovalKind?: (request: TRequest) => ChannelApprovalKind;
  buildPendingContent: (params: {
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    nowMs: number;
  }) => TPendingContent | Promise<TPendingContent>;
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
  onStopped?: () => Promise<void> | void;
};

export function createChannelNativeApprovalRuntime<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
>(
  adapter: ChannelNativeApprovalRuntimeAdapter<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest,
    TResolved
  >,
): ExecApprovalChannelRuntime<TRequest, TResolved> {
  const nowMs = adapter.nowMs ?? Date.now;
  const resolveApprovalKind =
    adapter.resolveApprovalKind ?? ((request: TRequest) => defaultResolveApprovalKind(request));
  let runtimeRequest:
    | ((method: string, params: Record<string, unknown>) => Promise<unknown>)
    | null = null;
  const handledEventKinds = new Set<ExecApprovalChannelRuntimeEventKind>(
    adapter.eventKinds ?? ["exec"],
  );
  const routeReporter = createApprovalNativeRouteReporter({
    accountId: adapter.accountId,
    channel: adapter.channel,
    channelLabel: adapter.channelLabel,
    handledKinds: handledEventKinds,
    requestGateway: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (!runtimeRequest) {
        throw new Error(`${adapter.label}: gateway client not connected`);
      }
      return (await runtimeRequest(method, params)) as T;
    },
  });

  const runtime = createExecApprovalChannelRuntime<TPendingEntry, TRequest, TResolved>({
    beforeGatewayClientStart: () => {
      routeReporter.start();
    },
    cfg: adapter.cfg,
    clientDisplayName: adapter.clientDisplayName,
    deliverRequested: async (request) => {
      const approvalKind = resolveApprovalKind(request);
      let deliveryPlan: ChannelApprovalNativeDeliveryPlan = {
        notifyOriginWhenDmOnly: false,
        originTarget: null,
        targets: [],
      };
      let deliveredTargets: ChannelApprovalNativePlannedTarget[] = [];
      try {
        const pendingContent = await adapter.buildPendingContent({
          approvalKind,
          nowMs: nowMs(),
          request,
        });
        const deliveryResult = await deliverApprovalRequestViaChannelNativePlan({
          accountId: adapter.accountId,
          adapter: adapter.nativeAdapter,
          approvalKind,
          cfg: adapter.cfg,
          deliverTarget: async ({ plannedTarget, preparedTarget, request }) =>
            await adapter.deliverTarget({
              plannedTarget,
              preparedTarget,
              request,
              approvalKind,
              pendingContent,
            }),
          onDelivered: adapter.onDelivered
            ? ({ plannedTarget, preparedTarget, request, entry }) => {
                adapter.onDelivered?.({
                  plannedTarget,
                  preparedTarget,
                  request,
                  approvalKind,
                  pendingContent,
                  entry,
                });
              }
            : undefined,
          onDeliveryError: adapter.onDeliveryError
            ? ({ error, plannedTarget, request }) => {
                adapter.onDeliveryError?.({
                  error,
                  plannedTarget,
                  request,
                  approvalKind,
                  pendingContent,
                });
              }
            : undefined,
          onDuplicateSkipped: adapter.onDuplicateSkipped
            ? ({ plannedTarget, preparedTarget, request }) => {
                adapter.onDuplicateSkipped?.({
                  plannedTarget,
                  preparedTarget,
                  request,
                  approvalKind,
                  pendingContent,
                });
              }
            : undefined,
          prepareTarget: async ({ plannedTarget, request }) =>
            await adapter.prepareTarget({
              plannedTarget,
              request,
              approvalKind,
              pendingContent,
            }),
          request,
        });
        ({ deliveryPlan } = deliveryResult);
        ({ deliveredTargets } = deliveryResult);
        return deliveryResult.entries;
      } finally {
        await routeReporter.reportDelivery({
          approvalKind,
          deliveredTargets,
          deliveryPlan,
          request,
        });
      }
    },
    eventKinds: adapter.eventKinds,
    finalizeExpired: adapter.finalizeExpired,
    finalizeResolved: adapter.finalizeResolved,
    gatewayUrl: adapter.gatewayUrl,
    isConfigured: adapter.isConfigured,
    label: adapter.label,
    nowMs,
    onStopped: adapter.onStopped,
    shouldHandle: (request) => {
      const approvalKind = resolveApprovalKind(request);
      routeReporter.observeRequest({
        approvalKind,
        request,
      });
      let shouldHandle: boolean;
      try {
        shouldHandle = adapter.shouldHandle(request);
      } catch (error) {
        void routeReporter.reportSkipped({
          approvalKind,
          request,
        });
        throw error;
      }
      if (shouldHandle) {
        return shouldHandle;
      }
      void routeReporter.reportSkipped({
        approvalKind,
        request,
      });
      return false;
    },
  });

  runtimeRequest = (method, params) => runtime.request(method, params);

  return {
    ...runtime,
    async start() {
      try {
        await runtime.start();
      } catch (error) {
        await routeReporter.stop();
        throw error;
      }
    },
    async stop() {
      await routeReporter.stop();
      await runtime.stop();
    },
  };
}
