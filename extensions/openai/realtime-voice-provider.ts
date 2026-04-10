import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import WebSocket from "ws";
import {
  asFiniteNumber,
  readRealtimeErrorDetail,
  resolveOpenAIProviderConfigRecord,
  trimToUndefined,
} from "./realtime-provider-shared.js";

export type OpenAIRealtimeVoice =
  | "alloy"
  | "ash"
  | "ballad"
  | "cedar"
  | "coral"
  | "echo"
  | "marin"
  | "sage"
  | "shimmer"
  | "verse";

interface OpenAIRealtimeVoiceProviderConfig {
  apiKey?: string;
  model?: string;
  voice?: OpenAIRealtimeVoice;
  temperature?: number;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
}

type OpenAIRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  apiKey: string;
  model?: string;
  voice?: OpenAIRealtimeVoice;
  temperature?: number;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
};

interface RealtimeEvent {
  type: string;
  delta?: string;
  transcript?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  error?: unknown;
}

interface RealtimeSessionUpdate {
  type: "session.update";
  session: {
    modalities: string[];
    instructions?: string;
    voice: OpenAIRealtimeVoice;
    input_audio_format: string;
    output_audio_format: string;
    turn_detection: {
      type: "server_vad";
      threshold: number;
      prefix_padding_ms: number;
      silence_duration_ms: number;
      create_response: boolean;
    };
    temperature: number;
    input_audio_transcription?: { model: string };
    tools?: RealtimeVoiceTool[];
    tool_choice?: string;
  };
}

function normalizeProviderConfig(
  config: RealtimeVoiceProviderConfig,
): OpenAIRealtimeVoiceProviderConfig {
  const raw = resolveOpenAIProviderConfigRecord(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      path: "plugins.entries.voice-call.config.realtime.providers.openai.apiKey",
      value: raw?.apiKey,
    }),
    azureApiVersion: trimToUndefined(raw?.azureApiVersion),
    azureDeployment: trimToUndefined(raw?.azureDeployment),
    azureEndpoint: trimToUndefined(raw?.azureEndpoint),
    model: trimToUndefined(raw?.model),
    prefixPaddingMs: asFiniteNumber(raw?.prefixPaddingMs),
    silenceDurationMs: asFiniteNumber(raw?.silenceDurationMs),
    temperature: asFiniteNumber(raw?.temperature),
    vadThreshold: asFiniteNumber(raw?.vadThreshold),
    voice: trimToUndefined(raw?.voice) as OpenAIRealtimeVoice | undefined,
  };
}

