import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isIrcMutableAllowEntry(raw: string): boolean {
  const text = normalizeLowercaseStringOrEmpty(raw);
  if (!text || text === "*") {
    return false;
  }

  const normalized = text
    .replace(/^irc:/, "")
    .replace(/^user:/, "")
    .trim();

  return !normalized.includes("!") && !normalized.includes("@");
}

export const collectIrcMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "irc",
    collectLists: (scope) => {
      const lists = [
        {
          list: scope.account.allowFrom,
          pathLabel: `${scope.prefix}.allowFrom`,
        },
        {
          list: scope.account.groupAllowFrom,
          pathLabel: `${scope.prefix}.groupAllowFrom`,
        },
      ];
      const groups = asObjectRecord(scope.account.groups);
      if (groups) {
        for (const [groupKey, groupRaw] of Object.entries(groups)) {
          const group = asObjectRecord(groupRaw);
          if (!group) {
            continue;
          }
          lists.push({
            list: group.allowFrom,
            pathLabel: `${scope.prefix}.groups.${groupKey}.allowFrom`,
          });
        }
      }
      return lists;
    },
    detector: isIrcMutableAllowEntry,
  });
