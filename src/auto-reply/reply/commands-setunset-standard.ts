import { parseSlashCommandWithSetUnset } from "./commands-setunset.js";

export function parseStandardSetUnsetSlashCommand<T>(params: {
  raw: string;
  slash: string;
  invalidMessage: string;
  usageMessage: string;
  onKnownAction: (action: string, args: string) => T | undefined;
  onSet?: (path: string, value: unknown) => T;
  onUnset?: (path: string) => T;
  onError?: (message: string) => T;
}): T | null {
  return parseSlashCommandWithSetUnset<T>({
    invalidMessage: params.invalidMessage,
    onError: params.onError ?? ((message) => ({ action: "error", message }) as T),
    onKnownAction: params.onKnownAction,
    onSet: params.onSet ?? ((path, value) => ({ action: "set", path, value }) as T),
    onUnset: params.onUnset ?? ((path) => ({ action: "unset", path }) as T),
    raw: params.raw,
    slash: params.slash,
    usageMessage: params.usageMessage,
  });
}
