import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ReplyPayload } from '../auto-reply/types.js';
import {
  createConversationBindingRecord,
  resolveConversationBindingRecord,
  unbindConversationBindingRecord,
} from '../bindings/records.js';
import {
  getChannelPlugin,
  normalizeChannelId,
} from '../channels/plugins/index.js';
import { formatErrorMessage } from '../infra/errors.js';
import { expandHomePrefix } from '../infra/home-dir.js';
import { writeJsonAtomic } from '../infra/json-files.js';
import type { ConversationRef } from '../infra/outbound/session-binding-service.js';
import { createSubsystemLogger } from '../logging/subsystem.js';
import {
  resolveGlobalMap,
  resolveGlobalSingleton,
} from '../shared/global-singleton.js';
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from '../shared/string-coerce.js';
import { getActivePluginRegistry } from './runtime.js';
import type {
  PluginConversationBinding,
  PluginConversationBindingRequestParams,
  PluginConversationBindingRequestResult,
  PluginConversationBindingResolutionDecision,
  PluginConversationBindingResolvedEvent,
} from './types.js';

const log = createSubsystemLogger('plugins/binding');

const APPROVALS_PATH = '~/.openclaw/plugin-binding-approvals.json';
const PLUGIN_BINDING_CUSTOM_ID_PREFIX = 'pluginbind';
const PLUGIN_BINDING_OWNER = 'plugin';
const PLUGIN_BINDING_SESSION_PREFIX = 'plugin-binding';
const LEGACY_CODEX_PLUGIN_SESSION_PREFIXES = [
  'openclaw-app-server:thread:',
  'openclaw-codex-app-server:thread:',
] as const;

// Runtime plugin conversation bindings are approval-driven and distinct from
// Configured channel bindings compiled from config.
type PluginBindingApprovalDecision =
  PluginConversationBindingResolutionDecision;

interface PluginBindingApprovalEntry {
  pluginRoot: string;
  pluginId: string;
  pluginName?: string;
  channel: string;
  accountId: string;
  approvedAt: number;
}

interface PluginBindingApprovalsFile {
  version: 1;
  approvals: PluginBindingApprovalEntry[];
}

interface PluginBindingConversation {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string | number;
}

interface PendingPluginBindingRequest {
  id: string;
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  conversation: PluginBindingConversation;
  requestedAt: number;
  requestedBySenderId?: string;
  summary?: string;
  detachHint?: string;
}

interface PluginBindingApprovalAction {
  approvalId: string;
  decision: PluginBindingApprovalDecision;
}

interface PluginBindingIdentity {
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
}

interface PluginBindingMetadata {
  pluginBindingOwner: 'plugin';
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  summary?: string;
  detachHint?: string;
}

type PluginBindingResolveResult =
  | {
      status: 'approved';
      binding: PluginConversationBinding;
      request: PendingPluginBindingRequest;
      decision: Exclude<PluginBindingApprovalDecision, 'deny'>;
    }
  | {
      status: 'denied';
      request: PendingPluginBindingRequest;
    }
  | {
      status: 'expired';
    };

const PLUGIN_BINDING_PENDING_REQUESTS_KEY = Symbol.for(
  'openclaw.pluginBindingPendingRequests',
);

const pendingRequests = resolveGlobalMap<string, PendingPluginBindingRequest>(
  PLUGIN_BINDING_PENDING_REQUESTS_KEY,
);

interface PluginBindingGlobalState {
  fallbackNoticeBindingIds: Set<string>;
  approvalsCache: PluginBindingApprovalsFile | null;
  approvalsLoaded: boolean;
}

interface PluginConversationBindingState {
  ref: ConversationRef;
  record:
    | {
        bindingId: string;
        conversation: ConversationRef;
        boundAt: number;
        metadata?: Record<string, unknown>;
        targetSessionKey: string;
      }
    | null
    | undefined;
  binding: PluginConversationBinding | null;
  isLegacyForeignBinding: boolean;
}

const pluginBindingGlobalStateKey = Symbol.for(
  'openclaw.plugins.binding.global-state',
);
const pluginBindingGlobalState =
  resolveGlobalSingleton<PluginBindingGlobalState>(
    pluginBindingGlobalStateKey,
    () => ({
      approvalsCache: null,
      approvalsLoaded: false,
      fallbackNoticeBindingIds: new Set<string>(),
    }),
  );

