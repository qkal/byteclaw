import {
  type AllowlistMatch,
  compileAllowlist,
  resolveCompiledAllowlistMatch,
} from "openclaw/plugin-sdk/allow-from";
import {
  normalizeHyphenSlug,
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "openclaw/plugin-sdk/string-normalization-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";

const SLACK_SLUG_CACHE_MAX = 512;
const slackSlugCache = new Map<string, string>();

export function normalizeSlackSlug(raw?: string) {
  const key = raw ?? "";
  const cached = slackSlugCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const normalized = normalizeHyphenSlug(raw);
  slackSlugCache.set(key, normalized);
  if (slackSlugCache.size > SLACK_SLUG_CACHE_MAX) {
    const oldest = slackSlugCache.keys().next();
    if (!oldest.done) {
      slackSlugCache.delete(oldest.value);
    }
  }
  return normalized;
}

export function normalizeAllowList(list?: (string | number)[]) {
  return normalizeStringEntries(list);
}

export function normalizeAllowListLower(list?: (string | number)[]) {
  return normalizeStringEntriesLower(list);
}

export function normalizeSlackAllowOwnerEntry(entry: string): string | undefined {
  const trimmed = normalizeOptionalLowercaseString(entry);
  if (!trimmed || trimmed === "*") {
    return undefined;
  }
  const withoutPrefix = trimmed.replace(/^(slack:|user:)/, "");
  return /^u[a-z0-9]+$/.test(withoutPrefix) ? withoutPrefix : undefined;
}

export type SlackAllowListMatch = AllowlistMatch<
  "wildcard" | "id" | "prefixed-id" | "prefixed-user" | "name" | "prefixed-name" | "slug"
>;
type SlackAllowListSource = Exclude<SlackAllowListMatch["matchSource"], undefined>;

export function resolveSlackAllowListMatch(params: {
  allowList: string[];
  id?: string;
  name?: string;
  allowNameMatching?: boolean;
}): SlackAllowListMatch {
  const compiledAllowList = compileAllowlist(params.allowList);
  const id = normalizeOptionalLowercaseString(params.id);
  const name = normalizeOptionalLowercaseString(params.name);
  const slug = normalizeSlackSlug(name);
  const candidates: { value?: string; source: SlackAllowListSource }[] = [
    { source: "id", value: id },
    { source: "prefixed-id", value: id ? `slack:${id}` : undefined },
    { source: "prefixed-user", value: id ? `user:${id}` : undefined },
    ...(params.allowNameMatching === true
      ? ([
          { source: "name" as const, value: name },
          { source: "prefixed-name" as const, value: name ? `slack:${name}` : undefined },
          { source: "slug" as const, value: slug },
        ] satisfies { value?: string; source: SlackAllowListSource }[])
      : []),
  ];
  return resolveCompiledAllowlistMatch({
    candidates,
    compiledAllowlist: compiledAllowList,
  });
}

export function allowListMatches(params: {
  allowList: string[];
  id?: string;
  name?: string;
  allowNameMatching?: boolean;
}) {
  return resolveSlackAllowListMatch(params).allowed;
}

export function resolveSlackUserAllowed(params: {
  allowList?: (string | number)[];
  userId?: string;
  userName?: string;
  allowNameMatching?: boolean;
}) {
  const allowList = normalizeAllowListLower(params.allowList);
  if (allowList.length === 0) {
    return true;
  }
  return allowListMatches({
    allowList,
    allowNameMatching: params.allowNameMatching,
    id: params.userId,
    name: params.userName,
  });
}
