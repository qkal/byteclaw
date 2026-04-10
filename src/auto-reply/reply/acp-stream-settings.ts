import type { AcpSessionUpdateTag } from "../../acp/runtime/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { clampPositiveInteger, resolveEffectiveBlockStreamingConfig } from "./block-streaming.js";

const DEFAULT_ACP_STREAM_COALESCE_IDLE_MS = 350;
const DEFAULT_ACP_STREAM_MAX_CHUNK_CHARS = 1800;
const DEFAULT_ACP_REPEAT_SUPPRESSION = true;
const DEFAULT_ACP_DELIVERY_MODE = "final_only";
const DEFAULT_ACP_HIDDEN_BOUNDARY_SEPARATOR = "paragraph";
const DEFAULT_ACP_HIDDEN_BOUNDARY_SEPARATOR_LIVE = "space";
const DEFAULT_ACP_MAX_OUTPUT_CHARS = 24_000;
const DEFAULT_ACP_MAX_SESSION_UPDATE_CHARS = 320;

export const ACP_TAG_VISIBILITY_DEFAULTS: Record<AcpSessionUpdateTag, boolean> = {
  agent_message_chunk: true,
  agent_thought_chunk: false,
  available_commands_update: false,
  config_option_update: false,
  current_mode_update: false,
  plan: false,
  session_info_update: false,
  tool_call: false,
  tool_call_update: false,
  usage_update: false,
};

export type AcpDeliveryMode = "live" | "final_only";
export type AcpHiddenBoundarySeparator = "none" | "space" | "newline" | "paragraph";

export interface AcpProjectionSettings {
  deliveryMode: AcpDeliveryMode;
  hiddenBoundarySeparator: AcpHiddenBoundarySeparator;
  repeatSuppression: boolean;
  maxOutputChars: number;
  maxSessionUpdateChars: number;
  tagVisibility: Partial<Record<AcpSessionUpdateTag, boolean>>;
}

function clampBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolveAcpDeliveryMode(value: unknown): AcpDeliveryMode {
  if (value === "live" || value === "final_only") {
    return value;
  }
  return DEFAULT_ACP_DELIVERY_MODE;
}

function resolveAcpHiddenBoundarySeparator(
  value: unknown,
  fallback: AcpHiddenBoundarySeparator,
): AcpHiddenBoundarySeparator {
  if (value === "none" || value === "space" || value === "newline" || value === "paragraph") {
    return value;
  }
  return fallback;
}

function resolveAcpStreamCoalesceIdleMs(cfg: OpenClawConfig): number {
  return clampPositiveInteger(
    cfg.acp?.stream?.coalesceIdleMs,
    DEFAULT_ACP_STREAM_COALESCE_IDLE_MS,
    {
      max: 5000,
      min: 0,
    },
  );
}

function resolveAcpStreamMaxChunkChars(cfg: OpenClawConfig): number {
  return clampPositiveInteger(cfg.acp?.stream?.maxChunkChars, DEFAULT_ACP_STREAM_MAX_CHUNK_CHARS, {
    max: 4000,
    min: 50,
  });
}

export function resolveAcpProjectionSettings(cfg: OpenClawConfig): AcpProjectionSettings {
  const stream = cfg.acp?.stream;
  const deliveryMode = resolveAcpDeliveryMode(stream?.deliveryMode);
  const hiddenBoundaryFallback: AcpHiddenBoundarySeparator =
    deliveryMode === "live"
      ? DEFAULT_ACP_HIDDEN_BOUNDARY_SEPARATOR_LIVE
      : DEFAULT_ACP_HIDDEN_BOUNDARY_SEPARATOR;
  return {
    deliveryMode,
    hiddenBoundarySeparator: resolveAcpHiddenBoundarySeparator(
      stream?.hiddenBoundarySeparator,
      hiddenBoundaryFallback,
    ),
    maxOutputChars: clampPositiveInteger(stream?.maxOutputChars, DEFAULT_ACP_MAX_OUTPUT_CHARS, {
      max: 500_000,
      min: 1,
    }),
    maxSessionUpdateChars: clampPositiveInteger(
      stream?.maxSessionUpdateChars,
      DEFAULT_ACP_MAX_SESSION_UPDATE_CHARS,
      {
        max: 8_000,
        min: 64,
      },
    ),
    repeatSuppression: clampBoolean(stream?.repeatSuppression, DEFAULT_ACP_REPEAT_SUPPRESSION),
    tagVisibility: stream?.tagVisibility ?? {},
  };
}

export function resolveAcpStreamingConfig(params: {
  cfg: OpenClawConfig;
  provider?: string;
  accountId?: string;
  deliveryMode?: AcpDeliveryMode;
}) {
  const resolved = resolveEffectiveBlockStreamingConfig({
    accountId: params.accountId,
    cfg: params.cfg,
    coalesceIdleMs: resolveAcpStreamCoalesceIdleMs(params.cfg),
    maxChunkChars: resolveAcpStreamMaxChunkChars(params.cfg),
    provider: params.provider,
  });

  // In live mode, ACP text deltas should flush promptly and never be held
  // Behind large generic min-char thresholds.
  if (params.deliveryMode === "live") {
    return {
      chunking: {
        ...resolved.chunking,
        minChars: 1,
      },
      coalescing: {
        ...resolved.coalescing,
        minChars: 1,
        // ACP delta streams already carry spacing/newlines; preserve exact text.
        joiner: "",
      },
    };
  }

  return resolved;
}

export function isAcpTagVisible(
  settings: AcpProjectionSettings,
  tag: AcpSessionUpdateTag | undefined,
): boolean {
  if (!tag) {
    return true;
  }
  const override = settings.tagVisibility[tag];
  if (typeof override === "boolean") {
    return override;
  }
  if (Object.hasOwn(ACP_TAG_VISIBILITY_DEFAULTS, tag)) {
    return ACP_TAG_VISIBILITY_DEFAULTS[tag];
  }
  return true;
}
