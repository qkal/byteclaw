export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type TimestampStyle = "short" | "medium" | "long";

export interface FormatTimestampOptions {
  style?: TimestampStyle;
  timeZone?: string;
}

function resolveEffectiveTimeZone(timeZone?: string): string {
  const explicit = timeZone ?? process.env.TZ;
  return explicit && isValidTimeZone(explicit)
    ? explicit
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function formatOffset(offsetRaw: string): string {
  return offsetRaw === "GMT" ? "+00:00" : offsetRaw.slice(3);
}

function getTimestampParts(date: Date, timeZone?: string) {
  const fmt = new Intl.DateTimeFormat("en", {
    day: "2-digit",
    fractionalSecondDigits: 3 as 1 | 2 | 3,
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: resolveEffectiveTimeZone(timeZone),
    timeZoneName: "longOffset",
    year: "numeric",
  });

  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    day: parts.day,
    fractionalSecond: parts.fractionalSecond,
    hour: parts.hour,
    minute: parts.minute,
    month: parts.month,
    offset: formatOffset(parts.timeZoneName ?? "GMT"),
    second: parts.second,
    year: parts.year,
  };
}

export function formatTimestamp(date: Date, options?: FormatTimestampOptions): string {
  const style = options?.style ?? "medium";
  const parts = getTimestampParts(date, options?.timeZone);

  switch (style) {
    case "short": {
      return `${parts.hour}:${parts.minute}:${parts.second}${parts.offset}`;
    }
    case "medium": {
      return `${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${parts.offset}`;
    }
    case "long": {
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${parts.offset}`;
    }
  }
}

/**
 * @deprecated Use formatTimestamp from "./timestamps.js" instead.
 * This function will be removed in a future version.
 */
export function formatLocalIsoWithOffset(now: Date, timeZone?: string): string {
  return formatTimestamp(now, { style: "long", timeZone });
}
