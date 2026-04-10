export interface StructuredCommandPathMatchRule {
  pattern: readonly string[];
  exact?: boolean;
}

export type CommandPathMatchRule = readonly string[] | StructuredCommandPathMatchRule;

interface NormalizedCommandPathMatchRule {
  pattern: readonly string[];
  exact: boolean;
}

function isStructuredCommandPathMatchRule(
  rule: CommandPathMatchRule,
): rule is StructuredCommandPathMatchRule {
  return !Array.isArray(rule);
}

function normalizeCommandPathMatchRule(rule: CommandPathMatchRule): NormalizedCommandPathMatchRule {
  if (!isStructuredCommandPathMatchRule(rule)) {
    return { exact: false, pattern: rule };
  }
  return { exact: rule.exact ?? false, pattern: rule.pattern };
}

export function matchesCommandPath(
  commandPath: string[],
  pattern: readonly string[],
  params?: { exact?: boolean },
): boolean {
  if (pattern.some((segment, index) => commandPath[index] !== segment)) {
    return false;
  }
  return !params?.exact || commandPath.length === pattern.length;
}

export function matchesCommandPathRule(commandPath: string[], rule: CommandPathMatchRule): boolean {
  const normalizedRule = normalizeCommandPathMatchRule(rule);
  return matchesCommandPath(commandPath, normalizedRule.pattern, {
    exact: normalizedRule.exact,
  });
}

export function matchesAnyCommandPath(
  commandPath: string[],
  rules: readonly CommandPathMatchRule[],
): boolean {
  return rules.some((rule) => matchesCommandPathRule(commandPath, rule));
}
