import type { VoiceCallConfig } from "./config.js";

export function createVoiceCallBaseConfig(params?: {
  provider?: "telnyx" | "twilio" | "plivo" | "mock";
  tunnelProvider?: "none" | "ngrok";
}): VoiceCallConfig {
  return {
    allowFrom: [],
    enabled: true,
    fromNumber: "+15550001234",
    inboundPolicy: "disabled",
    maxConcurrentCalls: 1,
    maxDurationSeconds: 300,
    outbound: { defaultMode: "notify", notifyHangupDelaySec: 3 },
    provider: params?.provider ?? "mock",
    realtime: {
      enabled: false,
      providers: {},
      streamPath: "/voice/stream/realtime",
      tools: [],
    },
    responseTimeoutMs: 30_000,
    ringTimeoutMs: 30_000,
    serve: { bind: "127.0.0.1", path: "/voice/webhook", port: 3334 },
    silenceTimeoutMs: 800,
    skipSignatureVerification: false,
    staleCallReaperSeconds: 600,
    streaming: {
      enabled: false,
      maxConnections: 128,
      maxPendingConnections: 32,
      maxPendingConnectionsPerIp: 4,
      preStartTimeoutMs: 5000,
      providers: {
        openai: {
          model: "gpt-4o-transcribe",
          silenceDurationMs: 800,
          vadThreshold: 0.5,
        },
      },
      streamPath: "/voice/stream",
    },
    tailscale: { mode: "off", path: "/voice/webhook" },
    transcriptTimeoutMs: 180_000,
    tts: {
      provider: "openai",
      providers: {
        openai: { model: "gpt-4o-mini-tts", voice: "coral" },
      },
    },
    tunnel: {
      allowNgrokFreeTierLoopbackBypass: false,
      provider: params?.tunnelProvider ?? "none",
    },
    webhookSecurity: {
      allowedHosts: [],
      trustForwardingHeaders: false,
      trustedProxyIPs: [],
    },
  };
}