function base64ToBuffer(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

class OpenAIRealtimeVoiceBridge implements RealtimeVoiceBridge {
  private static readonly DEFAULT_MODEL = "gpt-realtime";
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly BASE_RECONNECT_DELAY_MS = 1000;
  private static readonly CONNECT_TIMEOUT_MS = 10_000;

  private ws: WebSocket | null = null;
  private connected = false;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private pendingAudio: Buffer[] = [];
  private markQueue: string[] = [];
  private responseStartTimestamp: number | null = null;
  private latestMediaTimestamp = 0;
  private lastAssistantItemId: string | null = null;
  private toolCallBuffers = new Map<string, { name: string; callId: string; args: string }>();

  constructor(private readonly config: OpenAIRealtimeVoiceBridgeConfig) {}

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    await this.doConnect();
  }

  sendAudio(audio: Buffer): void {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) {
      if (this.pendingAudio.length < 320) {
        this.pendingAudio.push(audio);
      }
      return;
    }
    this.sendEvent({
      audio: audio.toString("base64"),
      type: "input_audio_buffer.append",
    });
  }

  setMediaTimestamp(ts: number): void {
    this.latestMediaTimestamp = ts;
  }

  sendUserMessage(text: string): void {
    this.sendEvent({
      item: {
        content: [{ text, type: "input_text" }],
        role: "user",
        type: "message",
      },
      type: "conversation.item.create",
    });
    this.sendEvent({ type: "response.create" });
  }

  triggerGreeting(instructions?: string): void {
    if (!this.connected || !this.ws) {
      return;
    }
    this.sendEvent({
      response: {
        instructions: instructions ?? this.config.instructions,
      },
      type: "response.create",
    });
  }

  submitToolResult(callId: string, result: unknown): void {
    this.sendEvent({
      item: {
        call_id: callId,
        output: JSON.stringify(result),
        type: "function_call_output",
      },
      type: "conversation.item.create",
    });
    this.sendEvent({ type: "response.create" });
  }

  acknowledgeMark(): void {
    if (this.markQueue.length === 0) {
      return;
    }
    this.markQueue.shift();
    if (this.markQueue.length === 0) {
      this.responseStartTimestamp = null;
      this.lastAssistantItemId = null;
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    this.connected = false;
    if (this.ws) {
      this.ws.close(1000, "Bridge closed");
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async doConnect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const { url, headers } = this.resolveConnectionParams();
      this.ws = new WebSocket(url, { headers });

      const connectTimeout = setTimeout(() => {
        reject(new Error("OpenAI realtime connection timeout"));
      }, OpenAIRealtimeVoiceBridge.CONNECT_TIMEOUT_MS);

      this.ws.on("open", () => {
        clearTimeout(connectTimeout);
        this.connected = true;
        this.reconnectAttempts = 0;
        this.sendSessionUpdate();
        for (const chunk of this.pendingAudio.splice(0)) {
          this.sendAudio(chunk);
        }
        this.config.onReady?.();
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          this.handleEvent(JSON.parse(data.toString()) as RealtimeEvent);
        } catch (error) {
          console.error("[openai] realtime event parse failed:", error);
        }
      });

      this.ws.on("error", (error) => {
        if (!this.connected) {
          clearTimeout(connectTimeout);
          reject(error);
        }
        this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

      this.ws.on("close", () => {
        this.connected = false;
        if (this.intentionallyClosed) {
          this.config.onClose?.("completed");
          return;
        }
        void this.attemptReconnect();
      });
    });
  }

  private resolveConnectionParams(): { url: string; headers: Record<string, string> } {
    const cfg = this.config;
    if (cfg.azureEndpoint && cfg.azureDeployment) {
      const base = cfg.azureEndpoint
        .replace(/\/$/, "")
        .replace(/^http(s?):/, (_, secure: string) => `ws${secure}:`);
      const apiVersion = cfg.azureApiVersion ?? "2024-10-01-preview";
      return {
        headers: { "api-key": cfg.apiKey },
        url: `${base}/openai/realtime?api-version=${apiVersion}&deployment=${encodeURIComponent(
          cfg.azureDeployment,
        )}`,
      };
    }

    if (cfg.azureEndpoint) {
      const base = cfg.azureEndpoint
        .replace(/\/$/, "")
        .replace(/^http(s?):/, (_, secure: string) => `ws${secure}:`);
      return {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        url: `${base}/v1/realtime?model=${encodeURIComponent(
          cfg.model ?? OpenAIRealtimeVoiceBridge.DEFAULT_MODEL,
        )}`,
      };
    }

    return {
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
      url: `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
        cfg.model ?? OpenAIRealtimeVoiceBridge.DEFAULT_MODEL,
      )}`,
    };
  }

  private async attemptReconnect(): Promise<void> {
    if (this.intentionallyClosed) {
      return;
    }
    if (this.reconnectAttempts >= OpenAIRealtimeVoiceBridge.MAX_RECONNECT_ATTEMPTS) {
      this.config.onClose?.("error");
      return;
    }
    this.reconnectAttempts += 1;
    const delay =
      OpenAIRealtimeVoiceBridge.BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.intentionallyClosed) {
      return;
    }
    try {
      await this.doConnect();
    } catch (error) {
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      await this.attemptReconnect();
    }
  }

  private sendSessionUpdate(): void {
    const cfg = this.config;
    const sessionUpdate: RealtimeSessionUpdate = {
      session: {
        input_audio_format: "g711_ulaw",
        input_audio_transcription: {
          model: "whisper-1",
        },
        instructions: cfg.instructions,
        modalities: ["text", "audio"],
        output_audio_format: "g711_ulaw",
        temperature: cfg.temperature ?? 0.8,
        turn_detection: {
          create_response: true,
          prefix_padding_ms: cfg.prefixPaddingMs ?? 300,
          silence_duration_ms: cfg.silenceDurationMs ?? 500,
          threshold: cfg.vadThreshold ?? 0.5,
          type: "server_vad",
        },
        voice: cfg.voice ?? "alloy",
        ...(cfg.tools && cfg.tools.length > 0
          ? {
              tool_choice: "auto",
              tools: cfg.tools,
            }
          : {}),
      },
      type: "session.update",
    };
    this.sendEvent(sessionUpdate);
  }

  private handleEvent(event: RealtimeEvent): void {
    switch (event.type) {
      case "response.audio.delta": {
        if (!event.delta) {
          return;
        }
        const audio = base64ToBuffer(event.delta);
        this.config.onAudio(audio);
        if (this.responseStartTimestamp === null) {
          this.responseStartTimestamp = this.latestMediaTimestamp;
        }
        if (event.item_id) {
          this.lastAssistantItemId = event.item_id;
        }
        this.sendMark();
        return;
      }

      case "input_audio_buffer.speech_started": {
        this.handleBargeIn();
        return;
      }

      case "response.audio_transcript.delta": {
        if (event.delta) {
          this.config.onTranscript?.("assistant", event.delta, false);
        }
        return;
      }

      case "response.audio_transcript.done": {
        if (event.transcript) {
          this.config.onTranscript?.("assistant", event.transcript, true);
        }
        return;
      }

      case "conversation.item.input_audio_transcription.completed": {
        if (event.transcript) {
          this.config.onTranscript?.("user", event.transcript, true);
        }
        return;
      }

      case "conversation.item.input_audio_transcription.delta": {
        if (event.delta) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        return;
      }

      case "response.function_call_arguments.delta": {
        const key = event.item_id ?? "unknown";
        const existing = this.toolCallBuffers.get(key);
        if (existing && event.delta) {
          existing.args += event.delta;
        } else if (event.item_id) {
          this.toolCallBuffers.set(event.item_id, {
            args: event.delta ?? "",
            callId: event.call_id ?? "",
            name: event.name ?? "",
          });
        }
        return;
      }

      case "response.function_call_arguments.done": {
        const key = event.item_id ?? "unknown";
        const buffered = this.toolCallBuffers.get(key);
        if (this.config.onToolCall) {
          const rawArgs =
            buffered?.args ||
            ((event as unknown as Record<string, unknown>).arguments as string) ||
            "{}";
          let args: unknown = {};
          try {
            args = JSON.parse(rawArgs);
          } catch {}
          this.config.onToolCall({
            args,
            callId: buffered?.callId || event.call_id || "",
            itemId: key,
            name: buffered?.name || event.name || "",
          });
        }
        this.toolCallBuffers.delete(key);
        return;
      }

      case "error": {
        const detail = readRealtimeErrorDetail(event.error);
        this.config.onError?.(new Error(detail));
        return;
      }

      default: {
        return;
      }
    }
  }

  private handleBargeIn(): void {
    if (this.markQueue.length > 0 && this.responseStartTimestamp !== null) {
      const elapsedMs = this.latestMediaTimestamp - this.responseStartTimestamp;
      if (this.lastAssistantItemId) {
        this.sendEvent({
          audio_end_ms: Math.max(0, elapsedMs),
          content_index: 0,
          item_id: this.lastAssistantItemId,
          type: "conversation.item.truncate",
        });
      }
      this.config.onClearAudio();
      this.markQueue = [];
      this.lastAssistantItemId = null;
      this.responseStartTimestamp = null;
      return;
    }
    this.config.onClearAudio();
  }

  private sendMark(): void {
    const markName = `audio-${Date.now()}`;
    this.markQueue.push(markName);
    this.config.onMark?.(markName);
  }

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }
}

export function buildOpenAIRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    autoSelectOrder: 10,
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OpenAI API key missing");
      }
      return new OpenAIRealtimeVoiceBridge({
        ...req,
        apiKey,
        azureApiVersion: config.azureApiVersion,
        azureDeployment: config.azureDeployment,
        azureEndpoint: config.azureEndpoint,
        model: config.model,
        prefixPaddingMs: config.prefixPaddingMs,
        silenceDurationMs: config.silenceDurationMs,
        temperature: config.temperature,
        vadThreshold: config.vadThreshold,
        voice: config.voice,
      });
    },
    id: "openai",
    isConfigured: ({ providerConfig }) =>
      Boolean(normalizeProviderConfig(providerConfig).apiKey || process.env.OPENAI_API_KEY),
    label: "OpenAI Realtime Voice",
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
  };
}

export type { OpenAIRealtimeVoiceProviderConfig };
