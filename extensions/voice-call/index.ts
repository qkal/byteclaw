import { Type } from "@sinclair/typebox";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  type GatewayRequestHandlerOptions,
  type OpenClawPluginApi,
  definePluginEntry,
} from "./api.js";
import { type VoiceCallRuntime, createVoiceCallRuntime } from "./runtime-entry.js";
import { registerVoiceCallCli } from "./src/cli.js";
import {
  formatVoiceCallLegacyConfigWarnings,
  normalizeVoiceCallLegacyConfigInput,
  parseVoiceCallPluginConfig,
} from "./src/config-compat.js";
import {
  type VoiceCallConfig,
  resolveVoiceCallConfig,
  validateProviderConfig,
} from "./src/config.js";
import type { CoreConfig } from "./src/core-bridge.js";

const voiceCallConfigSchema = {
  parse(value: unknown): VoiceCallConfig {
    const normalized = normalizeVoiceCallLegacyConfigInput(value);
    const enabled = typeof normalized.enabled === "boolean" ? normalized.enabled : true;
    return parseVoiceCallPluginConfig({
      ...normalized,
      enabled,
      provider: normalized.provider ?? (enabled ? "mock" : undefined),
    });
  },
  uiHints: {
    allowFrom: { label: "Inbound Allowlist" },
    fromNumber: { label: "From Number", placeholder: "+15550001234" },
    inboundGreeting: { advanced: true, label: "Inbound Greeting" },
    inboundPolicy: { label: "Inbound Policy" },
    "outbound.defaultMode": { label: "Default Call Mode" },
    "outbound.notifyHangupDelaySec": {
      advanced: true,
      label: "Notify Hangup Delay (sec)",
    },
    provider: {
      help: "Use twilio, telnyx, or mock for dev/no-network.",
      label: "Provider",
    },
    publicUrl: { advanced: true, label: "Public Webhook URL" },
    "realtime.enabled": { advanced: true, label: "Enable Realtime Voice" },
    "realtime.instructions": { advanced: true, label: "Realtime Instructions" },
    "realtime.provider": {
      advanced: true,
      help: "Uses the first registered realtime voice provider when unset.",
      label: "Realtime Voice Provider",
    },
    "realtime.providers": { advanced: true, label: "Realtime Provider Config" },
    "realtime.streamPath": { advanced: true, label: "Realtime Stream Path" },
    responseModel: {
      advanced: true,
      help: "Optional override. Falls back to the runtime default model when unset.",
      label: "Response Model",
    },
    responseSystemPrompt: { advanced: true, label: "Response System Prompt" },
    responseTimeoutMs: { advanced: true, label: "Response Timeout (ms)" },
    "serve.bind": { label: "Webhook Bind" },
    "serve.path": { label: "Webhook Path" },
    "serve.port": { label: "Webhook Port" },
    skipSignatureVerification: {
      advanced: true,
      label: "Skip Signature Verification",
    },
    store: { advanced: true, label: "Call Log Store Path" },
    "streaming.enabled": { advanced: true, label: "Enable Streaming" },
    "streaming.provider": {
      advanced: true,
      help: "Uses the first registered realtime transcription provider when unset.",
      label: "Streaming Provider",
    },
    "streaming.providers": { advanced: true, label: "Streaming Provider Config" },
    "streaming.streamPath": { advanced: true, label: "Media Stream Path" },
    "tailscale.mode": { advanced: true, label: "Tailscale Mode" },
    "tailscale.path": { advanced: true, label: "Tailscale Path" },
    "telnyx.apiKey": { label: "Telnyx API Key", sensitive: true },
    "telnyx.connectionId": { label: "Telnyx Connection ID" },
    "telnyx.publicKey": { label: "Telnyx Public Key", sensitive: true },
    toNumber: { label: "Default To Number", placeholder: "+15550001234" },
    "tts.provider": {
      advanced: true,
      help: "Deep-merges with messages.tts (Microsoft is ignored for calls).",
      label: "TTS Provider Override",
    },
    "tts.providers": { advanced: true, label: "TTS Provider Config" },
    "tunnel.allowNgrokFreeTierLoopbackBypass": {
      advanced: true,
      label: "Allow ngrok Free Tier (Loopback Bypass)",
    },
    "tunnel.ngrokAuthToken": {
      advanced: true,
      label: "ngrok Auth Token",
      sensitive: true,
    },
    "tunnel.ngrokDomain": { advanced: true, label: "ngrok Domain" },
    "tunnel.provider": { advanced: true, label: "Tunnel Provider" },
    "twilio.accountSid": { label: "Twilio Account SID" },
    "twilio.authToken": { label: "Twilio Auth Token", sensitive: true },
  },
};

const VoiceCallToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("initiate_call"),
    message: Type.String({ description: "Intro message" }),
    mode: Type.Optional(Type.Union([Type.Literal("notify"), Type.Literal("conversation")])),
    to: Type.Optional(Type.String({ description: "Call target" })),
  }),
  Type.Object({
    action: Type.Literal("continue_call"),
    callId: Type.String({ description: "Call ID" }),
    message: Type.String({ description: "Follow-up message" }),
  }),
  Type.Object({
    action: Type.Literal("speak_to_user"),
    callId: Type.String({ description: "Call ID" }),
    message: Type.String({ description: "Message to speak" }),
  }),
  Type.Object({
    action: Type.Literal("end_call"),
    callId: Type.String({ description: "Call ID" }),
  }),
  Type.Object({
    action: Type.Literal("get_status"),
    callId: Type.String({ description: "Call ID" }),
  }),
  Type.Object({
    message: Type.Optional(Type.String({ description: "Optional intro message" })),
    mode: Type.Optional(Type.Union([Type.Literal("call"), Type.Literal("status")])),
    sid: Type.Optional(Type.String({ description: "Call SID" })),
    to: Type.Optional(Type.String({ description: "Call target" })),
  }),
]);

export default definePluginEntry({
  configSchema: voiceCallConfigSchema,
  description: "Voice-call plugin with Telnyx/Twilio/Plivo providers",
  id: "voice-call",
  name: "Voice Call",
  register(api: OpenClawPluginApi) {
    const config = resolveVoiceCallConfig(voiceCallConfigSchema.parse(api.pluginConfig));
    const validation = validateProviderConfig(config);

    if (api.pluginConfig && typeof api.pluginConfig === "object") {
      for (const warning of formatVoiceCallLegacyConfigWarnings({
        configPathPrefix: "plugins.entries.voice-call.config",
        doctorFixCommand: "openclaw doctor --fix",
        value: api.pluginConfig,
      })) {
        api.logger.warn(warning);
      }
    }

    let runtimePromise: Promise<VoiceCallRuntime> | null = null;
    let runtime: VoiceCallRuntime | null = null;

    const ensureRuntime = async () => {
      if (!config.enabled) {
        throw new Error("Voice call disabled in plugin config");
      }
      if (!validation.valid) {
        throw new Error(validation.errors.join("; "));
      }
      if (runtime) {
        return runtime;
      }
      if (!runtimePromise) {
        runtimePromise = createVoiceCallRuntime({
          agentRuntime: api.runtime.agent,
          config,
          coreConfig: api.config as CoreConfig,
          fullConfig: api.config,
          logger: api.logger,
          ttsRuntime: api.runtime.tts,
        });
      }
      try {
        runtime = await runtimePromise;
      } catch (error) {
        // Reset so the next call can retry instead of caching the
        // rejected promise forever (which also leaves the port orphaned
        // if the server started before the failure).  See: #32387
        runtimePromise = null;
        throw error;
      }
      return runtime;
    };

    const sendError = (respond: (ok: boolean, payload?: unknown) => void, err: unknown) => {
      respond(false, { error: formatErrorMessage(err) });
    };

    const resolveCallMessageRequest = async (params: GatewayRequestHandlerOptions["params"]) => {
      const callId = normalizeOptionalString(params?.callId) ?? "";
      const message = normalizeOptionalString(params?.message) ?? "";
      if (!callId || !message) {
        return { error: "callId and message required" } as const;
      }
      const rt = await ensureRuntime();
      return { callId, message, rt } as const;
    };
    const initiateCallAndRespond = async (params: {
      rt: VoiceCallRuntime;
      respond: GatewayRequestHandlerOptions["respond"];
      to: string;
      message?: string;
      mode?: "notify" | "conversation";
    }) => {
      const result = await params.rt.manager.initiateCall(params.to, undefined, {
        message: params.message,
        mode: params.mode,
      });
      if (!result.success) {
        params.respond(false, { error: result.error || "initiate failed" });
        return;
      }
      params.respond(true, { callId: result.callId, initiated: true });
    };

    const respondToCallMessageAction = async (params: {
      requestParams: GatewayRequestHandlerOptions["params"];
      respond: GatewayRequestHandlerOptions["respond"];
      action: (
        request: Exclude<Awaited<ReturnType<typeof resolveCallMessageRequest>>, { error: string }>,
      ) => Promise<{
        success: boolean;
        error?: string;
        transcript?: string;
      }>;
      failure: string;
      includeTranscript?: boolean;
    }) => {
      const request = await resolveCallMessageRequest(params.requestParams);
      if ("error" in request) {
        params.respond(false, { error: request.error });
        return;
      }
      const result = await params.action(request);
      if (!result.success) {
        params.respond(false, { error: result.error || params.failure });
        return;
      }
      params.respond(
        true,
        params.includeTranscript
          ? { success: true, transcript: result.transcript }
          : { success: true },
      );
    };

    api.registerGatewayMethod(
      "voicecall.initiate",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const message = normalizeOptionalString(params?.message) ?? "";
          if (!message) {
            respond(false, { error: "message required" });
            return;
          }
          const rt = await ensureRuntime();
          const to = normalizeOptionalString(params?.to) ?? rt.config.toNumber;
          if (!to) {
            respond(false, { error: "to required" });
            return;
          }
          const mode =
            params?.mode === "notify" || params?.mode === "conversation" ? params.mode : undefined;
          await initiateCallAndRespond({
            message,
            mode,
            respond,
            rt,
            to,
          });
        } catch (error) {
          sendError(respond, error);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.continue",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          await respondToCallMessageAction({
            action: (request) => request.rt.manager.continueCall(request.callId, request.message),
            failure: "continue failed",
            includeTranscript: true,
            requestParams: params,
            respond,
          });
        } catch (error) {
          sendError(respond, error);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.speak",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          await respondToCallMessageAction({
            action: (request) => request.rt.manager.speak(request.callId, request.message),
            failure: "speak failed",
            requestParams: params,
            respond,
          });
        } catch (error) {
          sendError(respond, error);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.end",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const callId = normalizeOptionalString(params?.callId) ?? "";
          if (!callId) {
            respond(false, { error: "callId required" });
            return;
          }
          const rt = await ensureRuntime();
          const result = await rt.manager.endCall(callId);
          if (!result.success) {
            respond(false, { error: result.error || "end failed" });
            return;
          }
          respond(true, { success: true });
        } catch (error) {
          sendError(respond, error);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw =
            normalizeOptionalString(params?.callId) ?? normalizeOptionalString(params?.sid) ?? "";
          if (!raw) {
            respond(false, { error: "callId required" });
            return;
          }
          const rt = await ensureRuntime();
          const call = rt.manager.getCall(raw) || rt.manager.getCallByProviderCallId(raw);
          if (!call) {
            respond(true, { found: false });
            return;
          }
          respond(true, { call, found: true });
        } catch (error) {
          sendError(respond, error);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.start",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const to = normalizeOptionalString(params?.to) ?? "";
          const message = normalizeOptionalString(params?.message) ?? "";
          if (!to) {
            respond(false, { error: "to required" });
            return;
          }
          const rt = await ensureRuntime();
          await initiateCallAndRespond({
            message: message || undefined,
            respond,
            rt,
            to,
          });
        } catch (error) {
          sendError(respond, error);
        }
      },
    );

    api.registerTool({
      description: "Make phone calls and have voice conversations via the voice-call plugin.",
      async execute(_toolCallId, params) {
        const json = (payload: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const rt = await ensureRuntime();

          if (typeof params?.action === "string") {
            switch (params.action) {
              case "initiate_call": {
                const message = normalizeOptionalString(params.message) ?? "";
                if (!message) {
                  throw new Error("message required");
                }
                const to = normalizeOptionalString(params.to) ?? rt.config.toNumber;
                if (!to) {
                  throw new Error("to required");
                }
                const result = await rt.manager.initiateCall(to, undefined, {
                  message,
                  mode:
                    params.mode === "notify" || params.mode === "conversation"
                      ? params.mode
                      : undefined,
                });
                if (!result.success) {
                  throw new Error(result.error || "initiate failed");
                }
                return json({ callId: result.callId, initiated: true });
              }
              case "continue_call": {
                const callId = normalizeOptionalString(params.callId) ?? "";
                const message = normalizeOptionalString(params.message) ?? "";
                if (!callId || !message) {
                  throw new Error("callId and message required");
                }
                const result = await rt.manager.continueCall(callId, message);
                if (!result.success) {
                  throw new Error(result.error || "continue failed");
                }
                return json({ success: true, transcript: result.transcript });
              }
              case "speak_to_user": {
                const callId = normalizeOptionalString(params.callId) ?? "";
                const message = normalizeOptionalString(params.message) ?? "";
                if (!callId || !message) {
                  throw new Error("callId and message required");
                }
                const result = await rt.manager.speak(callId, message);
                if (!result.success) {
                  throw new Error(result.error || "speak failed");
                }
                return json({ success: true });
              }
              case "end_call": {
                const callId = normalizeOptionalString(params.callId) ?? "";
                if (!callId) {
                  throw new Error("callId required");
                }
                const result = await rt.manager.endCall(callId);
                if (!result.success) {
                  throw new Error(result.error || "end failed");
                }
                return json({ success: true });
              }
              case "get_status": {
                const callId = normalizeOptionalString(params.callId) ?? "";
                if (!callId) {
                  throw new Error("callId required");
                }
                const call =
                  rt.manager.getCall(callId) || rt.manager.getCallByProviderCallId(callId);
                return json(call ? { found: true, call } : { found: false });
              }
            }
          }

          const mode = params?.mode ?? "call";
          if (mode === "status") {
            const sid = normalizeOptionalString(params.sid) ?? "";
            if (!sid) {
              throw new Error("sid required for status");
            }
            const call = rt.manager.getCall(sid) || rt.manager.getCallByProviderCallId(sid);
            return json(call ? { found: true, call } : { found: false });
          }

          const to = normalizeOptionalString(params.to) ?? rt.config.toNumber;
          if (!to) {
            throw new Error("to required for call");
          }
          const result = await rt.manager.initiateCall(to, undefined, {
            message: normalizeOptionalString(params.message),
          });
          if (!result.success) {
            throw new Error(result.error || "initiate failed");
          }
          return json({ callId: result.callId, initiated: true });
        } catch (err) {
          return json({
            error: formatErrorMessage(err),
          });
        }
      },
      label: "Voice Call",
      name: "voice_call",
      parameters: VoiceCallToolSchema,
    });

    api.registerCli(
      ({ program }) =>
        registerVoiceCallCli({
          config,
          ensureRuntime,
          logger: api.logger,
          program,
        }),
      { commands: ["voicecall"] },
    );

    api.registerService({
      id: "voicecall",
      start: async () => {
        if (!config.enabled) {
          return;
        }
        try {
          await ensureRuntime();
        } catch (error) {
          api.logger.error(`[voice-call] Failed to start runtime: ${formatErrorMessage(error)}`);
        }
      },
      stop: async () => {
        if (!runtimePromise) {
          return;
        }
        try {
          const rt = await runtimePromise;
          await rt.stop();
        } finally {
          runtimePromise = null;
          runtime = null;
        }
      },
    });
  },
});
