import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";

export interface ServicePrefix<TService extends string> { prefix: string; service: TService }

export interface ChatTargetPrefixesParams {
  trimmed: string;
  lower: string;
  chatIdPrefixes: string[];
  chatGuidPrefixes: string[];
  chatIdentifierPrefixes: string[];
}

export type ParsedChatTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string };

export type ParsedChatAllowTarget = ParsedChatTarget | { kind: "handle"; handle: string };

export interface ChatSenderAllowParams {
  allowFrom: (string | number)[];
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
}

function isAllowedParsedChatSender<TParsed extends ParsedChatAllowTarget>(params: {
  allowFrom: (string | number)[];
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
  normalizeSender: (sender: string) => string;
  parseAllowTarget: (entry: string) => TParsed;
}): boolean {
  const allowFrom = normalizeStringEntries(params.allowFrom);
  if (allowFrom.length === 0) {
    return false;
  }
  if (allowFrom.includes("*")) {
    return true;
  }

  const senderNormalized = params.normalizeSender(params.sender);
  const chatId = params.chatId ?? undefined;
  const chatGuid = normalizeOptionalString(params.chatGuid);
  const chatIdentifier = normalizeOptionalString(params.chatIdentifier);

  for (const entry of allowFrom) {
    if (!entry) {
      continue;
    }
    const parsed = params.parseAllowTarget(entry);
    if (parsed.kind === "chat_id" && chatId !== undefined) {
      if (parsed.chatId === chatId) {
        return true;
      }
    } else if (parsed.kind === "chat_guid" && chatGuid) {
      if (parsed.chatGuid === chatGuid) {
        return true;
      }
    } else if (parsed.kind === "chat_identifier" && chatIdentifier) {
      if (parsed.chatIdentifier === chatIdentifier) {
        return true;
      }
    } else if (parsed.kind === "handle" && senderNormalized) {
      if (parsed.handle === senderNormalized) {
        return true;
      }
    }
  }
  return false;
}

function stripPrefix(value: string, prefix: string): string {
  return value.slice(prefix.length).trim();
}

function startsWithAnyPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

export function resolveServicePrefixedTarget<TService extends string, TTarget>(params: {
  trimmed: string;
  lower: string;
  servicePrefixes: ServicePrefix<TService>[];
  isChatTarget: (remainderLower: string) => boolean;
  parseTarget: (remainder: string) => TTarget;
}): ({ kind: "handle"; to: string; service: TService } | TTarget) | null {
  for (const { prefix, service } of params.servicePrefixes) {
    if (!params.lower.startsWith(prefix)) {
      continue;
    }
    const remainder = stripPrefix(params.trimmed, prefix);
    if (!remainder) {
      throw new Error(`${prefix} target is required`);
    }
    const remainderLower = normalizeLowercaseStringOrEmpty(remainder);
    if (params.isChatTarget(remainderLower)) {
      return params.parseTarget(remainder);
    }
    return { kind: "handle", service, to: remainder };
  }
  return null;
}

export function resolveServicePrefixedChatTarget<TService extends string, TTarget>(params: {
  trimmed: string;
  lower: string;
  servicePrefixes: ServicePrefix<TService>[];
  chatIdPrefixes: string[];
  chatGuidPrefixes: string[];
  chatIdentifierPrefixes: string[];
  extraChatPrefixes?: string[];
  parseTarget: (remainder: string) => TTarget;
}): ({ kind: "handle"; to: string; service: TService } | TTarget) | null {
  const chatPrefixes = [
    ...params.chatIdPrefixes,
    ...params.chatGuidPrefixes,
    ...params.chatIdentifierPrefixes,
    ...(params.extraChatPrefixes ?? []),
  ];
  return resolveServicePrefixedTarget({
    isChatTarget: (remainderLower) => startsWithAnyPrefix(remainderLower, chatPrefixes),
    lower: params.lower,
    parseTarget: params.parseTarget,
    servicePrefixes: params.servicePrefixes,
    trimmed: params.trimmed,
  });
}