function getPluginBindingGlobalState(): PluginBindingGlobalState {
  return pluginBindingGlobalState;
}

function resolveApprovalsPath(): string {
  return expandHomePrefix(APPROVALS_PATH);
}

function normalizeChannel(value: string): string {
  return normalizeOptionalLowercaseString(value) ?? '';
}

function normalizeConversation(
  params: PluginBindingConversation,
): PluginBindingConversation {
  return {
    accountId: params.accountId.trim() || 'default',
    channel: normalizeChannel(params.channel),
    conversationId: params.conversationId.trim(),
    parentConversationId: normalizeOptionalString(params.parentConversationId),
    threadId:
      typeof params.threadId === 'number'
        ? Math.trunc(params.threadId)
        : normalizeOptionalString(params.threadId?.toString()),
  };
}

function toConversationRef(params: PluginBindingConversation): ConversationRef {
  const normalized = normalizeConversation(params);
  const channelId = normalizeChannelId(normalized.channel);
  const resolvedConversationRef = channelId
    ? getChannelPlugin(
        channelId,
      )?.conversationBindings?.resolveConversationRef?.({
        accountId: normalized.accountId,
        conversationId: normalized.conversationId,
        parentConversationId: normalized.parentConversationId,
        threadId: normalized.threadId,
      })
    : null;
  if (resolvedConversationRef?.conversationId?.trim()) {
    return {
      accountId: normalized.accountId,
      channel: normalized.channel,
      conversationId: resolvedConversationRef.conversationId.trim(),
      ...(resolvedConversationRef.parentConversationId?.trim()
        ? {
            parentConversationId:
              resolvedConversationRef.parentConversationId.trim(),
          }
        : {}),
    };
  }
  return {
    accountId: normalized.accountId,
    channel: normalized.channel,
    conversationId: normalized.conversationId,
    ...(normalized.parentConversationId
      ? { parentConversationId: normalized.parentConversationId }
      : {}),
  };
}

function buildApprovalScopeKey(params: {
  pluginRoot: string;
  channel: string;
  accountId: string;
}): string {
  return [
    params.pluginRoot,
    normalizeChannel(params.channel),
    params.accountId.trim() || 'default',
  ].join('::');
}

function buildPluginBindingSessionKey(params: {
  pluginId: string;
  channel: string;
  accountId: string;
  conversationId: string;
}): string {
  const hash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        accountId: params.accountId,
        channel: normalizeChannel(params.channel),
        conversationId: params.conversationId,
        pluginId: params.pluginId,
      }),
    )
    .digest('hex')
    .slice(0, 24);
  return `${PLUGIN_BINDING_SESSION_PREFIX}:${params.pluginId}:${hash}`;
}

function buildPluginBindingIdentity(
  params: PluginBindingIdentity,
): PluginBindingIdentity {
  return {
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    pluginRoot: params.pluginRoot,
  };
}

function logPluginBindingLifecycleEvent(params: {
  event:
    | 'migrating legacy record'
    | 'auto-refresh'
    | 'auto-approved'
    | 'requested'
    | 'detached'
    | 'denied'
    | 'approved';
  pluginId: string;
  pluginRoot: string;
  channel: string;
  accountId: string;
  conversationId: string;
  decision?: PluginBindingApprovalDecision;
}): void {
  const parts = [
    `plugin binding ${params.event}`,
    `plugin=${params.pluginId}`,
    `root=${params.pluginRoot}`,
    ...(params.decision ? [`decision=${params.decision}`] : []),
    `channel=${params.channel}`,
    `account=${params.accountId}`,
    `conversation=${params.conversationId}`,
  ];
  log.info(parts.join(' '));
}

function isLegacyPluginBindingRecord(params: {
  record:
    | {
        targetSessionKey: string;
        metadata?: Record<string, unknown>;
      }
    | null
    | undefined;
}): boolean {
  if (!params.record || isPluginOwnedBindingMetadata(params.record.metadata)) {
    return false;
  }
  const targetSessionKey = params.record.targetSessionKey.trim();
  return (
    targetSessionKey.startsWith(`${PLUGIN_BINDING_SESSION_PREFIX}:`) ||
    LEGACY_CODEX_PLUGIN_SESSION_PREFIXES.some((prefix) =>
      targetSessionKey.startsWith(prefix),
    )
  );
}

