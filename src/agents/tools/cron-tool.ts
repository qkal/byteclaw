import { type TSchema, Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import type { CronDelivery, CronMessageChannel } from "../../cron/types.js";
import { normalizeHttpWebhookUrl } from "../../cron/webhook-url.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";
import { isRecord, truncateUtf16Safe } from "../../utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { CRON_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { type GatewayCallOptions, callGatewayTool, readGatewayCallOptions } from "./gateway.js";
import { isOpenClawOwnerOnlyCoreToolName } from "./owner-only-tools.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

// We spell out job/patch properties so that LLMs know what fields to send.
// Nested unions are avoided; runtime validation happens in normalizeCronJob*.

const CRON_ACTIONS = ["status", "list", "add", "update", "remove", "run", "runs", "wake"] as const;

const CRON_SCHEDULE_KINDS = ["at", "every", "cron"] as const;
const CRON_WAKE_MODES = ["now", "next-heartbeat"] as const;
const CRON_PAYLOAD_KINDS = ["systemEvent", "agentTurn"] as const;
const CRON_DELIVERY_MODES = ["none", "announce", "webhook"] as const;
const CRON_RUN_MODES = ["due", "force"] as const;
const CRON_FLAT_PAYLOAD_KEYS = [
  "message",
  "text",
  "model",
  "fallbacks",
  "toolsAllow",
  "thinking",
  "timeoutSeconds",
  "lightContext",
  "allowUnsafeExternalContent",
] as const;
const CRON_RECOVERABLE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "schedule",
  "sessionTarget",
  "wakeMode",
  "payload",
  "delivery",
  "enabled",
  "description",
  "deleteAfterRun",
  "agentId",
  "sessionKey",
  "failureAlert",
  ...CRON_FLAT_PAYLOAD_KEYS,
]);

const REMINDER_CONTEXT_MESSAGES_MAX = 10;
const REMINDER_CONTEXT_PER_MESSAGE_MAX = 220;
const REMINDER_CONTEXT_TOTAL_MAX = 700;
const REMINDER_CONTEXT_MARKER = "\n\nRecent context:\n";

function nullableStringSchema(description: string) {
  return Type.Optional(Type.String({ description }));
}

function nullableStringArraySchema(description: string) {
  return Type.Optional(Type.Array(Type.String(), { description }));
}

function cronPayloadObjectSchema(params: { toolsAllow: TSchema }) {
  return Type.Object(
    {
      allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
      fallbacks: Type.Optional(Type.Array(Type.String(), { description: "Fallback model ids" })),
      kind: optionalStringEnum(CRON_PAYLOAD_KINDS, { description: "Payload type" }),
      lightContext: Type.Optional(Type.Boolean()),
      message: Type.Optional(Type.String({ description: "Agent prompt (kind=agentTurn)" })),
      model: Type.Optional(Type.String({ description: "Model override" })),
      text: Type.Optional(Type.String({ description: "Message text (kind=systemEvent)" })),
      thinking: Type.Optional(Type.String({ description: "Thinking level override" })),
      timeoutSeconds: Type.Optional(Type.Number()),
      toolsAllow: params.toolsAllow,
    },
    { additionalProperties: true },
  );
}

const CronScheduleSchema = Type.Optional(
  Type.Object(
    {
      anchorMs: Type.Optional(
        Type.Number({ description: "Optional start anchor in milliseconds (kind=every)" }),
      ),
      at: Type.Optional(Type.String({ description: "ISO-8601 timestamp (kind=at)" })),
      everyMs: Type.Optional(Type.Number({ description: "Interval in milliseconds (kind=every)" })),
      expr: Type.Optional(Type.String({ description: "Cron expression (kind=cron)" })),
      kind: optionalStringEnum(CRON_SCHEDULE_KINDS, { description: "Schedule type" }),
      staggerMs: Type.Optional(Type.Number({ description: "Random jitter in ms (kind=cron)" })),
      tz: Type.Optional(Type.String({ description: "IANA timezone (kind=cron)" })),
    },
    { additionalProperties: true },
  ),
);

const CronPayloadSchema = Type.Optional(
  cronPayloadObjectSchema({
    toolsAllow: Type.Optional(Type.Array(Type.String(), { description: "Allowed tool ids" })),
  }),
);

