export const TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM = {
  android: 700,
  ios: 900,
  macos: 700,
} as const;

export function describeTalkSilenceTimeoutDefaults(): string {
  const { macos } = TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM;
  const { ios } = TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM;
  return `${macos} ms on macOS and Android, ${ios} ms on iOS`;
}