function buildApprovalInteractiveReply(
  approvalId: string,
): NonNullable<ReplyPayload['interactive']> {
  return {
    blocks: [
      {
        buttons: [
          {
            label: 'Allow once',
            style: 'success',
            value: buildPluginBindingApprovalCustomId(approvalId, 'allow-once'),
          },
          {
            label: 'Always allow',
            style: 'primary',
            value: buildPluginBindingApprovalCustomId(
              approvalId,
              'allow-always',
            ),
          },
          {
            label: 'Deny',
            style: 'danger',
            value: buildPluginBindingApprovalCustomId(approvalId, 'deny'),
          },
        ],
        type: 'buttons',
      },
    ],
  };
}

function createApprovalRequestId(): string {
  // Keep approval ids compact so Telegram callback_data stays under its 64-byte limit.
  return crypto.randomBytes(9).toString('base64url');
}

function loadApprovalsFromDisk(): PluginBindingApprovalsFile {
  const filePath = resolveApprovalsPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { approvals: [], version: 1 };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PluginBindingApprovalsFile>;
    if (!Array.isArray(parsed.approvals)) {
      return { approvals: [], version: 1 };
    }
    return {
      approvals: parsed.approvals
        .filter((entry): entry is PluginBindingApprovalEntry =>
          Boolean(entry && typeof entry === 'object'),
        )
        .map((entry) => ({
          accountId: normalizeOptionalString(entry.accountId) ?? 'default',
          approvedAt:
            typeof entry.approvedAt === 'number' &&
            Number.isFinite(entry.approvedAt)
              ? Math.floor(entry.approvedAt)
              : Date.now(),
          channel:
            typeof entry.channel === 'string'
              ? normalizeChannel(entry.channel)
              : '',
          pluginId: typeof entry.pluginId === 'string' ? entry.pluginId : '',
          pluginName:
            typeof entry.pluginName === 'string' ? entry.pluginName : undefined,
          pluginRoot:
            typeof entry.pluginRoot === 'string' ? entry.pluginRoot : '',
        }))
        .filter((entry) => entry.pluginRoot && entry.pluginId && entry.channel),
      version: 1,
    };
  } catch (error) {
    log.warn(`plugin binding approvals load failed: ${String(error)}`);
    return { approvals: [], version: 1 };
  }
}

async function saveApprovals(file: PluginBindingApprovalsFile): Promise<void> {
  const filePath = resolveApprovalsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const state = getPluginBindingGlobalState();
  state.approvalsCache = file;
  state.approvalsLoaded = true;
  await writeJsonAtomic(filePath, file, {
    mode: 0o600,
    trailingNewline: true,
  });
}

function getApprovals(): PluginBindingApprovalsFile {
  const state = getPluginBindingGlobalState();
  if (!state.approvalsLoaded || !state.approvalsCache) {
    state.approvalsCache = loadApprovalsFromDisk();
    state.approvalsLoaded = true;
  }
  return state.approvalsCache;
}

function hasPersistentApproval(params: {
  pluginRoot: string;
  channel: string;
  accountId: string;
}): boolean {
  const key = buildApprovalScopeKey(params);
  return getApprovals().approvals.some(
    (entry) =>
      buildApprovalScopeKey({
        accountId: entry.accountId,
        channel: entry.channel,
        pluginRoot: entry.pluginRoot,
      }) === key,
  );
}

async function addPersistentApproval(
  entry: PluginBindingApprovalEntry,
): Promise<void> {
  const file = getApprovals();
  const key = buildApprovalScopeKey(entry);
  const approvals = file.approvals.filter(
    (existing) =>
      buildApprovalScopeKey({
        accountId: existing.accountId,
        channel: existing.channel,
        pluginRoot: existing.pluginRoot,
      }) !== key,
  );
  approvals.push(entry);
  await saveApprovals({
    approvals,
    version: 1,
  });
}

function buildBindingMetadata(params: {
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  summary?: string;
  detachHint?: string;
}): PluginBindingMetadata {
  return {
    detachHint: normalizeOptionalString(params.detachHint),
    pluginBindingOwner: PLUGIN_BINDING_OWNER,
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    pluginRoot: params.pluginRoot,
    summary: normalizeOptionalString(params.summary),
  };
}

