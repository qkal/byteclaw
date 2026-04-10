import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

export function normalizeSlackToken(raw?: unknown): string | undefined {
  return normalizeResolvedSecretInputString({
    path: "channels.slack.*.token",
    value: raw,
  });
}

export function resolveSlackBotToken(
  raw?: unknown,
  path = "channels.slack.botToken",
): string | undefined {
  return normalizeResolvedSecretInputString({ path, value: raw });
}

export function resolveSlackAppToken(
  raw?: unknown,
  path = "channels.slack.appToken",
): string | undefined {
  return normalizeResolvedSecretInputString({ path, value: raw });
}

export function resolveSlackUserToken(
  raw?: unknown,
  path = "channels.slack.userToken",
): string | undefined {
  return normalizeResolvedSecretInputString({ path, value: raw });
}
