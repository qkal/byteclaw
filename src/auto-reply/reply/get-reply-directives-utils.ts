import type { InlineDirectives } from "./directive-handling.js";

const CLEARED_EXEC_FIELDS = {
  execAsk: undefined,
  execHost: undefined,
  execNode: undefined,
  execSecurity: undefined,
  hasExecDirective: false,
  hasExecOptions: false,
  invalidExecAsk: false,
  invalidExecHost: false,
  invalidExecNode: false,
  invalidExecSecurity: false,
  rawExecAsk: undefined,
  rawExecHost: undefined,
  rawExecNode: undefined,
  rawExecSecurity: undefined,
} satisfies Partial<InlineDirectives>;

export function clearInlineDirectives(cleaned: string): InlineDirectives {
  return {
    cleaned,
    hasThinkDirective: false,
    thinkLevel: undefined,
    rawThinkLevel: undefined,
    hasVerboseDirective: false,
    verboseLevel: undefined,
    rawVerboseLevel: undefined,
    hasFastDirective: false,
    fastMode: undefined,
    rawFastMode: undefined,
    hasReasoningDirective: false,
    reasoningLevel: undefined,
    rawReasoningLevel: undefined,
    hasElevatedDirective: false,
    elevatedLevel: undefined,
    rawElevatedLevel: undefined,
    ...CLEARED_EXEC_FIELDS,
    hasStatusDirective: false,
    hasModelDirective: false,
    rawModelDirective: undefined,
    hasQueueDirective: false,
    queueMode: undefined,
    queueReset: false,
    rawQueueMode: undefined,
    debounceMs: undefined,
    cap: undefined,
    dropPolicy: undefined,
    rawDebounce: undefined,
    rawCap: undefined,
    rawDrop: undefined,
    hasQueueOptions: false,
  };
}

export function clearExecInlineDirectives(directives: InlineDirectives): InlineDirectives {
  return {
    ...directives,
    ...CLEARED_EXEC_FIELDS,
  };
}
