import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../../glob-pattern.js";
import type { ContextPruningToolMatch } from "./settings.js";

function normalizeGlob(value: string) {
  return normalizeLowercaseStringOrEmpty(String(value ?? ""));
}

export function makeToolPrunablePredicate(
  match: ContextPruningToolMatch,
): (toolName: string) => boolean {
  const deny = compileGlobPatterns({ normalize: normalizeGlob, raw: match.deny });
  const allow = compileGlobPatterns({ normalize: normalizeGlob, raw: match.allow });

  return (toolName: string) => {
    const normalized = normalizeGlob(toolName);
    if (matchesAnyGlobPattern(normalized, deny)) {
      return false;
    }
    if (allow.length === 0) {
      return true;
    }
    return matchesAnyGlobPattern(normalized, allow);
  };
}