export function isPluginOwnedBindingMetadata(
  metadata: unknown,
): metadata is PluginBindingMetadata {
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }
  const record = metadata as Record<string, unknown>;
  return (
    record.pluginBindingOwner === PLUGIN_BINDING_OWNER &&
    typeof record.pluginId === 'string' &&
    typeof record.pluginRoot === 'string'
  );
}

export function isPluginOwnedSessionBindingRecord(
  record:
    | {
        metadata?: Record<string, unknown>;
      }
    | null
    | undefined,
): boolean {
  return isPluginOwnedBindingMetadata(record?.metadata);
}

export function toPluginConversationBinding(
  record:
    | {
        bindingId: string;
        conversation: ConversationRef;
        boundAt: number;
        metadata?: Record<string, unknown>;
      }
    | null
    | undefined,
): PluginConversationBinding | null {
  if (!record || !isPluginOwnedBindingMetadata(record.metadata)) {
    return null;
  }
  const { metadata } = record;
  return {
    accountId: record.conversation.accountId,
    bindingId: record.bindingId,
    boundAt: record.boundAt,
    channel: record.conversation.channel,
    conversationId: record.conversation.conversationId,
    detachHint: metadata.detachHint,
    parentConversationId: record.conversation.parentConversationId,
    pluginId: metadata.pluginId,
    pluginName: metadata.pluginName,
    pluginRoot: metadata.pluginRoot,
    summary: metadata.summary,
  };
}

function withConversationBindingContext(
  binding: PluginConversationBinding,
  conversation: PluginBindingConversation,
): PluginConversationBinding {
  return {
    ...binding,
    parentConversationId: conversation.parentConversationId,
    threadId: conversation.threadId,
  };
}

function resolvePluginConversationBindingState(params: {
  conversation: PluginBindingConversation;
}): PluginConversationBindingState {
  const ref = toConversationRef(params.conversation);
  const record = resolveConversationBindingRecord(ref);
  const binding = toPluginConversationBinding(record);
  return {
    binding,
    isLegacyForeignBinding: isLegacyPluginBindingRecord({ record }),
    record,
    ref,
  };
}

function resolveOwnedPluginConversationBinding(params: {
  pluginRoot: string;
  conversation: PluginBindingConversation;
}): PluginConversationBinding | null {
  const state = resolvePluginConversationBindingState({
    conversation: params.conversation,
  });
  if (!state.binding || state.binding.pluginRoot !== params.pluginRoot) {
    return null;
  }
  return withConversationBindingContext(state.binding, params.conversation);
}

function bindConversationFromIdentity(params: {
  identity: PluginBindingIdentity;
  conversation: PluginBindingConversation;
  summary?: string;
  detachHint?: string;
}): Promise<PluginConversationBinding> {
  return bindConversationNow({
    conversation: params.conversation,
    detachHint: params.detachHint,
    identity: buildPluginBindingIdentity(params.identity),
    summary: params.summary,
  });
}

function bindConversationFromRequest(
  request: Pick<
    PendingPluginBindingRequest,
    | 'pluginId'
    | 'pluginName'
    | 'pluginRoot'
    | 'conversation'
    | 'summary'
    | 'detachHint'
  >,
): Promise<PluginConversationBinding> {
  return bindConversationFromIdentity({
    conversation: request.conversation,
    detachHint: request.detachHint,
    identity: buildPluginBindingIdentity(request),
    summary: request.summary,
  });
}

function buildApprovalEntryFromRequest(
  request: Pick<
    PendingPluginBindingRequest,
    'pluginRoot' | 'pluginId' | 'pluginName' | 'conversation'
  >,
  approvedAt = Date.now(),
): PluginBindingApprovalEntry {
  return {
    accountId: request.conversation.accountId,
    approvedAt,
    channel: request.conversation.channel,
    pluginId: request.pluginId,
    pluginName: request.pluginName,
    pluginRoot: request.pluginRoot,
  };
}

async function bindConversationNow(params: {
  identity: PluginBindingIdentity;
  conversation: PluginBindingConversation;
  summary?: string;
  detachHint?: string;
}): Promise<PluginConversationBinding> {
  const ref = toConversationRef(params.conversation);
  const targetSessionKey = buildPluginBindingSessionKey({
    accountId: ref.accountId,
    channel: ref.channel,
    conversationId: ref.conversationId,
    pluginId: params.identity.pluginId,
  });
  const record = await createConversationBindingRecord({
    conversation: ref,
    metadata: buildBindingMetadata({
      detachHint: params.detachHint,
      pluginId: params.identity.pluginId,
      pluginName: params.identity.pluginName,
      pluginRoot: params.identity.pluginRoot,
      summary: params.summary,
    }) as unknown as Record<string, unknown>,
    placement: 'current',
    targetKind: 'session',
    targetSessionKey,
  });
  const binding = toPluginConversationBinding(record);
  if (!binding) {
    throw new Error('plugin binding was created without plugin metadata');
  }
  return withConversationBindingContext(binding, params.conversation);
}

