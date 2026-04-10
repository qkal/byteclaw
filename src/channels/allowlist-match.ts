import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";

export type AllowlistMatchSource =
  | "wildcard"
  | "id"
  | "name"
  | "tag"
  | "username"
  | "prefixed-id"
  | "prefixed-user"
  | "prefixed-name"
  | "slug"
  | "localpart";

export interface AllowlistMatch<TSource extends string = AllowlistMatchSource> {
  allowed: boolean;
  matchKey?: string;
  matchSource?: TSource;
}

export interface CompiledAllowlist {
  set: ReadonlySet<string>;
  wildcard: boolean;
}

export function formatAllowlistMatchMeta(
  match?: { matchKey?: string; matchSource?: string } | null,
): string {
  return `matchKey=${match?.matchKey ?? "none"} matchSource=${match?.matchSource ?? "none"}`;
}

export function compileAllowlist(entries: readonly string[]): CompiledAllowlist {
  const set = new Set(entries.filter(Boolean));
  return {
    set,
    wildcard: set.has("*"),
  };
}

function compileSimpleAllowlist(entries: readonly (string | number)[]): CompiledAllowlist {
  return compileAllowlist(
    entries
      .map((entry) => normalizeOptionalLowercaseString(String(entry)))
      .filter((entry): entry is string => Boolean(entry)),
  );
}

export function resolveAllowlistCandidates<TSource extends string>(params: {
  compiledAllowlist: CompiledAllowlist;
  candidates: { value?: string; source: TSource }[];
}): AllowlistMatch<TSource> {
  for (const candidate of params.candidates) {
    if (!candidate.value) {
      continue;
    }
    if (params.compiledAllowlist.set.has(candidate.value)) {
      return {
        allowed: true,
        matchKey: candidate.value,
        matchSource: candidate.source,
      };
    }
  }
  return { allowed: false };
}

export function resolveCompiledAllowlistMatch<TSource extends string>(params: {
  compiledAllowlist: CompiledAllowlist;
  candidates: { value?: string; source: TSource }[];
}): AllowlistMatch<TSource> {
  if (params.compiledAllowlist.set.size === 0) {
    return { allowed: false };
  }
  if (params.compiledAllowlist.wildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" as TSource };
  }
  return resolveAllowlistCandidates(params);
}

export function resolveAllowlistMatchByCandidates<TSource extends string>(params: {
  allowList: readonly string[];
  candidates: { value?: string; source: TSource }[];
}): AllowlistMatch<TSource> {
  return resolveCompiledAllowlistMatch({
    candidates: params.candidates,
    compiledAllowlist: compileAllowlist(params.allowList),
  });
}

export function resolveAllowlistMatchSimple(params: {
  allowFrom: readonly (string | number)[];
  senderId: string;
  senderName?: string | null;
  allowNameMatching?: boolean;
}): AllowlistMatch<"wildcard" | "id" | "name"> {
  const allowFrom = compileSimpleAllowlist(params.allowFrom);

  if (allowFrom.set.size === 0) {
    return { allowed: false };
  }
  if (allowFrom.wildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  const senderId = normalizeLowercaseStringOrEmpty(params.senderId);
  const senderName = normalizeOptionalLowercaseString(params.senderName);
  return resolveAllowlistCandidates({
    candidates: [
      { source: "id", value: senderId },
      ...(params.allowNameMatching === true && senderName
        ? ([{ source: "name" as const, value: senderName }] satisfies {
            value?: string;
            source: "id" | "name";
          }[])
        : []),
    ],
    compiledAllowlist: allowFrom,
  });
}