const CronDeliverySchema = Type.Optional(
  Type.Object(
    {
      accountId: Type.Optional(Type.String({ description: "Account target for delivery" })),
      bestEffort: Type.Optional(Type.Boolean()),
      channel: Type.Optional(Type.String({ description: "Delivery channel" })),
      failureDestination: Type.Optional(
        Type.Object(
          {
            accountId: Type.Optional(Type.String()),
            channel: Type.Optional(Type.String()),
            mode: optionalStringEnum(["announce", "webhook"] as const),
            to: Type.Optional(Type.String()),
          },
          { additionalProperties: true },
        ),
      ),
      mode: optionalStringEnum(CRON_DELIVERY_MODES, { description: "Delivery mode" }),
      to: Type.Optional(Type.String({ description: "Delivery target" })),
    },
    { additionalProperties: true },
  ),
);

// Omitting `failureAlert` means "leave defaults/unchanged"; `false` explicitly disables alerts.
// Runtime handles `failureAlert === false` in cron/service/timer.ts.
// The schema declares `type: "object"` to stay compatible with providers that
// Enforce an OpenAPI 3.0 subset (e.g. Gemini via GitHub Copilot).  The
// Description tells the LLM that `false` is also accepted.
const CronFailureAlertSchema = Type.Optional(
  Type.Unsafe<Record<string, unknown> | false>({
    additionalProperties: true,
    description:
      "Failure alert config object, or the boolean value false to disable alerts for this job",
    properties: {
      accountId: Type.Optional(Type.String()),
      after: Type.Optional(Type.Number({ description: "Failures before alerting" })),
      channel: Type.Optional(Type.String({ description: "Alert channel" })),
      cooldownMs: Type.Optional(Type.Number({ description: "Cooldown between alerts in ms" })),
      mode: optionalStringEnum(["announce", "webhook"] as const),
      to: Type.Optional(Type.String({ description: "Alert target" })),
    },
    type: "object",
  }),
);

const CronJobObjectSchema = Type.Optional(
  Type.Object(
    {
      agentId: nullableStringSchema("Agent id, or null to keep it unset"),
      deleteAfterRun: Type.Optional(Type.Boolean({ description: "Delete after first execution" })),
      delivery: CronDeliverySchema,
      description: Type.Optional(Type.String({ description: "Human-readable description" })),
      enabled: Type.Optional(Type.Boolean()),
      failureAlert: CronFailureAlertSchema,
      name: Type.Optional(Type.String({ description: "Job name" })),
      payload: CronPayloadSchema,
      schedule: CronScheduleSchema,
      sessionKey: nullableStringSchema("Explicit session key, or null to clear it"),
      sessionTarget: Type.Optional(
        Type.String({
          description: 'Session target: "main", "isolated", "current", or "session:<id>"',
        }),
      ),
      wakeMode: optionalStringEnum(CRON_WAKE_MODES, { description: "When to wake the session" }),
    },
    { additionalProperties: true },
  ),
);

const CronPatchObjectSchema = Type.Optional(
  Type.Object(
    {
      agentId: nullableStringSchema("Agent id, or null to clear it"),
      deleteAfterRun: Type.Optional(Type.Boolean()),
      delivery: CronDeliverySchema,
      description: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
      failureAlert: CronFailureAlertSchema,
      name: Type.Optional(Type.String({ description: "Job name" })),
      payload: Type.Optional(
        cronPayloadObjectSchema({
          toolsAllow: nullableStringArraySchema("Allowed tool ids, or null to clear"),
        }),
      ),
      schedule: CronScheduleSchema,
      sessionKey: nullableStringSchema("Explicit session key, or null to clear it"),
      sessionTarget: Type.Optional(Type.String({ description: "Session target" })),
      wakeMode: optionalStringEnum(CRON_WAKE_MODES),
    },
    { additionalProperties: true },
  ),
);