function buildApprovalMessage(request: PendingPluginBindingRequest): string {
  const lines = [
    `Plugin bind approval required`,
    `Plugin: ${request.pluginName ?? request.pluginId}`,
    `Channel: ${request.conversation.channel}`,
    `Account: ${request.conversation.accountId}`,
  ];
  if (request.summary?.trim()) {
    lines.push(`Request: ${request.summary.trim()}`);
  } else {
    lines.push(
      'Request: Bind this conversation so future plain messages route to the plugin.',
    );
  }
  lines.push(
    'Choose whether to allow this plugin to bind the current conversation.',
  );
  return lines.join('\n');
}

function resolvePluginBindingDisplayName(binding: {
  pluginId: string;
  pluginName?: string;
}): string {
  return normalizeOptionalString(binding.pluginName) || binding.pluginId;
}

function buildDetachHintSuffix(detachHint?: string): string {
  const trimmed = detachHint?.trim();
  return trimmed ? ` To detach this conversation, use ${trimmed}.` : '';
}

export function buildPluginBindingUnavailableText(
  binding: PluginConversationBinding,
): string {
  return `The bound plugin ${resolvePluginBindingDisplayName(binding)} is not currently loaded. Routing this message to OpenClaw instead.${buildDetachHintSuffix(binding.detachHint)}`;
}

export function buildPluginBindingDeclinedText(
  binding: PluginConversationBinding,
): string {
  return `The bound plugin ${resolvePluginBindingDisplayName(binding)} did not handle this message. This conversation is still bound to that plugin.${buildDetachHintSuffix(binding.detachHint)}`;
}

export function buildPluginBindingErrorText(
  binding: PluginConversationBinding,
): string {
  return `The bound plugin ${resolvePluginBindingDisplayName(binding)} hit an error handling this message. This conversation is still bound to that plugin.${buildDetachHintSuffix(binding.detachHint)}`;
}

export function hasShownPluginBindingFallbackNotice(
  bindingId: string,
): boolean {
  const normalized = bindingId.trim();
  if (!normalized) {
    return false;
  }
  return getPluginBindingGlobalState().fallbackNoticeBindingIds.has(normalized);
}

export function markPluginBindingFallbackNoticeShown(bindingId: string): void {
  const normalized = bindingId.trim();
  if (!normalized) {
    return;
  }
  getPluginBindingGlobalState().fallbackNoticeBindingIds.add(normalized);
}

function buildPendingReply(request: PendingPluginBindingRequest): ReplyPayload {
  return {
    interactive: buildApprovalInteractiveReply(request.id),
    text: buildApprovalMessage(request),
  };
}

function encodeCustomIdValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeCustomIdValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildPluginBindingApprovalCustomId(
  approvalId: string,
  decision: PluginBindingApprovalDecision,
): string {
  const decisionCode =
    decision === 'allow-once' ? 'o' : decision === 'allow-always' ? 'a' : 'd';
  return `${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:${encodeCustomIdValue(approvalId)}:${decisionCode}`;
}

export function parsePluginBindingApprovalCustomId(
  value: string,
): PluginBindingApprovalAction | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(`${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:`)) {
    return null;
  }
  const body = trimmed.slice(`${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:`.length);
  const separator = body.lastIndexOf(':');
  if (separator <= 0 || separator === body.length - 1) {
    return null;
  }
  const rawId = body.slice(0, separator).trim();
  const rawDecisionCode = body.slice(separator + 1).trim();
  if (!rawId) {
    return null;
  }
  const rawDecision =
    rawDecisionCode === 'o'
      ? 'allow-once'
      : rawDecisionCode === 'a'
        ? 'allow-always'
        : rawDecisionCode === 'd'
          ? 'deny'
          : null;
  if (!rawDecision) {
    return null;
  }
  return {
    approvalId: decodeCustomIdValue(rawId),
    decision: rawDecision,
  };
}

