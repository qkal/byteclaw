import type { OpenClawConfig } from "../config/config.js";

export type RealtimeVoiceProviderId = string;

export type RealtimeVoiceRole = "user" | "assistant";

export type RealtimeVoiceCloseReason = "completed" | "error";

export interface RealtimeVoiceTool {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface RealtimeVoiceToolCallEvent {
  itemId: string;
  callId: string;
  name: string;
  args: unknown;
}

export interface RealtimeVoiceBridgeCallbacks {
  onAudio: (muLaw: Buffer) => void;
  onClearAudio: () => void;
  onMark?: (markName: string) => void;
  onTranscript?: (role: RealtimeVoiceRole, text: string, isFinal: boolean) => void;
  onToolCall?: (event: RealtimeVoiceToolCallEvent) => void;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onClose?: (reason: RealtimeVoiceCloseReason) => void;
}

export type RealtimeVoiceProviderConfig = Record<string, unknown>;

export interface RealtimeVoiceProviderResolveConfigContext {
  cfg: OpenClawConfig;
  rawConfig: RealtimeVoiceProviderConfig;
}

export interface RealtimeVoiceProviderConfiguredContext {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
}

export type RealtimeVoiceBridgeCreateRequest = RealtimeVoiceBridgeCallbacks & {
  providerConfig: RealtimeVoiceProviderConfig;
  instructions?: string;
  tools?: RealtimeVoiceTool[];
};

export interface RealtimeVoiceBridge {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  setMediaTimestamp(ts: number): void;
  sendUserMessage?(text: string): void;
  triggerGreeting?(instructions?: string): void;
  submitToolResult(callId: string, result: unknown): void;
  acknowledgeMark(): void;
  close(): void;
  isConnected(): boolean;
}