export function parseChatTargetPrefixesOrThrow(
  params: ChatTargetPrefixesParams,
): ParsedChatTarget | null {
  for (const prefix of params.chatIdPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      const chatId = Number.parseInt(value, 10);
      if (!Number.isFinite(chatId)) {
        throw new Error(`Invalid chat_id: ${value}`);
      }
      return { chatId, kind: "chat_id" };
    }
  }

  for (const prefix of params.chatGuidPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (!value) {
        throw new Error("chat_guid is required");
      }
      return { chatGuid: value, kind: "chat_guid" };
    }
  }

  for (const prefix of params.chatIdentifierPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (!value) {
        throw new Error("chat_identifier is required");
      }
      return { chatIdentifier: value, kind: "chat_identifier" };
    }
  }

  return null;
}

export function resolveServicePrefixedAllowTarget<TAllowTarget>(params: {
  trimmed: string;
  lower: string;
  servicePrefixes: { prefix: string }[];
  parseAllowTarget: (remainder: string) => TAllowTarget;
}): (TAllowTarget | { kind: "handle"; handle: string }) | null {
  for (const { prefix } of params.servicePrefixes) {
    if (!params.lower.startsWith(prefix)) {
      continue;
    }
    const remainder = stripPrefix(params.trimmed, prefix);
    if (!remainder) {
      return { handle: "", kind: "handle" };
    }
    return params.parseAllowTarget(remainder);
  }
  return null;
}

export function resolveServicePrefixedOrChatAllowTarget<
  TAllowTarget extends ParsedChatAllowTarget,
>(params: {
  trimmed: string;
  lower: string;
  servicePrefixes: { prefix: string }[];
  parseAllowTarget: (remainder: string) => TAllowTarget;
  chatIdPrefixes: string[];
  chatGuidPrefixes: string[];
  chatIdentifierPrefixes: string[];
}): TAllowTarget | null {
  const servicePrefixed = resolveServicePrefixedAllowTarget({
    lower: params.lower,
    parseAllowTarget: params.parseAllowTarget,
    servicePrefixes: params.servicePrefixes,
    trimmed: params.trimmed,
  });
  if (servicePrefixed) {
    return servicePrefixed as TAllowTarget;
  }

  const chatTarget = parseChatAllowTargetPrefixes({
    chatGuidPrefixes: params.chatGuidPrefixes,
    chatIdPrefixes: params.chatIdPrefixes,
    chatIdentifierPrefixes: params.chatIdentifierPrefixes,
    lower: params.lower,
    trimmed: params.trimmed,
  });
  if (chatTarget) {
    return chatTarget as TAllowTarget;
  }
  return null;
}

export function createAllowedChatSenderMatcher<TParsed extends ParsedChatAllowTarget>(params: {
  normalizeSender: (sender: string) => string;
  parseAllowTarget: (entry: string) => TParsed;
}): (input: ChatSenderAllowParams) => boolean {
  return (input) =>
    isAllowedParsedChatSender({
      allowFrom: input.allowFrom,
      chatGuid: input.chatGuid,
      chatId: input.chatId,
      chatIdentifier: input.chatIdentifier,
      normalizeSender: params.normalizeSender,
      parseAllowTarget: params.parseAllowTarget,
      sender: input.sender,
    });
}

export function parseChatAllowTargetPrefixes(
  params: ChatTargetPrefixesParams,
): ParsedChatTarget | null {
  for (const prefix of params.chatIdPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      const chatId = Number.parseInt(value, 10);
      if (Number.isFinite(chatId)) {
        return { chatId, kind: "chat_id" };
      }
    }
  }

  for (const prefix of params.chatGuidPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (value) {
        return { chatGuid: value, kind: "chat_guid" };
      }
    }
  }

  for (const prefix of params.chatIdentifierPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (value) {
        return { chatIdentifier: value, kind: "chat_identifier" };
      }
    }
  }

  return null;
}