export async function requestPluginConversationBinding(params: {
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  conversation: PluginBindingConversation;
  requestedBySenderId?: string;
  binding: PluginConversationBindingRequestParams | undefined;
}): Promise<PluginConversationBindingRequestResult> {
  const conversation = normalizeConversation(params.conversation);
  const state = resolvePluginConversationBindingState({
    conversation,
  });
  if (state.record && !state.binding) {
    if (state.isLegacyForeignBinding) {
      logPluginBindingLifecycleEvent({
        accountId: state.ref.accountId,
        channel: state.ref.channel,
        conversationId: state.ref.conversationId,
        event: 'migrating legacy record',
        pluginId: params.pluginId,
        pluginRoot: params.pluginRoot,
      });
    } else {
      return {
        message:
          'This conversation is already bound by core routing and cannot be claimed by a plugin.',
        status: 'error',
      };
    }
  }
  if (state.binding && state.binding.pluginRoot !== params.pluginRoot) {
    return {
      message: `This conversation is already bound by plugin "${state.binding.pluginName ?? state.binding.pluginId}".`,
      status: 'error',
    };
  }

  if (state.binding && state.binding.pluginRoot === params.pluginRoot) {
    const rebound = await bindConversationFromIdentity({
      conversation,
      detachHint: params.binding?.detachHint,
      identity: buildPluginBindingIdentity(params),
      summary: params.binding?.summary,
    });
    logPluginBindingLifecycleEvent({
      accountId: state.ref.accountId,
      channel: state.ref.channel,
      conversationId: state.ref.conversationId,
      event: 'auto-refresh',
      pluginId: params.pluginId,
      pluginRoot: params.pluginRoot,
    });
    return { binding: rebound, status: 'bound' };
  }

  if (
    hasPersistentApproval({
      accountId: state.ref.accountId,
      channel: state.ref.channel,
      pluginRoot: params.pluginRoot,
    })
  ) {
    const bound = await bindConversationFromIdentity({
      conversation,
      detachHint: params.binding?.detachHint,
      identity: buildPluginBindingIdentity(params),
      summary: params.binding?.summary,
    });
    logPluginBindingLifecycleEvent({
      accountId: state.ref.accountId,
      channel: state.ref.channel,
      conversationId: state.ref.conversationId,
      event: 'auto-approved',
      pluginId: params.pluginId,
      pluginRoot: params.pluginRoot,
    });
    return { binding: bound, status: 'bound' };
  }

  const request: PendingPluginBindingRequest = {
    conversation,
    detachHint: normalizeOptionalString(params.binding?.detachHint),
    id: createApprovalRequestId(),
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    pluginRoot: params.pluginRoot,
    requestedAt: Date.now(),
    requestedBySenderId: normalizeOptionalString(params.requestedBySenderId),
    summary: normalizeOptionalString(params.binding?.summary),
  };
  pendingRequests.set(request.id, request);
  logPluginBindingLifecycleEvent({
    accountId: state.ref.accountId,
    channel: state.ref.channel,
    conversationId: state.ref.conversationId,
    event: 'requested',
    pluginId: params.pluginId,
    pluginRoot: params.pluginRoot,
  });
  return {
    approvalId: request.id,
    reply: buildPendingReply(request),
    status: 'pending',
  };
}

export async function getCurrentPluginConversationBinding(params: {
  pluginRoot: string;
  conversation: PluginBindingConversation;
}): Promise<PluginConversationBinding | null> {
  return resolveOwnedPluginConversationBinding(params);
}

export async function detachPluginConversationBinding(params: {
  pluginRoot: string;
  conversation: PluginBindingConversation;
}): Promise<{ removed: boolean }> {
  const binding = resolveOwnedPluginConversationBinding(params);
  if (!binding) {
    return { removed: false };
  }
  await unbindConversationBindingRecord({
    bindingId: binding.bindingId,
    reason: 'plugin-detach',
  });
  logPluginBindingLifecycleEvent({
    accountId: binding.accountId,
    channel: binding.channel,
    conversationId: binding.conversationId,
    event: 'detached',
    pluginId: binding.pluginId,
    pluginRoot: binding.pluginRoot,
  });
  return { removed: true };
}

