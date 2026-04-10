import { logVerbose } from "../../globals.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
} from "../../tts/provider-registry.js";
import {
  getLastTtsAttempt,
  getResolvedSpeechProviderConfig,
  getTtsMaxLength,
  getTtsProvider,
  isSummarizationEnabled,
  isTtsEnabled,
  isTtsProviderConfigured,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  setLastTtsAttempt,
  setSummarizationEnabled,
  setTtsEnabled,
  setTtsMaxLength,
  setTtsProvider,
  textToSpeech,
} from "../../tts/tts.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandler } from "./commands-types.js";

interface ParsedTtsCommand {
  action: string;
  args: string;
}

type TtsAttemptDetail = NonNullable<
  NonNullable<ReturnType<typeof getLastTtsAttempt>>["attempts"]
>[number];

function parseTtsCommand(normalized: string): ParsedTtsCommand | null {
  // Accept `/tts` and `/tts <action> [args]` as a single control surface.
  if (normalized === "/tts") {
    return { action: "status", args: "" };
  }
  if (!normalized.startsWith("/tts ")) {
    return null;
  }
  const rest = normalized.slice(5).trim();
  if (!rest) {
    return { action: "status", args: "" };
  }
  const [action, ...tail] = rest.split(/\s+/);
  return {
    action: normalizeOptionalLowercaseString(action) ?? "",
    args: normalizeOptionalString(tail.join(" ")) ?? "",
  };
}

function formatAttemptDetails(attempts: TtsAttemptDetail[] | undefined): string | undefined {
  if (!attempts || attempts.length === 0) {
    return undefined;
  }
  return attempts
    .map((attempt) => {
      const reason = attempt.reasonCode === "success" ? "ok" : attempt.reasonCode;
      const latency = Number.isFinite(attempt.latencyMs) ? ` ${attempt.latencyMs}ms` : "";
      return `${attempt.provider}:${attempt.outcome}(${reason})${latency}`;
    })
    .join(", ");
}

function ttsUsage(): ReplyPayload {
  // Keep usage in one place so help/validation stays consistent.
  return {
    text:
      `🔊 **TTS (Text-to-Speech) Help**\n\n` +
      `**Commands:**\n` +
      `• /tts on — Enable automatic TTS for replies\n` +
      `• /tts off — Disable TTS\n` +
      `• /tts status — Show current settings\n` +
      `• /tts provider [name] — View/change provider\n` +
      `• /tts limit [number] — View/change text limit\n` +
      `• /tts summary [on|off] — View/change auto-summary\n` +
      `• /tts audio <text> — Generate audio from text\n\n` +
      `**Providers:**\n` +
      `Use /tts provider to list the registered speech providers and their status.\n\n` +
      `**Text Limit (default: 1500, max: 4096):**\n` +
      `When text exceeds the limit:\n` +
      `• Summary ON: AI summarizes, then generates audio\n` +
      `• Summary OFF: Truncates text, then generates audio\n\n` +
      `**Examples:**\n` +
      `/tts provider <id>\n` +
      `/tts limit 2000\n` +
      `/tts audio Hello, this is a test!`,
  };
}