// Flattened schema: runtime validates per-action requirements.
export const CronToolSchema = Type.Object(
  {
    action: stringEnum(CRON_ACTIONS),
    contextMessages: Type.Optional(
      Type.Number({ maximum: REMINDER_CONTEXT_MESSAGES_MAX, minimum: 0 }),
    ),
    gatewayToken: Type.Optional(Type.String()),
    gatewayUrl: Type.Optional(Type.String()),
    id: Type.Optional(Type.String()),
    includeDisabled: Type.Optional(Type.Boolean()),
    job: CronJobObjectSchema,
    jobId: Type.Optional(Type.String()),
    mode: optionalStringEnum(CRON_WAKE_MODES),
    patch: CronPatchObjectSchema,
    runMode: optionalStringEnum(CRON_RUN_MODES),
    text: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

interface CronToolOptions {
  agentSessionKey?: string;
}

type GatewayToolCaller = typeof callGatewayTool;

interface CronToolDeps {
  callGatewayTool?: GatewayToolCaller;
}

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

function stripExistingContext(text: string) {
  const index = text.indexOf(REMINDER_CONTEXT_MARKER);
  if (index === -1) {
    return text;
  }
  return text.slice(0, index).trim();
}

function truncateText(input: string, maxLen: number) {
  if (input.length <= maxLen) {
    return input;
  }
  const truncated = truncateUtf16Safe(input, Math.max(0, maxLen - 3)).trimEnd();
  return `${truncated}...`;
}

function extractMessageText(message: ChatMessage): { role: string; text: string } | null {
  const role = typeof message.role === "string" ? message.role : "";
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const text = extractTextFromChatContent(message.content);
  return text ? { role, text } : null;
}

async function buildReminderContextLines(params: {
  agentSessionKey?: string;
  gatewayOpts: GatewayCallOptions;
  contextMessages: number;
  callGatewayTool: GatewayToolCaller;
}) {
  const maxMessages = Math.min(
    REMINDER_CONTEXT_MESSAGES_MAX,
    Math.max(0, Math.floor(params.contextMessages)),
  );
  if (maxMessages <= 0) {
    return [];
  }
  const sessionKey = params.agentSessionKey?.trim();
  if (!sessionKey) {
    return [];
  }
  const cfg = loadConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const resolvedKey = resolveInternalSessionKey({ alias, key: sessionKey, mainKey });
  try {
    const res = await params.callGatewayTool<{ messages: unknown[] }>(
      "chat.history",
      params.gatewayOpts,
      {
        limit: maxMessages,
        sessionKey: resolvedKey,
      },
    );
    const messages = Array.isArray(res?.messages) ? res.messages : [];
    const parsed = messages
      .map((msg) => extractMessageText(msg as ChatMessage))
      .filter((msg): msg is { role: string; text: string } => Boolean(msg));
    const recent = parsed.slice(-maxMessages);
    if (recent.length === 0) {
      return [];
    }
    const lines: string[] = [];
    let total = 0;
    for (const entry of recent) {
      const label = entry.role === "user" ? "User" : "Assistant";
      const text = truncateText(entry.text, REMINDER_CONTEXT_PER_MESSAGE_MAX);
      const line = `- ${label}: ${text}`;
      total += line.length;
      if (total > REMINDER_CONTEXT_TOTAL_MAX) {
        break;
      }
      lines.push(line);
    }
    return lines;
  } catch {
    return [];
  }
}

function stripThreadSuffixFromSessionKey(sessionKey: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  const idx = normalized.lastIndexOf(":thread:");
  if (idx <= 0) {
    return sessionKey;
  }
  const parent = sessionKey.slice(0, idx).trim();
  return parent ? parent : sessionKey;
}

function inferDeliveryFromSessionKey(agentSessionKey?: string): CronDelivery | null {
  const rawSessionKey = agentSessionKey?.trim();
  if (!rawSessionKey) {
    return null;
  }
  const parsed = parseAgentSessionKey(stripThreadSuffixFromSessionKey(rawSessionKey));
  if (!parsed || !parsed.rest) {
    return null;
  }
  const parts = parsed.rest.split(":").filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const head = normalizeOptionalLowercaseString(parts[0]);
  if (!head || head === "main" || head === "subagent" || head === "acp") {
    return null;
  }

  // BuildAgentPeerSessionKey encodes peers as:
  // - direct:<peerId>
  // - <channel>:direct:<peerId>
  // - <channel>:<accountId>:direct:<peerId>
  // - <channel>:group:<peerId>
  // - <channel>:channel:<peerId>
  // Note: legacy keys may use "dm" instead of "direct".
  // Threaded sessions append :thread:<id>, which we strip so delivery targets the parent peer.
  // NOTE: Telegram forum topics encode as <chatId>:topic:<topicId> and should be preserved.
  const markerIndex = parts.findIndex(
    (part) => part === "direct" || part === "dm" || part === "group" || part === "channel",
  );
  if (markerIndex === -1) {
    return null;
  }
  const peerId = parts
    .slice(markerIndex + 1)
    .join(":")
    .trim();
  if (!peerId) {
    return null;
  }

  let channel: CronMessageChannel | undefined;
  if (markerIndex >= 1) {
    channel = normalizeOptionalLowercaseString(parts[0]) as CronMessageChannel | undefined;
  }

  const delivery: CronDelivery = { mode: "announce", to: peerId };
  if (channel) {
    delivery.channel = channel;
  }
  return delivery;
}

export function createCronTool(opts?: CronToolOptions, deps?: CronToolDeps): AnyAgentTool {
  const callGateway = deps?.callGatewayTool ?? callGatewayTool;
  return {
    description: `Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and send wake events. Use this for reminders, "check back later" requests, delayed follow-ups, and recurring tasks. Do not emulate scheduling with exec sleep or process polling.

Main-session cron jobs enqueue system events for heartbeat handling. Isolated cron jobs create background task runs that appear in \`openclaw tasks\`.

ACTIONS:
- status: Check cron scheduler status
- list: List jobs (use includeDisabled:true to include disabled)
- add: Create job (requires job object, see schema below)
- update: Modify job (requires jobId + patch object)
- remove: Delete job (requires jobId)
- run: Trigger job immediately (requires jobId)
- runs: Get job run history (requires jobId)
- wake: Send wake event (requires text, optional mode)

JOB SCHEMA (for add action):
{
  "name": "string (optional)",
  "schedule": { ... },      // Required: when to run
  "payload": { ... },       // Required: what to execute
  "delivery": { ... },      // Optional: announce summary (isolated/current/session:xxx only) or webhook POST
  "sessionTarget": "main" | "isolated" | "current" | "session:<custom-id>",  // Optional, defaults based on context
  "enabled": true | false   // Optional, default true
}

SESSION TARGET OPTIONS:
- "main": Run in the main session (requires payload.kind="systemEvent")
- "isolated": Run in an ephemeral isolated session (requires payload.kind="agentTurn")
- "current": Bind to the current session where the cron is created (resolved at creation time)
- "session:<custom-id>": Run in a persistent named session (e.g., "session:project-alpha-daily")

DEFAULT BEHAVIOR (unchanged for backward compatibility):
- payload.kind="systemEvent" → defaults to "main"
- payload.kind="agentTurn" → defaults to "isolated"
To use current session binding, explicitly set sessionTarget="current".

SCHEDULE TYPES (schedule.kind):
- "at": One-shot at absolute time
  { "kind": "at", "at": "<ISO-8601 timestamp>" }
- "every": Recurring interval
  { "kind": "every", "everyMs": <interval-ms>, "anchorMs": <optional-start-ms> }
- "cron": Cron expression
  { "kind": "cron", "expr": "<cron-expression>", "tz": "<optional-timezone>" }

ISO timestamps without an explicit timezone are treated as UTC.

PAYLOAD TYPES (payload.kind):
- "systemEvent": Injects text as system event into session
  { "kind": "systemEvent", "text": "<message>" }
- "agentTurn": Runs agent with message (isolated sessions only)
  { "kind": "agentTurn", "message": "<prompt>", "model": "<optional>", "thinking": "<optional>", "timeoutSeconds": <optional, 0 means no timeout> }

DELIVERY (top-level):
  { "mode": "none|announce|webhook", "channel": "<optional>", "to": "<optional>", "bestEffort": <optional-bool> }
  - Default for isolated agentTurn jobs (when delivery omitted): "announce"
  - announce: send to chat channel (optional channel/to target)
  - webhook: send finished-run event as HTTP POST to delivery.to (URL required)
  - If the task needs to send to a specific chat/recipient, set announce delivery.channel/to; do not call messaging tools inside the run.

CRITICAL CONSTRAINTS:
- sessionTarget="main" REQUIRES payload.kind="systemEvent"
- sessionTarget="isolated" | "current" | "session:xxx" REQUIRES payload.kind="agentTurn"
- For webhook callbacks, use delivery.mode="webhook" with delivery.to set to a URL.
Default: prefer isolated agentTurn jobs unless the user explicitly wants current-session binding.

WAKE MODES (for wake action):
- "next-heartbeat" (default): Wake on next heartbeat
- "now": Wake immediately

Use jobId as the canonical identifier; id is accepted for compatibility. Use contextMessages (0-10) to add previous messages as context to the job text.`,
    displaySummary: CRON_TOOL_DISPLAY_SUMMARY,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        ...readGatewayCallOptions(params),
        timeoutMs:
          typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
            ? params.timeoutMs
            : 60_000,
      };

      switch (action) {
        case "status": {
          return jsonResult(await callGateway("cron.status", gatewayOpts, {}));
        }
        case "list": {
          return jsonResult(
            await callGateway("cron.list", gatewayOpts, {
              includeDisabled: Boolean(params.includeDisabled),
            }),
          );
        }
        case "add": {
          // Flat-params recovery: non-frontier models (e.g. Grok) sometimes flatten
          // Job properties to the top level alongside `action` instead of nesting
          // Them inside `job`. When `params.job` is missing or empty, reconstruct
          // A synthetic job object from any recognised top-level job fields.
          // See: https://github.com/openclaw/openclaw/issues/11310
          if (
            !params.job ||
            (typeof params.job === "object" &&
              params.job !== null &&
              Object.keys(params.job as Record<string, unknown>).length === 0)
          ) {
            const synthetic: Record<string, unknown> = {};
            let found = false;
            for (const key of Object.keys(params)) {
              if (CRON_RECOVERABLE_OBJECT_KEYS.has(key) && params[key] !== undefined) {
                synthetic[key] = params[key];
                found = true;
              }
            }
            // Only use the synthetic job if at least one meaningful field is present
            // (schedule, payload, message, or text are the minimum signals that the
            // LLM intended to create a job).
            if (
              found &&
              (synthetic.schedule !== undefined ||
                synthetic.payload !== undefined ||
                synthetic.message !== undefined ||
                synthetic.text !== undefined)
            ) {
              params.job = synthetic;
            }
          }

          if (!params.job || typeof params.job !== "object") {
            throw new Error("job required");
          }
          const job =
            normalizeCronJobCreate(params.job, {
              sessionContext: { sessionKey: opts?.agentSessionKey },
            }) ?? params.job;
          if (job && typeof job === "object") {
            const cfg = loadConfig();
            const { mainKey, alias } = resolveMainSessionAlias(cfg);
            const resolvedSessionKey = opts?.agentSessionKey
              ? resolveInternalSessionKey({ alias, key: opts.agentSessionKey, mainKey })
              : undefined;
            if (!("agentId" in job)) {
              const agentId = opts?.agentSessionKey
                ? resolveSessionAgentId({ config: cfg, sessionKey: opts.agentSessionKey })
                : undefined;
              if (agentId) {
                (job as { agentId?: string }).agentId = agentId;
              }
            }
            if (!("sessionKey" in job) && resolvedSessionKey) {
              (job as { sessionKey?: string }).sessionKey = resolvedSessionKey;
            }
          }

          if (
            opts?.agentSessionKey &&
            job &&
            typeof job === "object" &&
            "payload" in job &&
            (job as { payload?: { kind?: string } }).payload?.kind === "agentTurn"
          ) {
            const deliveryValue = (job as { delivery?: unknown }).delivery;
            const delivery = isRecord(deliveryValue) ? deliveryValue : undefined;
            const modeRaw = typeof delivery?.mode === "string" ? delivery.mode : "";
            const mode = normalizeLowercaseStringOrEmpty(modeRaw);
            if (mode === "webhook") {
              const webhookUrl = normalizeHttpWebhookUrl(delivery?.to);
              if (!webhookUrl) {
                throw new Error(
                  'delivery.mode="webhook" requires delivery.to to be a valid http(s) URL',
                );
              }
              if (delivery) {
                delivery.to = webhookUrl;
              }
            }

            const hasTarget =
              (typeof delivery?.channel === "string" && delivery.channel.trim()) ||
              (typeof delivery?.to === "string" && delivery.to.trim());
            const shouldInfer =
              (deliveryValue == null || delivery) &&
              (mode === "" || mode === "announce") &&
              !hasTarget;
            if (shouldInfer) {
              const inferred = inferDeliveryFromSessionKey(opts.agentSessionKey);
              if (inferred) {
                (job as { delivery?: unknown }).delivery = {
                  ...delivery,
                  ...inferred,
                } satisfies CronDelivery;
              }
            }
          }

          const contextMessages =
            typeof params.contextMessages === "number" && Number.isFinite(params.contextMessages)
              ? params.contextMessages
              : 0;
          if (
            job &&
            typeof job === "object" &&
            "payload" in job &&
            (job as { payload?: { kind?: string; text?: string } }).payload?.kind === "systemEvent"
          ) {
            const { payload } = job as { payload: { kind: string; text: string } };
            if (typeof payload.text === "string" && payload.text.trim()) {
              const contextLines = await buildReminderContextLines({
                agentSessionKey: opts?.agentSessionKey,
                callGatewayTool: callGateway,
                contextMessages,
                gatewayOpts,
              });
              if (contextLines.length > 0) {
                const baseText = stripExistingContext(payload.text);
                payload.text = `${baseText}${REMINDER_CONTEXT_MARKER}${contextLines.join("\n")}`;
              }
            }
          }
          return jsonResult(await callGateway("cron.add", gatewayOpts, job));
        }
        case "update": {
          const id = readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error("jobId required (id accepted for backward compatibility)");
          }

          // Flat-params recovery for patch
          let recoveredFlatPatch = false;
          if (
            !params.patch ||
            (typeof params.patch === "object" &&
              params.patch !== null &&
              Object.keys(params.patch as Record<string, unknown>).length === 0)
          ) {
            const synthetic: Record<string, unknown> = {};
            let found = false;
            for (const key of Object.keys(params)) {
              if (CRON_RECOVERABLE_OBJECT_KEYS.has(key) && params[key] !== undefined) {
                synthetic[key] = params[key];
                found = true;
              }
            }
            if (found) {
              params.patch = synthetic;
              recoveredFlatPatch = true;
            }
          }

          if (!params.patch || typeof params.patch !== "object") {
            throw new Error("patch required");
          }
          const patch = normalizeCronJobPatch(params.patch) ?? params.patch;
          if (
            recoveredFlatPatch &&
            typeof patch === "object" &&
            patch !== null &&
            Object.keys(patch as Record<string, unknown>).length === 0
          ) {
            throw new Error("patch required");
          }
          return jsonResult(
            await callGateway("cron.update", gatewayOpts, {
              id,
              patch,
            }),
          );
        }
        case "remove": {
          const id = readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error("jobId required (id accepted for backward compatibility)");
          }
          return jsonResult(await callGateway("cron.remove", gatewayOpts, { id }));
        }
        case "run": {
          const id = readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error("jobId required (id accepted for backward compatibility)");
          }
          const runMode =
            params.runMode === "due" || params.runMode === "force" ? params.runMode : "force";
          return jsonResult(await callGateway("cron.run", gatewayOpts, { id, mode: runMode }));
        }
        case "runs": {
          const id = readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error("jobId required (id accepted for backward compatibility)");
          }
          return jsonResult(await callGateway("cron.runs", gatewayOpts, { id }));
        }
        case "wake": {
          const text = readStringParam(params, "text", { required: true });
          const mode =
            params.mode === "now" || params.mode === "next-heartbeat"
              ? params.mode
              : "next-heartbeat";
          return jsonResult(
            await callGateway("wake", gatewayOpts, { mode, text }, { expectFinal: false }),
          );
        }
        default: {
          throw new Error(`Unknown action: ${action}`);
        }
      }
    },
    label: "Cron",
    name: "cron",
    ownerOnly: isOpenClawOwnerOnlyCoreToolName("cron"),
    parameters: CronToolSchema,
  };
}
