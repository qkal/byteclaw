import { normalizeStringEntries } from "../shared/string-normalization.js";

export function mergeDmAllowFromSources(params: {
  allowFrom?: (string | number)[];
  storeAllowFrom?: (string | number)[];
  dmPolicy?: string;
}): string[] {
  const storeEntries = params.dmPolicy === "allowlist" ? [] : (params.storeAllowFrom ?? []);
  return normalizeStringEntries([...(params.allowFrom ?? []), ...storeEntries]);
}

export function resolveGroupAllowFromSources(params: {
  allowFrom?: (string | number)[];
  groupAllowFrom?: (string | number)[];
  fallbackToAllowFrom?: boolean;
}): string[] {
  const explicitGroupAllowFrom =
    Array.isArray(params.groupAllowFrom) && params.groupAllowFrom.length > 0
      ? params.groupAllowFrom
      : undefined;
  const scoped = explicitGroupAllowFrom
    ? explicitGroupAllowFrom
    : (params.fallbackToAllowFrom === false
      ? []
      : (params.allowFrom ?? []));
  return normalizeStringEntries(scoped);
}

export function firstDefined<T>(...values: (T | undefined)[]) {
  for (const value of values) {
    if (typeof value !== "undefined") {
      return value;
    }
  }
  return undefined;
}

export function isSenderIdAllowed(
  allow: { entries: string[]; hasWildcard: boolean; hasEntries: boolean },
  senderId: string | undefined,
  allowWhenEmpty: boolean,
): boolean {
  if (!allow.hasEntries) {
    return allowWhenEmpty;
  }
  if (allow.hasWildcard) {
    return true;
  }
  if (!senderId) {
    return false;
  }
  return allow.entries.includes(senderId);
}
