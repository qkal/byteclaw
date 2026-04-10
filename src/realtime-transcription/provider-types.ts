import type { OpenClawConfig } from "../config/config.js";

export type RealtimeTranscriptionProviderId = string;

export type RealtimeTranscriptionProviderConfig = Record<string, unknown>;

export interface RealtimeTranscriptionProviderResolveConfigContext {
  cfg: OpenClawConfig;
  rawConfig: RealtimeTranscriptionProviderConfig;
}

export interface RealtimeTranscriptionProviderConfiguredContext {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeTranscriptionProviderConfig;
}

export interface RealtimeTranscriptionSessionCallbacks {
  onPartial?: (partial: string) => void;
  onTranscript?: (transcript: string) => void;
  onSpeechStart?: () => void;
  onError?: (error: Error) => void;
}

export type RealtimeTranscriptionSessionCreateRequest = RealtimeTranscriptionSessionCallbacks & {
  providerConfig: RealtimeTranscriptionProviderConfig;
};

export interface RealtimeTranscriptionSession {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  close(): void;
  isConnected(): boolean;
}
