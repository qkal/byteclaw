import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Readable } from "node:stream";
import { ChannelType, type Client, ReadyListener } from "@buape/carbon";
import type { VoicePlugin } from "@buape/carbon/voice";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { agentCommandFromIngress } from "openclaw/plugin-sdk/agent-runtime";
import { type ResolvedTtsConfig, resolveTtsConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { DiscordAccountConfig, TtsConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { parseTtsDirectives } from "openclaw/plugin-sdk/speech";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { formatMention } from "../mentions.js";
import { normalizeDiscordSlug, resolveDiscordOwnerAccess } from "../monitor/allow-list.js";
import { formatDiscordUserTag } from "../monitor/format.js";
import { getDiscordRuntime } from "../runtime.js";
import { authorizeDiscordVoiceIngress } from "./access.js";
import {
  type VoiceCaptureState,
  beginVoiceCapture,
  clearVoiceCaptureFinalizeTimer,
  createVoiceCaptureState,
  finishVoiceCapture,
  getActiveVoiceCapture,
  isVoiceCaptureActive,
  scheduleVoiceCaptureFinalize,
  stopVoiceCaptureState,
} from "./capture-state.js";
import { formatVoiceIngressPrompt } from "./prompt.js";
import {
  DAVE_RECEIVE_PASSTHROUGH_INITIAL_EXPIRY_SECONDS,
  DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
  type VoiceReceiveRecoveryState,
  analyzeVoiceReceiveError,
  createVoiceReceiveRecoveryState,
  finishVoiceDecryptRecovery,
  noteVoiceDecryptFailure,
  resetVoiceReceiveRecoveryState,
  enableDaveReceivePassthrough as tryEnableDaveReceivePassthrough,
} from "./receive-recovery.js";
import { sanitizeVoiceReplyTextForSpeech } from "./sanitize.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";

const require = createRequire(import.meta.url);

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BIT_DEPTH = 16;
const MIN_SEGMENT_SECONDS = 0.35;
const CAPTURE_FINALIZE_GRACE_MS = 1200;
const VOICE_CONNECT_READY_TIMEOUT_MS = 15_000;
const PLAYBACK_READY_TIMEOUT_MS = 60_000;
const SPEAKING_READY_TIMEOUT_MS = 60_000;
const SPEAKER_CONTEXT_CACHE_TTL_MS = 60_000;

const logger = createSubsystemLogger("discord/voice");

const logVoiceVerbose = (message: string) => {
  logVerbose(`discord voice: ${message}`);
};

interface VoiceOperationResult {
  ok: boolean;
  message: string;
  channelId?: string;
  guildId?: string;
}

interface VoiceSessionEntry {
  guildId: string;
  guildName?: string;
  channelId: string;
  channelName?: string;
  sessionChannelId: string;
  route: ReturnType<typeof resolveAgentRoute>;
  connection: import("@discordjs/voice").VoiceConnection;
  player: import("@discordjs/voice").AudioPlayer;
  playbackQueue: Promise<void>;
  processingQueue: Promise<void>;
  capture: VoiceCaptureState;
  receiveRecovery: VoiceReceiveRecoveryState;
  stop: () => void;
}

function mergeTtsConfig(base: TtsConfig, override?: TtsConfig): TtsConfig {
  if (!override) {
    return base;
  }
  const baseProviders = base.providers ?? {};
  const overrideProviders = override.providers ?? {};
  const mergedProviders = Object.fromEntries(
    [...new Set([...Object.keys(baseProviders), ...Object.keys(overrideProviders)])].map(
      (providerId) => {
        const baseProvider = baseProviders[providerId] ?? {};
        const overrideProvider = overrideProviders[providerId] ?? {};
        return [
          providerId,
          {
            ...baseProvider,
            ...overrideProvider,
          },
        ];
      },
    ),
  );
  return {
    ...base,
    ...override,
    modelOverrides: {
      ...base.modelOverrides,
      ...override.modelOverrides,
    },
    ...(Object.keys(mergedProviders).length === 0 ? {} : { providers: mergedProviders }),
  };
}

function resolveVoiceTtsConfig(params: { cfg: OpenClawConfig; override?: TtsConfig }): {
  cfg: OpenClawConfig;
  resolved: ResolvedTtsConfig;
} {
  if (!params.override) {
    return { cfg: params.cfg, resolved: resolveTtsConfig(params.cfg) };
  }
  const base = params.cfg.messages?.tts ?? {};
  const merged = mergeTtsConfig(base, params.override);
  const messages = params.cfg.messages ?? {};
  const cfg = {
    ...params.cfg,
    messages: {
      ...messages,
      tts: merged,
    },
  };
  return { cfg, resolved: resolveTtsConfig(cfg) };
}

function buildWavBuffer(pcm: Buffer): Buffer {
  const blockAlign = (CHANNELS * BIT_DEPTH) / 8;
  const byteRate = SAMPLE_RATE * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BIT_DEPTH, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

interface OpusDecoder {
  decode: (buffer: Buffer) => Buffer;
}

interface OpusDecoderFactory {
  load: () => OpusDecoder;
  name: string;
}

let warnedOpusMissing = false;
let cachedOpusDecoderFactory: OpusDecoderFactory | null | "unresolved" = "unresolved";

function resolveOpusDecoderFactory(): OpusDecoderFactory | null {
  const factories: OpusDecoderFactory[] = [
    {
      load: () => {
        const DiscordOpus = require("@discordjs/opus") as {
          OpusEncoder: new (
            sampleRate: number,
            channels: number,
          ) => {
            decode: (buffer: Buffer) => Buffer;
          };
        };
        return new DiscordOpus.OpusEncoder(SAMPLE_RATE, CHANNELS);
      },
      name: "@discordjs/opus",
    },
    {
      load: () => {
        const OpusScript = require("opusscript") as {
          new (sampleRate: number, channels: number, application: number): OpusDecoder;
          Application: { AUDIO: number };
        };
        return new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
      },
      name: "opusscript",
    },
  ];

  const failures: string[] = [];
  for (const factory of factories) {
    try {
      factory.load();
      return factory;
    } catch (error) {
      failures.push(`${factory.name}: ${formatErrorMessage(error)}`);
    }
  }

  if (!warnedOpusMissing) {
    warnedOpusMissing = true;
    logger.warn(
      `discord voice: no usable opus decoder available (${failures.join("; ")}); cannot decode voice audio`,
    );
  }
  return null;
}

function createOpusDecoder(): { decoder: OpusDecoder; name: string } | null {
  const factory = getOrCreateOpusDecoderFactory();
  if (!factory) {
    return null;
  }
  return { decoder: factory.load(), name: factory.name };
}

function getOrCreateOpusDecoderFactory(): OpusDecoderFactory | null {
  if (cachedOpusDecoderFactory !== "unresolved") {
    return cachedOpusDecoderFactory;
  }
  cachedOpusDecoderFactory = resolveOpusDecoderFactory();
  return cachedOpusDecoderFactory;
}

async function decodeOpusStream(stream: Readable): Promise<Buffer> {
  const selected = createOpusDecoder();
  if (!selected) {
    return Buffer.alloc(0);
  }
  logVoiceVerbose(`opus decoder: ${selected.name}`);
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) {
        continue;
      }
      const decoded = selected.decoder.decode(chunk);
      if (decoded && decoded.length > 0) {
        chunks.push(Buffer.from(decoded));
      }
    }
  } catch (error) {
    if (shouldLogVerbose()) {
      logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(error)}`);
    }
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}

function estimateDurationSeconds(pcm: Buffer): number {
  const bytesPerSample = (BIT_DEPTH / 8) * CHANNELS;
  if (bytesPerSample <= 0) {
    return 0;
  }
  return pcm.length / (bytesPerSample * SAMPLE_RATE);
}

async function writeWavFile(pcm: Buffer): Promise<{ path: string; durationSeconds: number }> {
  const tempDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "discord-voice-"));
  const filePath = path.join(tempDir, `segment-${randomUUID()}.wav`);
  const wav = buildWavBuffer(pcm);
  await fs.writeFile(filePath, wav);
  scheduleTempCleanup(tempDir);
  return { durationSeconds: estimateDurationSeconds(pcm), path: filePath };
}

function scheduleTempCleanup(tempDir: string, delayMs: number = 30 * 60 * 1000): void {
  const timer = setTimeout(() => {
    fs.rm(tempDir, { force: true, recursive: true }).catch((error) => {
      if (shouldLogVerbose()) {
        logVerbose(`discord voice: temp cleanup failed for ${tempDir}: ${formatErrorMessage(error)}`);
      }
    });
  }, delayMs);
  timer.unref();
}

async function transcribeAudio(params: {
  cfg: OpenClawConfig;
  agentId: string;
  filePath: string;
}): Promise<string | undefined> {
  const result = await getDiscordRuntime().mediaUnderstanding.transcribeAudioFile({
    agentDir: resolveAgentDir(params.cfg, params.agentId),
    cfg: params.cfg,
    filePath: params.filePath,
    mime: "audio/wav",
  });
  return normalizeOptionalString(result.text);
}

export class DiscordVoiceManager {
  private sessions = new Map<string, VoiceSessionEntry>();
  private botUserId?: string;
  private readonly voiceEnabled: boolean;
  private autoJoinTask: Promise<void> | null = null;
  private readonly ownerAllowFrom: string[];
  private readonly speakerContextCache = new Map<
    string,
    {
      id: string;
      label: string;
      name?: string;
      tag?: string;
      senderIsOwner: boolean;
      expiresAt: number;
    }
  >();

  constructor(
    private params: {
      client: Client;
      cfg: OpenClawConfig;
      discordConfig: DiscordAccountConfig;
      accountId: string;
      runtime: RuntimeEnv;
      botUserId?: string;
    },
  ) {
    this.botUserId = params.botUserId;
    this.voiceEnabled = params.discordConfig.voice?.enabled !== false;
    this.ownerAllowFrom =
      params.discordConfig.allowFrom ?? params.discordConfig.dm?.allowFrom ?? [];
  }

  setBotUserId(id?: string) {
    if (id) {
      this.botUserId = id;
    }
  }

  isEnabled() {
    return this.voiceEnabled;
  }

  async autoJoin(): Promise<void> {
    if (!this.voiceEnabled) {
      return;
    }
    if (this.autoJoinTask) {
      return this.autoJoinTask;
    }
    this.autoJoinTask = (async () => {
      const entries = this.params.discordConfig.voice?.autoJoin ?? [];
      logVoiceVerbose(`autoJoin: ${entries.length} entries`);
      const seenGuilds = new Set<string>();
      for (const entry of entries) {
        const guildId = entry.guildId.trim();
        if (!guildId) {
          continue;
        }
        if (seenGuilds.has(guildId)) {
          logger.warn(
            `discord voice: autoJoin has multiple entries for guild ${guildId}; skipping`,
          );
          continue;
        }
        seenGuilds.add(guildId);
        logVoiceVerbose(`autoJoin: joining guild ${guildId} channel ${entry.channelId}`);
        await this.join({
          channelId: entry.channelId,
          guildId: entry.guildId,
        });
      }
    })().finally(() => {
      this.autoJoinTask = null;
    });
    return this.autoJoinTask;
  }

  status(): VoiceOperationResult[] {
    return [...this.sessions.values()].map((session) => ({
      channelId: session.channelId,
      guildId: session.guildId,
      message: `connected: guild ${session.guildId} channel ${session.channelId}`,
      ok: true,
    }));
  }

  async join(params: { guildId: string; channelId: string }): Promise<VoiceOperationResult> {
    if (!this.voiceEnabled) {
      return {
        message: "Discord voice is disabled (channels.discord.voice.enabled).",
        ok: false,
      };
    }
    const guildId = params.guildId.trim();
    const channelId = params.channelId.trim();
    if (!guildId || !channelId) {
      return { message: "Missing guildId or channelId.", ok: false };
    }
    logVoiceVerbose(`join requested: guild ${guildId} channel ${channelId}`);

    const existing = this.sessions.get(guildId);
    if (existing && existing.channelId === channelId) {
      logVoiceVerbose(`join: already connected to guild ${guildId} channel ${channelId}`);
      return {
        channelId,
        guildId,
        message: `Already connected to ${formatMention({ channelId })}.`,
        ok: true,
      };
    }
    if (existing) {
      logVoiceVerbose(`join: replacing existing session for guild ${guildId}`);
      await this.leave({ guildId });
    }

    const channelInfo = await this.params.client.fetchChannel(channelId).catch(() => null);
    if (!channelInfo || ("type" in channelInfo && !isVoiceChannel(channelInfo.type))) {
      return { message: `Channel ${channelId} is not a voice channel.`, ok: false };
    }
    const channelGuildId = "guildId" in channelInfo ? channelInfo.guildId : undefined;
    if (channelGuildId && channelGuildId !== guildId) {
      return { message: "Voice channel is not in this guild.", ok: false };
    }

    const voicePlugin = this.params.client.getPlugin<VoicePlugin>("voice");
    if (!voicePlugin) {
      return { message: "Discord voice plugin is not available.", ok: false };
    }

    const adapterCreator = voicePlugin.getGatewayAdapterCreator(guildId);
    const daveEncryption = this.params.discordConfig.voice?.daveEncryption;
    const decryptionFailureTolerance = this.params.discordConfig.voice?.decryptionFailureTolerance;
    logVoiceVerbose(
      `join: DAVE settings encryption=${daveEncryption === false ? "off" : "on"} tolerance=${
        decryptionFailureTolerance ?? "default"
      }`,
    );
    const voiceSdk = loadDiscordVoiceSdk();
    const connection = voiceSdk.joinVoiceChannel({
      adapterCreator,
      channelId,
      daveEncryption,
      decryptionFailureTolerance,
      guildId,
      selfDeaf: false,
      selfMute: false,
    });

    try {
      await voiceSdk.entersState(
        connection,
        voiceSdk.VoiceConnectionStatus.Ready,
        VOICE_CONNECT_READY_TIMEOUT_MS,
      );
      logVoiceVerbose(`join: connected to guild ${guildId} channel ${channelId}`);
    } catch (error) {
      connection.destroy();
      return { message: `Failed to join voice channel: ${formatErrorMessage(error)}`, ok: false };
    }

    const sessionChannelId = channelInfo?.id ?? channelId;
    // Use the voice channel id as the session channel so text chat in the voice channel
    // Shares the same session as spoken audio.
    if (sessionChannelId !== channelId) {
      logVoiceVerbose(
        `join: using session channel ${sessionChannelId} for voice channel ${channelId}`,
      );
    }
    const route = resolveAgentRoute({
      accountId: this.params.accountId,
      cfg: this.params.cfg,
      channel: "discord",
      guildId,
      peer: { id: sessionChannelId, kind: "channel" },
    });

    const player = voiceSdk.createAudioPlayer();
    connection.subscribe(player);

    let speakingHandler: ((userId: string) => void) | undefined;
    let speakingEndHandler: ((userId: string) => void) | undefined;
    let disconnectedHandler: (() => Promise<void>) | undefined;
    let destroyedHandler: (() => void) | undefined;
    let playerErrorHandler: ((err: Error) => void) | undefined;
    const clearSessionIfCurrent = () => {
      const active = this.sessions.get(guildId);
      if (active?.connection === connection) {
        this.sessions.delete(guildId);
      }
    };

    const entry: VoiceSessionEntry = {
      capture: createVoiceCaptureState(),
      channelId,
      channelName:
        channelInfo && "name" in channelInfo && typeof channelInfo.name === "string"
          ? channelInfo.name
          : undefined,
      connection,
      guildId,
      guildName:
        channelInfo &&
        "guild" in channelInfo &&
        channelInfo.guild &&
        typeof channelInfo.guild.name === "string"
          ? channelInfo.guild.name
          : undefined,
      playbackQueue: Promise.resolve(),
      player,
      processingQueue: Promise.resolve(),
      receiveRecovery: createVoiceReceiveRecoveryState(),
      route,
      sessionChannelId,
      stop: () => {
        if (speakingHandler) {
          connection.receiver.speaking.off("start", speakingHandler);
        }
        if (speakingEndHandler) {
          connection.receiver.speaking.off("end", speakingEndHandler);
        }
        stopVoiceCaptureState(entry.capture);
        if (disconnectedHandler) {
          connection.off(voiceSdk.VoiceConnectionStatus.Disconnected, disconnectedHandler);
        }
        if (destroyedHandler) {
          connection.off(voiceSdk.VoiceConnectionStatus.Destroyed, destroyedHandler);
        }
        if (playerErrorHandler) {
          player.off("error", playerErrorHandler);
        }
        player.stop();
        connection.destroy();
      },
    };

    speakingHandler = (userId: string) => {
      void this.handleSpeakingStart(entry, userId).catch((error) => {
        logger.warn(`discord voice: capture failed: ${formatErrorMessage(error)}`);
      });
    };
    speakingEndHandler = (userId: string) => {
      this.scheduleCaptureFinalize(entry, userId, "speaker end");
    };

    disconnectedHandler = async () => {
      try {
        await Promise.race([
          voiceSdk.entersState(connection, voiceSdk.VoiceConnectionStatus.Signalling, 5000),
          voiceSdk.entersState(connection, voiceSdk.VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        clearSessionIfCurrent();
        connection.destroy();
      }
    };
    destroyedHandler = () => {
      clearSessionIfCurrent();
    };
    playerErrorHandler = (err: Error) => {
      logger.warn(`discord voice: playback error: ${formatErrorMessage(err)}`);
    };

    this.enableDaveReceivePassthrough(
      entry,
      "post-join warmup",
      DAVE_RECEIVE_PASSTHROUGH_INITIAL_EXPIRY_SECONDS,
    );
    connection.receiver.speaking.on("start", speakingHandler);
    connection.receiver.speaking.on("end", speakingEndHandler);
    connection.on(voiceSdk.VoiceConnectionStatus.Disconnected, disconnectedHandler);
    connection.on(voiceSdk.VoiceConnectionStatus.Destroyed, destroyedHandler);
    player.on("error", playerErrorHandler);

    this.sessions.set(guildId, entry);
    return {
      channelId,
      guildId,
      message: `Joined ${formatMention({ channelId })}.`,
      ok: true,
    };
  }

  async leave(params: { guildId: string; channelId?: string }): Promise<VoiceOperationResult> {
    const guildId = params.guildId.trim();
    logVoiceVerbose(`leave requested: guild ${guildId} channel ${params.channelId ?? "current"}`);
    const entry = this.sessions.get(guildId);
    if (!entry) {
      return { message: "Not connected to a voice channel.", ok: false };
    }
    if (params.channelId && params.channelId !== entry.channelId) {
      return { message: "Not connected to that voice channel.", ok: false };
    }
    entry.stop();
    this.sessions.delete(guildId);
    logVoiceVerbose(`leave: disconnected from guild ${guildId} channel ${entry.channelId}`);
    return {
      channelId: entry.channelId,
      guildId,
      message: `Left ${formatMention({ channelId: entry.channelId })}.`,
      ok: true,
    };
  }

  async destroy(): Promise<void> {
    for (const entry of this.sessions.values()) {
      entry.stop();
    }
    this.sessions.clear();
  }

  private enqueueProcessing(entry: VoiceSessionEntry, task: () => Promise<void>) {
    entry.processingQueue = entry.processingQueue
      .then(task)
      .catch((error) => logger.warn(`discord voice: processing failed: ${formatErrorMessage(error)}`));
  }

  private enqueuePlayback(entry: VoiceSessionEntry, task: () => Promise<void>) {
    entry.playbackQueue = entry.playbackQueue
      .then(task)
      .catch((error) => logger.warn(`discord voice: playback failed: ${formatErrorMessage(error)}`));
  }

  private clearCaptureFinalizeTimer(entry: VoiceSessionEntry, userId: string, generation?: number) {
    return clearVoiceCaptureFinalizeTimer(entry.capture, userId, generation);
  }

  private scheduleCaptureFinalize(entry: VoiceSessionEntry, userId: string, reason: string) {
    scheduleVoiceCaptureFinalize({
      delayMs: CAPTURE_FINALIZE_GRACE_MS,
      onFinalize: () => {
        logVoiceVerbose(
          `capture finalize: guild ${entry.guildId} channel ${entry.channelId} user ${userId} reason=${reason} grace=${CAPTURE_FINALIZE_GRACE_MS}ms`,
        );
      },
      state: entry.capture,
      userId,
    });
  }

  private async handleSpeakingStart(entry: VoiceSessionEntry, userId: string) {
    if (!userId) {
      return;
    }
    if (this.botUserId && userId === this.botUserId) {
      return;
    }
    if (isVoiceCaptureActive(entry.capture, userId)) {
      const activeCapture = getActiveVoiceCapture(entry.capture, userId);
      const extended = activeCapture
        ? this.clearCaptureFinalizeTimer(entry, userId, activeCapture.generation)
        : false;
      logVoiceVerbose(
        `capture start ignored (already active): guild ${entry.guildId} channel ${entry.channelId} user ${userId}${extended ? " (finalize canceled)" : ""}`,
      );
      return;
    }

    logVoiceVerbose(
      `capture start: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    const voiceSdk = loadDiscordVoiceSdk();
    this.enableDaveReceivePassthrough(
      entry,
      `speaker ${userId} start`,
      DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
    );
    if (entry.player.state.status === voiceSdk.AudioPlayerStatus.Playing) {
      entry.player.stop(true);
    }

    const stream = entry.connection.receiver.subscribe(userId, {
      end: {
        behavior: voiceSdk.EndBehaviorType.Manual,
      },
    });
    const generation = beginVoiceCapture(entry.capture, userId, stream);
    let streamAborted = false;
    stream.on("error", (err) => {
      streamAborted = analyzeVoiceReceiveError(err).isAbortLike;
      this.handleReceiveError(entry, err);
    });

    try {
      const pcm = await decodeOpusStream(stream);
      if (pcm.length === 0) {
        logVoiceVerbose(
          `capture empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
        );
        return;
      }
      this.resetDecryptFailureState(entry);
      const { path: wavPath, durationSeconds } = await writeWavFile(pcm);
      const minimumDurationSeconds = streamAborted ? 0.2 : MIN_SEGMENT_SECONDS;
      if (durationSeconds < minimumDurationSeconds) {
        logVoiceVerbose(
          `capture too short (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
        );
        return;
      }
      logVoiceVerbose(
        `capture ready (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      this.enqueueProcessing(entry, async () => {
        await this.processSegment({ durationSeconds, entry, userId, wavPath });
      });
    } finally {
      finishVoiceCapture(entry.capture, userId, generation);
    }
  }

  private async processSegment(params: {
    entry: VoiceSessionEntry;
    wavPath: string;
    userId: string;
    durationSeconds: number;
  }) {
    const { entry, wavPath, userId, durationSeconds } = params;
    logVoiceVerbose(
      `segment processing (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId}`,
    );
    if (!entry.guildName) {
      const guild = await this.params.client.fetchGuild(entry.guildId).catch(() => null);
      if (guild && typeof guild.name === "string" && guild.name.trim()) {
        entry.guildName = guild.name;
      }
    }
    const speaker = await this.resolveSpeakerContext(entry.guildId, userId);
    const speakerIdentity = await this.resolveSpeakerIdentity(entry.guildId, userId);
    const access = await authorizeDiscordVoiceIngress({
      cfg: this.params.cfg,
      channelId: entry.channelId,
      channelLabel: formatMention({ channelId: entry.channelId }),
      channelName: entry.channelName,
      channelSlug: entry.channelName ? normalizeDiscordSlug(entry.channelName) : "",
      discordConfig: this.params.discordConfig,
      guildId: entry.guildId,
      guildName: entry.guildName,
      memberRoleIds: speakerIdentity.memberRoleIds,
      sender: {
        id: speakerIdentity.id,
        name: speakerIdentity.name,
        tag: speakerIdentity.tag,
      },
    });
    if (!access.ok) {
      logVoiceVerbose(
        `segment unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId} reason=${access.message}`,
      );
      return;
    }
    const transcript = await transcribeAudio({
      agentId: entry.route.agentId,
      cfg: this.params.cfg,
      filePath: wavPath,
    });
    if (!transcript) {
      logVoiceVerbose(
        `transcription empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return;
    }
    logVoiceVerbose(
      `transcription ok (${transcript.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
    );

    const prompt = formatVoiceIngressPrompt(transcript, speaker.label);

    const result = await agentCommandFromIngress(
      {
        agentId: entry.route.agentId,
        allowModelOverride: false,
        deliver: false,
        message: prompt,
        messageChannel: "discord",
        senderIsOwner: speaker.senderIsOwner,
        sessionKey: entry.route.sessionKey,
      },
      this.params.runtime,
    );

    const replyText = (result.payloads ?? [])
      .map((payload) => payload.text)
      .filter((text) => typeof text === "string" && text.trim())
      .join("\n")
      .trim();

    if (!replyText) {
      logVoiceVerbose(
        `reply empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return;
    }
    logVoiceVerbose(
      `reply ok (${replyText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
    );

    const { cfg: ttsCfg, resolved: ttsConfig } = resolveVoiceTtsConfig({
      cfg: this.params.cfg,
      override: this.params.discordConfig.voice?.tts,
    });
    const directive = parseTtsDirectives(replyText, ttsConfig.modelOverrides, {
      cfg: ttsCfg,
      providerConfigs: ttsConfig.providerConfigs,
    });
    const rawSpeakText = directive.overrides.ttsText ?? directive.cleanedText.trim();
    const speakText = sanitizeVoiceReplyTextForSpeech(rawSpeakText, speaker.label);
    if (!speakText) {
      logVoiceVerbose(
        `tts skipped (empty): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return;
    }

    const ttsResult = await getDiscordRuntime().tts.textToSpeech({
      cfg: ttsCfg,
      channel: "discord",
      overrides: directive.overrides,
      text: speakText,
    });
    if (!ttsResult.success || !ttsResult.audioPath) {
      logger.warn(`discord voice: TTS failed: ${ttsResult.error ?? "unknown error"}`);
      return;
    }
    const {audioPath} = ttsResult;
    logVoiceVerbose(
      `tts ok (${speakText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
    );

    this.enqueuePlayback(entry, async () => {
      logVoiceVerbose(
        `playback start: guild ${entry.guildId} channel ${entry.channelId} file ${path.basename(audioPath)}`,
      );
      const voiceSdk = loadDiscordVoiceSdk();
      const resource = voiceSdk.createAudioResource(audioPath);
      entry.player.play(resource);
      await voiceSdk
        .entersState(entry.player, voiceSdk.AudioPlayerStatus.Playing, PLAYBACK_READY_TIMEOUT_MS)
        .catch(() => undefined);
      await voiceSdk
        .entersState(entry.player, voiceSdk.AudioPlayerStatus.Idle, SPEAKING_READY_TIMEOUT_MS)
        .catch(() => undefined);
      logVoiceVerbose(`playback done: guild ${entry.guildId} channel ${entry.channelId}`);
    });
  }

  private handleReceiveError(entry: VoiceSessionEntry, err: unknown) {
    const analysis = analyzeVoiceReceiveError(err);
    logger.warn(`discord voice: receive error: ${analysis.message}`);
    if (analysis.shouldAttemptPassthrough) {
      this.enableDaveReceivePassthrough(
        entry,
        "receive decrypt error",
        DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
      );
    }
    if (!analysis.countsAsDecryptFailure) {
      return;
    }
    const decryptFailure = noteVoiceDecryptFailure(entry.receiveRecovery);
    if (decryptFailure.firstFailure) {
      logger.warn(
        "discord voice: DAVE decrypt failures detected; voice receive may be unstable (upstream: discordjs/discord.js#11419)",
      );
    }
    if (!decryptFailure.shouldRecover) {
      return;
    }
    void this.recoverFromDecryptFailures(entry)
      .catch((error) =>
        logger.warn(`discord voice: decrypt recovery failed: ${formatErrorMessage(error)}`),
      )
      .finally(() => {
        finishVoiceDecryptRecovery(entry.receiveRecovery);
      });
  }

  private enableDaveReceivePassthrough(
    entry: Pick<VoiceSessionEntry, "guildId" | "channelId" | "connection">,
    reason: string,
    expirySeconds: number,
  ): boolean {
    const voiceSdk = loadDiscordVoiceSdk();
    return tryEnableDaveReceivePassthrough({
      expirySeconds,
      onVerbose: logVoiceVerbose,
      onWarn: (message) => logger.warn(message),
      reason,
      sdk: {
        NetworkingStatusCode: {
          Ready: voiceSdk.NetworkingStatusCode.Ready,
          Resuming: voiceSdk.NetworkingStatusCode.Resuming,
        },
        VoiceConnectionStatus: {
          Ready: voiceSdk.VoiceConnectionStatus.Ready,
        },
      },
      target: {
        channelId: entry.channelId,
        connection: entry.connection as {
          state: {
            status: unknown;
            networking?: {
              state?: {
                code?: unknown;
                dave?: {
                  session?: {
                    setPassthroughMode: (passthrough: boolean, expirySeconds: number) => void;
                  };
                };
              };
            };
          };
        },
        guildId: entry.guildId,
      },
    });
  }

  private resetDecryptFailureState(entry: VoiceSessionEntry) {
    resetVoiceReceiveRecoveryState(entry.receiveRecovery);
  }

  private async recoverFromDecryptFailures(entry: VoiceSessionEntry) {
    const active = this.sessions.get(entry.guildId);
    if (!active || active.connection !== entry.connection) {
      return;
    }
    logger.warn(
      `discord voice: repeated decrypt failures; attempting rejoin for guild ${entry.guildId} channel ${entry.channelId}`,
    );
    const leaveResult = await this.leave({ guildId: entry.guildId });
    if (!leaveResult.ok) {
      logger.warn(`discord voice: decrypt recovery leave failed: ${leaveResult.message}`);
      return;
    }
    const result = await this.join({ channelId: entry.channelId, guildId: entry.guildId });
    if (!result.ok) {
      logger.warn(`discord voice: rejoin after decrypt failures failed: ${result.message}`);
    }
  }

  private resolveSpeakerIsOwner(params: { id: string; name?: string; tag?: string }): boolean {
    return resolveDiscordOwnerAccess({
      allowFrom: this.ownerAllowFrom,
      allowNameMatching: false,
      sender: {
        id: params.id,
        name: params.name,
        tag: params.tag,
      },
    }).ownerAllowed;
  }

  private resolveSpeakerContextCacheKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
  }

  private getCachedSpeakerContext(
    guildId: string,
    userId: string,
  ):
    | {
        id: string;
        label: string;
        name?: string;
        tag?: string;
        senderIsOwner: boolean;
      }
    | undefined {
    const key = this.resolveSpeakerContextCacheKey(guildId, userId);
    const cached = this.speakerContextCache.get(key);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
      this.speakerContextCache.delete(key);
      return undefined;
    }
    return {
      id: cached.id,
      label: cached.label,
      name: cached.name,
      senderIsOwner: cached.senderIsOwner,
      tag: cached.tag,
    };
  }

  private setCachedSpeakerContext(
    guildId: string,
    userId: string,
    context: {
      id: string;
      label: string;
      name?: string;
      tag?: string;
      senderIsOwner: boolean;
    },
  ): void {
    const key = this.resolveSpeakerContextCacheKey(guildId, userId);
    this.speakerContextCache.set(key, {
      expiresAt: Date.now() + SPEAKER_CONTEXT_CACHE_TTL_MS,
      id: context.id,
      label: context.label,
      name: context.name,
      senderIsOwner: context.senderIsOwner,
      tag: context.tag,
    });
  }

  private async resolveSpeakerContext(
    guildId: string,
    userId: string,
  ): Promise<{
    id: string;
    label: string;
    name?: string;
    tag?: string;
    senderIsOwner: boolean;
  }> {
    const cached = this.getCachedSpeakerContext(guildId, userId);
    if (cached) {
      return cached;
    }
    const identity = await this.resolveSpeakerIdentity(guildId, userId);
    const context = {
      id: identity.id,
      label: identity.label,
      name: identity.name,
      senderIsOwner: this.resolveSpeakerIsOwner({
        id: identity.id,
        name: identity.name,
        tag: identity.tag,
      }),
      tag: identity.tag,
    };
    this.setCachedSpeakerContext(guildId, userId, context);
    return context;
  }

  private async resolveSpeakerIdentity(
    guildId: string,
    userId: string,
  ): Promise<{
    id: string;
    label: string;
    name?: string;
    tag?: string;
    memberRoleIds: string[];
  }> {
    try {
      const member = await this.params.client.fetchMember(guildId, userId);
      const username = member.user?.username ?? undefined;
      return {
        id: userId,
        label: member.nickname ?? member.user?.globalName ?? username ?? userId,
        memberRoleIds: Array.isArray(member.roles)
          ? member.roles
              .map((role) =>
                typeof role === "string" ? role : (typeof role?.id === "string" ? role.id : ""),
              )
              .filter(Boolean)
          : [],
        name: username,
        tag: member.user ? formatDiscordUserTag(member.user) : undefined,
      };
    } catch {
      try {
        const user = await this.params.client.fetchUser(userId);
        const username = user.username ?? undefined;
        return {
          id: userId,
          label: user.globalName ?? username ?? userId,
          memberRoleIds: [],
          name: username,
          tag: formatDiscordUserTag(user),
        };
      } catch {
        return { id: userId, label: userId, memberRoleIds: [] };
      }
    }
  }
}

export class DiscordVoiceReadyListener extends ReadyListener {
  constructor(private manager: DiscordVoiceManager) {
    super();
  }

  async handle(_data: unknown, _client: Client): Promise<void> {
    void this.manager
      .autoJoin()
      .catch((error) => logger.warn(`discord voice: autoJoin failed: ${formatErrorMessage(error)}`));
  }
}

function isVoiceChannel(type: ChannelType) {
  return type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
}
