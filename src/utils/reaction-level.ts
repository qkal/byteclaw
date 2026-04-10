export type ReactionLevel = "off" | "ack" | "minimal" | "extensive";

export interface ResolvedReactionLevel {
  level: ReactionLevel;
  /** Whether ACK reactions (e.g., 👀 when processing) are enabled. */
  ackEnabled: boolean;
  /** Whether agent-controlled reactions are enabled. */
  agentReactionsEnabled: boolean;
  /** Guidance level for agent reactions (minimal = sparse, extensive = liberal). */
  agentReactionGuidance?: "minimal" | "extensive";
}

const LEVELS = new Set<ReactionLevel>(["off", "ack", "minimal", "extensive"]);

function parseLevel(
  value: unknown,
): { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; value: ReactionLevel } {
  if (value === undefined || value === null) {
    return { kind: "missing" };
  }
  if (typeof value !== "string") {
    return { kind: "invalid" };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { kind: "missing" };
  }
  if (LEVELS.has(trimmed as ReactionLevel)) {
    return { kind: "ok", value: trimmed as ReactionLevel };
  }
  return { kind: "invalid" };
}

export function resolveReactionLevel(params: {
  value: unknown;
  defaultLevel: ReactionLevel;
  invalidFallback: "ack" | "minimal";
}): ResolvedReactionLevel {
  const parsed = parseLevel(params.value);
  const effective =
    parsed.kind === "ok"
      ? parsed.value
      : parsed.kind === "missing"
        ? params.defaultLevel
        : params.invalidFallback;

  switch (effective) {
    case "off": {
      return { ackEnabled: false, agentReactionsEnabled: false, level: "off" };
    }
    case "ack": {
      return { ackEnabled: true, agentReactionsEnabled: false, level: "ack" };
    }
    case "minimal": {
      return {
        ackEnabled: false,
        agentReactionGuidance: "minimal",
        agentReactionsEnabled: true,
        level: "minimal",
      };
    }
    case "extensive": {
      return {
        ackEnabled: false,
        agentReactionGuidance: "extensive",
        agentReactionsEnabled: true,
        level: "extensive",
      };
    }
    default: {
      return {
        ackEnabled: false,
        agentReactionGuidance: "minimal",
        agentReactionsEnabled: true,
        level: "minimal",
      };
    }
  }
}