export const handleTtsCommands: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseTtsCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring TTS command from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const config = resolveTtsConfig(params.cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const {action} = parsed;
  const {args} = parsed;

  if (action === "help") {
    return { reply: ttsUsage(), shouldContinue: false };
  }

  if (action === "on") {
    setTtsEnabled(prefsPath, true);
    return { reply: { text: "🔊 TTS enabled." }, shouldContinue: false };
  }

  if (action === "off") {
    setTtsEnabled(prefsPath, false);
    return { reply: { text: "🔇 TTS disabled." }, shouldContinue: false };
  }

  if (action === "audio") {
    if (!args.trim()) {
      return {
        reply: {
          text:
            `🎤 Generate audio from text.\n\n` +
            `Usage: /tts audio <text>\n` +
            `Example: /tts audio Hello, this is a test!`,
        },
        shouldContinue: false,
      };
    }

    const start = Date.now();
    const result = await textToSpeech({
      cfg: params.cfg,
      channel: params.command.channel,
      prefsPath,
      text: args,
    });

    if (result.success && result.audioPath) {
      // Store last attempt for `/tts status`.
      setLastTtsAttempt({
        attemptedProviders: result.attemptedProviders,
        attempts: result.attempts,
        fallbackFrom: result.fallbackFrom,
        latencyMs: result.latencyMs,
        provider: result.provider,
        success: true,
        summarized: false,
        textLength: args.length,
        timestamp: Date.now(),
      });
      const payload: ReplyPayload = {
        audioAsVoice: result.voiceCompatible === true,
        mediaUrl: result.audioPath,
      };
      return { reply: payload, shouldContinue: false };
    }

    // Store failure details for `/tts status`.
    setLastTtsAttempt({
      attemptedProviders: result.attemptedProviders,
      attempts: result.attempts,
      error: result.error,
      latencyMs: Date.now() - start,
      success: false,
      summarized: false,
      textLength: args.length,
      timestamp: Date.now(),
    });
    return {
      reply: { text: `❌ Error generating audio: ${result.error ?? "unknown error"}` },
      shouldContinue: false,
    };
  }

  if (action === "provider") {
    const currentProvider = getTtsProvider(config, prefsPath);
    if (!args.trim()) {
      const providers = listSpeechProviders(params.cfg);
      return {
        reply: {
          text:
            `🎙️ TTS provider\n` +
            `Primary: ${currentProvider}\n` +
            providers
              .map(
                (provider) =>
                  `${provider.label}: ${
                    provider.isConfigured({
                      cfg: params.cfg,
                      providerConfig: getResolvedSpeechProviderConfig(
                        config,
                        provider.id,
                        params.cfg,
                      ),
                      timeoutMs: config.timeoutMs,
                    })
                      ? "✅"
                      : "❌"
                  }`,
              )
              .join("\n") +
            `\nUsage: /tts provider <id>`,
        },
        shouldContinue: false,
      };
    }

    const requested = normalizeOptionalLowercaseString(args) ?? "";
    const resolvedProvider = getSpeechProvider(requested, params.cfg);
    if (!resolvedProvider) {
      return { reply: ttsUsage(), shouldContinue: false };
    }

    const nextProvider = canonicalizeSpeechProviderId(requested, params.cfg) ?? resolvedProvider.id;
    setTtsProvider(prefsPath, nextProvider);
    return {
      reply: { text: `✅ TTS provider set to ${nextProvider}.` },
      shouldContinue: false,
    };
  }

  if (action === "limit") {
    if (!args.trim()) {
      const currentLimit = getTtsMaxLength(prefsPath);
      return {
        reply: {
          text:
            `📏 TTS limit: ${currentLimit} characters.\n\n` +
            `Text longer than this triggers summary (if enabled).\n` +
            `Range: 100-4096 chars (Telegram max).\n\n` +
            `To change: /tts limit <number>\n` +
            `Example: /tts limit 2000`,
        },
        shouldContinue: false,
      };
    }
    const next = Number.parseInt(args.trim(), 10);
    if (!Number.isFinite(next) || next < 100 || next > 4096) {
      return {
        reply: { text: "❌ Limit must be between 100 and 4096 characters." },
        shouldContinue: false,
      };
    }
    setTtsMaxLength(prefsPath, next);
    return {
      reply: { text: `✅ TTS limit set to ${next} characters.` },
      shouldContinue: false,
    };
  }

  if (action === "summary") {
    if (!args.trim()) {
      const enabled = isSummarizationEnabled(prefsPath);
      const maxLen = getTtsMaxLength(prefsPath);
      return {
        reply: {
          text:
            `📝 TTS auto-summary: ${enabled ? "on" : "off"}.\n\n` +
            `When text exceeds ${maxLen} chars:\n` +
            `• ON: summarizes text, then generates audio\n` +
            `• OFF: truncates text, then generates audio\n\n` +
            `To change: /tts summary on | off`,
        },
        shouldContinue: false,
      };
    }
    const requested = normalizeOptionalLowercaseString(args) ?? "";
    if (requested !== "on" && requested !== "off") {
      return { reply: ttsUsage(), shouldContinue: false };
    }
    setSummarizationEnabled(prefsPath, requested === "on");
    return {
      reply: {
        text: requested === "on" ? "✅ TTS auto-summary enabled." : "❌ TTS auto-summary disabled.",
      },
      shouldContinue: false,
    };
  }

  if (action === "status") {
    const enabled = isTtsEnabled(config, prefsPath);
    const provider = getTtsProvider(config, prefsPath);
    const hasKey = isTtsProviderConfigured(config, provider, params.cfg);
    const maxLength = getTtsMaxLength(prefsPath);
    const summarize = isSummarizationEnabled(prefsPath);
    const last = getLastTtsAttempt();
    const lines = [
      "📊 TTS status",
      `State: ${enabled ? "✅ enabled" : "❌ disabled"}`,
      `Provider: ${provider} (${hasKey ? "✅ configured" : "❌ not configured"})`,
      `Text limit: ${maxLength} chars`,
      `Auto-summary: ${summarize ? "on" : "off"}`,
    ];
    if (last) {
      const timeAgo = Math.round((Date.now() - last.timestamp) / 1000);
      lines.push("");
      lines.push(`Last attempt (${timeAgo}s ago): ${last.success ? "✅" : "❌"}`);
      lines.push(`Text: ${last.textLength} chars${last.summarized ? " (summarized)" : ""}`);
      if (last.success) {
        lines.push(`Provider: ${last.provider ?? "unknown"}`);
        if (last.fallbackFrom && last.provider && last.fallbackFrom !== last.provider) {
          lines.push(`Fallback: ${last.fallbackFrom} -> ${last.provider}`);
        }
        if (last.attemptedProviders && last.attemptedProviders.length > 1) {
          lines.push(`Attempts: ${last.attemptedProviders.join(" -> ")}`);
        }
        const details = formatAttemptDetails(last.attempts);
        if (details) {
          lines.push(`Attempt details: ${details}`);
        }
        lines.push(`Latency: ${last.latencyMs ?? 0}ms`);
      } else if (last.error) {
        lines.push(`Error: ${last.error}`);
        if (last.attemptedProviders && last.attemptedProviders.length > 0) {
          lines.push(`Attempts: ${last.attemptedProviders.join(" -> ")}`);
        }
        const details = formatAttemptDetails(last.attempts);
        if (details) {
          lines.push(`Attempt details: ${details}`);
        }
      }
    }
    return { reply: { text: lines.join("\n") }, shouldContinue: false };
  }

  return { reply: ttsUsage(), shouldContinue: false };
};