export async function resolvePluginConversationBindingApproval(params: {
  approvalId: string;
  decision: PluginBindingApprovalDecision;
  senderId?: string;
}): Promise<PluginBindingResolveResult> {
  const request = pendingRequests.get(params.approvalId);
  if (!request) {
    return { status: 'expired' };
  }
  if (
    request.requestedBySenderId &&
    params.senderId?.trim() &&
    request.requestedBySenderId !== params.senderId.trim()
  ) {
    return { status: 'expired' };
  }
  pendingRequests.delete(params.approvalId);
  if (params.decision === 'deny') {
    dispatchPluginConversationBindingResolved({
      decision: 'deny',
      request,
      status: 'denied',
    });
    logPluginBindingLifecycleEvent({
      accountId: request.conversation.accountId,
      channel: request.conversation.channel,
      conversationId: request.conversation.conversationId,
      event: 'denied',
      pluginId: request.pluginId,
      pluginRoot: request.pluginRoot,
    });
    return { request, status: 'denied' };
  }
  if (params.decision === 'allow-always') {
    await addPersistentApproval(buildApprovalEntryFromRequest(request));
  }
  const binding = await bindConversationFromRequest(request);
  logPluginBindingLifecycleEvent({
    accountId: request.conversation.accountId,
    channel: request.conversation.channel,
    conversationId: request.conversation.conversationId,
    decision: params.decision,
    event: 'approved',
    pluginId: request.pluginId,
    pluginRoot: request.pluginRoot,
  });
  dispatchPluginConversationBindingResolved({
    binding,
    decision: params.decision,
    request,
    status: 'approved',
  });
  return {
    binding,
    decision: params.decision,
    request,
    status: 'approved',
  };
}

function dispatchPluginConversationBindingResolved(params: {
  status: 'approved' | 'denied';
  binding?: PluginConversationBinding;
  decision: PluginConversationBindingResolutionDecision;
  request: PendingPluginBindingRequest;
}): void {
  // Keep platform interaction acks fast even if the plugin does slow post-bind work.
  queueMicrotask(() => {
    void notifyPluginConversationBindingResolved(params).catch((error) => {
      log.warn(`plugin binding resolved dispatch failed: ${String(error)}`);
    });
  });
}

async function notifyPluginConversationBindingResolved(params: {
  status: 'approved' | 'denied';
  binding?: PluginConversationBinding;
  decision: PluginConversationBindingResolutionDecision;
  request: PendingPluginBindingRequest;
}): Promise<void> {
  const registrations =
    getActivePluginRegistry()?.conversationBindingResolvedHandlers ?? [];
  for (const registration of registrations) {
    if (registration.pluginId !== params.request.pluginId) {
      continue;
    }
    const registeredRoot = registration.pluginRoot?.trim();
    if (registeredRoot && registeredRoot !== params.request.pluginRoot) {
      continue;
    }
    try {
      const event: PluginConversationBindingResolvedEvent = {
        binding: params.binding,
        decision: params.decision,
        request: {
          conversation: params.request.conversation,
          detachHint: params.request.detachHint,
          requestedBySenderId: params.request.requestedBySenderId,
          summary: params.request.summary,
        },
        status: params.status,
      };
      await registration.handler(event);
    } catch (error) {
      log.warn(
        `plugin binding resolved callback failed plugin=${registration.pluginId} root=${registration.pluginRoot ?? '<none>'}: ${formatErrorMessage(error)}`,
      );
    }
  }
}

export function buildPluginBindingResolvedText(
  params: PluginBindingResolveResult,
): string {
  if (params.status === 'expired') {
    return 'That plugin bind approval expired. Retry the bind command.';
  }
  if (params.status === 'denied') {
    return `Denied plugin bind request for ${params.request.pluginName ?? params.request.pluginId}.`;
  }
  const summarySuffix = params.request.summary?.trim()
    ? ` ${params.request.summary.trim()}`
    : '';
  if (params.decision === 'allow-always') {
    return `Allowed ${params.request.pluginName ?? params.request.pluginId} to bind this conversation.${summarySuffix}`;
  }
  return `Allowed ${params.request.pluginName ?? params.request.pluginId} to bind this conversation once.${summarySuffix}`;
}

export const __testing = {
  reset() {
    pendingRequests.clear();
    const state = getPluginBindingGlobalState();
    state.approvalsCache = null;
    state.approvalsLoaded = false;
    state.fallbackNoticeBindingIds.clear();
  },
};
