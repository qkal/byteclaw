import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

/** Structured reminder payload emitted by the model. */
export interface CronReminderPayload {
  type: "cron_reminder";
  content: string;
  targetType: "c2c" | "group";
  targetAddress: string;
  originalMessageId?: string;
}

/** Structured media payload emitted by the model. */
export interface MediaPayload {
  type: "media";
  mediaType: "image" | "audio" | "video" | "file";
  source: "url" | "file";
  path: string;
  caption?: string;
}

export type QQBotPayload = CronReminderPayload | MediaPayload;

/** Result of parsing model output into a structured payload. */
export interface ParseResult {
  isPayload: boolean;
  payload?: QQBotPayload;
  text?: string;
  error?: string;
}

const PAYLOAD_PREFIX = "QQBOT_PAYLOAD:";
const CRON_PREFIX = "QQBOT_CRON:";

/** Parse model output that may start with the QQ Bot structured payload prefix. */
export function parseQQBotPayload(text: string): ParseResult {
  const trimmedText = text.trim();

  if (!trimmedText.startsWith(PAYLOAD_PREFIX)) {
    return {
      isPayload: false,
      text,
    };
  }

  const jsonContent = trimmedText.slice(PAYLOAD_PREFIX.length).trim();

  if (!jsonContent) {
    return {
      error: "Payload body is empty",
      isPayload: true,
    };
  }

  try {
    const payload = JSON.parse(jsonContent) as QQBotPayload;

    if (!payload.type) {
      return {
        error: "Payload is missing the type field",
        isPayload: true,
      };
    }

    if (payload.type === "cron_reminder") {
      if (!payload.content || !payload.targetType || !payload.targetAddress) {
        return {
          error:
            "cron_reminder payload is missing required fields (content, targetType, targetAddress)",
          isPayload: true,
        };
      }
    } else if (payload.type === "media") {
      if (!payload.mediaType || !payload.source || !payload.path) {
        return {
          error: "media payload is missing required fields (mediaType, source, path)",
          isPayload: true,
        };
      }
    }

    return {
      isPayload: true,
      payload,
    };
  } catch (error) {
    return {
      error: `Failed to parse JSON: ${formatErrorMessage(error)}`,
      isPayload: true,
    };
  }
}

/** Encode a cron reminder payload into the stored cron-message format. */
export function encodePayloadForCron(payload: CronReminderPayload): string {
  const jsonString = JSON.stringify(payload);
  const base64 = Buffer.from(jsonString, "utf8").toString("base64");
  return `${CRON_PREFIX}${base64}`;
}

/** Decode a stored cron payload. */
export function decodeCronPayload(message: string): {
  isCronPayload: boolean;
  payload?: CronReminderPayload;
  error?: string;
} {
  const trimmedMessage = message.trim();

  if (!trimmedMessage.startsWith(CRON_PREFIX)) {
    return {
      isCronPayload: false,
    };
  }

  const base64Content = trimmedMessage.slice(CRON_PREFIX.length);

  if (!base64Content) {
    return {
      error: "Cron payload body is empty",
      isCronPayload: true,
    };
  }

  try {
    const jsonString = Buffer.from(base64Content, "base64").toString("utf8");
    const payload = JSON.parse(jsonString) as CronReminderPayload;

    if (payload.type !== "cron_reminder") {
      return {
        error: `Expected type cron_reminder but got ${String(payload.type)}`,
        isCronPayload: true,
      };
    }

    if (!payload.content || !payload.targetType || !payload.targetAddress) {
      return {
        error: "Cron payload is missing required fields",
        isCronPayload: true,
      };
    }

    return {
      isCronPayload: true,
      payload,
    };
  } catch (error) {
    return {
      error: `Failed to decode cron payload: ${formatErrorMessage(error)}`,
      isCronPayload: true,
    };
  }
}

/** Type guard for cron reminder payloads. */
export function isCronReminderPayload(payload: QQBotPayload): payload is CronReminderPayload {
  return payload.type === "cron_reminder";
}

/** Type guard for media payloads. */
export function isMediaPayload(payload: QQBotPayload): payload is MediaPayload {
  return payload.type === "media";
}
