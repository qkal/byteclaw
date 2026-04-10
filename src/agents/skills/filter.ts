import { normalizeStringEntries } from "../../shared/string-normalization.js";

export function normalizeSkillFilter(skillFilter?: readonly unknown[]): string[] | undefined {
  if (skillFilter === undefined) {
    return undefined;
  }
  return normalizeStringEntries(skillFilter);
}

export function normalizeSkillFilterForComparison(
  skillFilter?: readonly unknown[],
): string[] | undefined {
  const normalized = normalizeSkillFilter(skillFilter);
  if (normalized === undefined) {
    return undefined;
  }
  return [...new Set(normalized)].toSorted();
}

export function matchesSkillFilter(
  cached?: readonly unknown[],
  next?: readonly unknown[],
): boolean {
  const cachedNormalized = normalizeSkillFilterForComparison(cached);
  const nextNormalized = normalizeSkillFilterForComparison(next);
  if (cachedNormalized === undefined || nextNormalized === undefined) {
    return cachedNormalized === nextNormalized;
  }
  if (cachedNormalized.length !== nextNormalized.length) {
    return false;
  }
  return cachedNormalized.every((entry, index) => entry === nextNormalized[index]);
}
