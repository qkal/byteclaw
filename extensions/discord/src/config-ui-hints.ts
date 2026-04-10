import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const discordChannelConfigUiHints = {
  "": {
    help: "Discord channel provider configuration for bot auth, retry policy, streaming, thread bindings, and optional voice capabilities. Keep privileged intents and advanced features disabled unless needed.",
    label: "Discord",
  },
  activity: {
    help: "Discord presence activity text (defaults to custom status).",
    label: "Discord Presence Activity",
  },
  activityType: {
    help: "Discord presence activity type (0=Playing,1=Streaming,2=Listening,3=Watching,4=Custom,5=Competing).",
    label: "Discord Presence Activity Type",
  },
  activityUrl: {
    help: "Discord presence streaming URL (required for activityType=1).",
    label: "Discord Presence Activity URL",
  },
  allowBots: {
    help: 'Allow bot-authored messages to trigger Discord replies (default: false). Set "mentions" to only accept bot messages that mention the bot.',
    label: "Discord Allow Bot Messages",
  },
  "autoPresence.degradedText": {
    help: "Optional custom status text while runtime/model availability is degraded or unknown (idle).",
    label: "Discord Auto Presence Degraded Text",
  },
  "autoPresence.enabled": {
    help: "Enable automatic Discord bot presence updates based on runtime/model availability signals. When enabled: healthy=>online, degraded/unknown=>idle, exhausted/unavailable=>dnd.",
    label: "Discord Auto Presence Enabled",
  },
  "autoPresence.exhaustedText": {
    help: "Optional custom status text while runtime detects exhausted/unavailable model quota (dnd). Supports {reason} template placeholder.",
    label: "Discord Auto Presence Exhausted Text",
  },
  "autoPresence.healthyText": {
    help: "Optional custom status text while runtime is healthy (online). If omitted, falls back to static channels.discord.activity when set.",
    label: "Discord Auto Presence Healthy Text",
  },
  "autoPresence.intervalMs": {
    help: "How often to evaluate Discord auto-presence state in milliseconds (default: 30000).",
    label: "Discord Auto Presence Check Interval (ms)",
  },
  "autoPresence.minUpdateIntervalMs": {
    help: "Minimum time between actual Discord presence update calls in milliseconds (default: 15000). Prevents status spam on noisy state changes.",
    label: "Discord Auto Presence Min Update Interval (ms)",
  },
  "commands.native": {
    help: 'Override native commands for Discord (bool or "auto").',
    label: "Discord Native Commands",
  },
  "commands.nativeSkills": {
    help: 'Override native skill commands for Discord (bool or "auto").',
    label: "Discord Native Skill Commands",
  },
  configWrites: {
    help: "Allow Discord to write config in response to channel events/commands (default: true).",
    label: "Discord Config Writes",
  },
  "dm.policy": {
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.discord.allowFrom=["*"] (legacy: channels.discord.dm.allowFrom).',
    label: "Discord DM Policy",
  },
  dmPolicy: {
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.discord.allowFrom=["*"].',
    label: "Discord DM Policy",
  },
  "eventQueue.listenerTimeout": {
    help: "Canonical Discord listener timeout control in ms for gateway normalization/enqueue handlers. Default is 120000 in OpenClaw; set per account via channels.discord.accounts.<id>.eventQueue.listenerTimeout.",
    label: "Discord EventQueue Listener Timeout (ms)",
  },
  "eventQueue.maxConcurrency": {
    help: "Optional Discord EventQueue concurrency override (max concurrent handler executions). Set per account via channels.discord.accounts.<id>.eventQueue.maxConcurrency.",
    label: "Discord EventQueue Max Concurrency",
  },
  "eventQueue.maxQueueSize": {
    help: "Optional Discord EventQueue capacity override (max queued events before backpressure). Set per account via channels.discord.accounts.<id>.eventQueue.maxQueueSize.",
    label: "Discord EventQueue Max Queue Size",
  },
  "inboundWorker.runTimeoutMs": {
    help: "Optional queued Discord inbound worker timeout in ms. This is separate from Carbon listener timeouts; defaults to 1800000 and can be disabled with 0. Set per account via channels.discord.accounts.<id>.inboundWorker.runTimeoutMs.",
    label: "Discord Inbound Worker Timeout (ms)",
  },
  "intents.guildMembers": {
    help: "Enable the Guild Members privileged intent. Must also be enabled in the Discord Developer Portal. Default: false.",
    label: "Discord Guild Members Intent",
  },
  "intents.presence": {
    help: "Enable the Guild Presences privileged intent. Must also be enabled in the Discord Developer Portal. Allows tracking user activities (e.g. Spotify). Default: false.",
    label: "Discord Presence Intent",
  },
  maxLinesPerMessage: {
    help: "Soft max line count per Discord message (default: 17).",
    label: "Discord Max Lines Per Message",
  },
  "pluralkit.enabled": {
    help: "Resolve PluralKit proxied messages and treat system members as distinct senders.",
    label: "Discord PluralKit Enabled",
  },
  "pluralkit.token": {
    help: "Optional PluralKit token for resolving private systems or members.",
    label: "Discord PluralKit Token",
  },
  proxy: {
    help: "Proxy URL for Discord gateway + API requests (app-id lookup and allowlist resolution). Set per account via channels.discord.accounts.<id>.proxy.",
    label: "Discord Proxy URL",
  },
  "retry.attempts": {
    help: "Max retry attempts for outbound Discord API calls (default: 3).",
    label: "Discord Retry Attempts",
  },
  "retry.jitter": {
    help: "Jitter factor (0-1) applied to Discord retry delays.",
    label: "Discord Retry Jitter",
  },
  "retry.maxDelayMs": {
    help: "Maximum retry delay cap in ms for Discord outbound calls.",
    label: "Discord Retry Max Delay (ms)",
  },
  "retry.minDelayMs": {
    help: "Minimum retry delay in ms for Discord outbound calls.",
    label: "Discord Retry Min Delay (ms)",
  },
  status: {
    help: "Discord presence status (online, dnd, idle, invisible).",
    label: "Discord Presence Status",
  },
  streaming: {
    help: 'Unified Discord stream preview mode: "off" | "partial" | "block" | "progress". "progress" maps to "partial" on Discord. Legacy boolean/streamMode keys are auto-mapped.',
    label: "Discord Streaming Mode",
  },
  "streaming.block.coalesce": {
    help: "Merge streamed Discord block replies before final delivery.",
    label: "Discord Block Streaming Coalesce",
  },
  "streaming.block.enabled": {
    help: 'Enable chunked block-style Discord preview delivery when channels.discord.streaming.mode="block".',
    label: "Discord Block Streaming Enabled",
  },
  "streaming.chunkMode": {
    help: 'Chunking mode for outbound Discord text delivery: "length" (default) or "newline".',
    label: "Discord Chunk Mode",
  },
  "streaming.mode": {
    help: 'Canonical Discord preview mode: "off" | "partial" | "block" | "progress". "progress" maps to "partial" on Discord.',
    label: "Discord Streaming Mode",
  },
  "streaming.preview.chunk.breakPreference": {
    help: "Preferred breakpoints for Discord draft chunks (paragraph | newline | sentence). Default: paragraph.",
    label: "Discord Draft Chunk Break Preference",
  },
  "streaming.preview.chunk.maxChars": {
    help: 'Target max size for a Discord stream preview chunk when channels.discord.streaming.mode="block" (default: 800; clamped to channels.discord.textChunkLimit).',
    label: "Discord Draft Chunk Max Chars",
  },
  "streaming.preview.chunk.minChars": {
    help: 'Minimum chars before emitting a Discord stream preview update when channels.discord.streaming.mode="block" (default: 200).',
    label: "Discord Draft Chunk Min Chars",
  },
  "threadBindings.enabled": {
    help: "Enable Discord thread binding features (/focus, bound-thread routing/delivery, and thread-bound subagent sessions). Overrides session.threadBindings.enabled when set.",
    label: "Discord Thread Binding Enabled",
  },
  "threadBindings.idleHours": {
    help: "Inactivity window in hours for Discord thread-bound sessions (/focus and spawned thread sessions). Set 0 to disable idle auto-unfocus (default: 24). Overrides session.threadBindings.idleHours when set.",
    label: "Discord Thread Binding Idle Timeout (hours)",
  },
  "threadBindings.maxAgeHours": {
    help: "Optional hard max age in hours for Discord thread-bound sessions. Set 0 to disable hard cap (default: 0). Overrides session.threadBindings.maxAgeHours when set.",
    label: "Discord Thread Binding Max Age (hours)",
  },
  "threadBindings.spawnAcpSessions": {
    help: "Allow /acp spawn to auto-create and bind Discord threads for ACP sessions (default: false; opt-in). Set true to enable thread-bound ACP spawns for this account/channel.",
    label: "Discord Thread-Bound ACP Spawn",
  },
  "threadBindings.spawnSubagentSessions": {
    help: "Allow subagent spawns with thread=true to auto-create and bind Discord threads (default: false; opt-in). Set true to enable thread-bound subagent spawns for this account/channel.",
    label: "Discord Thread-Bound Subagent Spawn",
  },
  token: {
    help: "Discord bot token used for gateway and REST API authentication for this provider account. Keep this secret out of committed config and rotate immediately after any leak.",
    label: "Discord Bot Token",
    sensitive: true,
  },
  "ui.components.accentColor": {
    help: "Accent color for Discord component containers (hex). Set per account via channels.discord.accounts.<id>.ui.components.accentColor.",
    label: "Discord Component Accent Color",
  },
  "voice.autoJoin": {
    help: "Voice channels to auto-join on startup (list of guildId/channelId entries).",
    label: "Discord Voice Auto-Join",
  },
  "voice.daveEncryption": {
    help: "Toggle DAVE end-to-end encryption for Discord voice joins (default: true in @discordjs/voice; Discord may require this).",
    label: "Discord Voice DAVE Encryption",
  },
  "voice.decryptionFailureTolerance": {
    help: "Consecutive decrypt failures before DAVE attempts session recovery (passed to @discordjs/voice; default: 24).",
    label: "Discord Voice Decrypt Failure Tolerance",
  },
  "voice.enabled": {
    help: "Enable Discord voice channel conversations (default: true). Omit channels.discord.voice to keep voice support disabled for the account.",
    label: "Discord Voice Enabled",
  },
  "voice.tts": {
    help: "Optional TTS overrides for Discord voice playback (merged with messages.tts).",
    label: "Discord Voice Text-to-Speech",
  },
} satisfies Record<string, ChannelConfigUiHint>;
