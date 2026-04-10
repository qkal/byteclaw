import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const telegramChannelConfigUiHints = {
  "": {
    help: "Telegram channel provider configuration including auth tokens, retry behavior, and message rendering controls. Use this section to tune bot behavior for Telegram-specific API semantics.",
    label: "Telegram",
  },
  apiRoot: {
    help: "Custom Telegram Bot API root URL. Use for self-hosted Bot API servers (https://github.com/tdlib/telegram-bot-api) or reverse proxies in regions where api.telegram.org is blocked.",
    label: "Telegram API Root URL",
  },
  autoTopicLabel: {
    help: "Auto-rename DM forum topics on first message using LLM. Default: true. Set to false to disable, or use object form { enabled: true, prompt: '...' } for custom prompt.",
    label: "Telegram Auto Topic Label",
  },
  "autoTopicLabel.enabled": {
    help: "Whether auto topic labeling is enabled. Default: true.",
    label: "Telegram Auto Topic Label Enabled",
  },
  "autoTopicLabel.prompt": {
    help: "Custom prompt for LLM-based topic naming. The user message is appended after the prompt.",
    label: "Telegram Auto Topic Label Prompt",
  },
  botToken: {
    help: "Telegram bot token used to authenticate Bot API requests for this account/provider config. Use secret/env substitution and rotate tokens if exposure is suspected.",
    label: "Telegram Bot Token",
  },
  "capabilities.inlineButtons": {
    help: "Enable Telegram inline button components for supported command and interaction surfaces. Disable if your deployment needs plain-text-only compatibility behavior.",
    label: "Telegram Inline Buttons",
  },
  "commands.native": {
    help: 'Override native commands for Telegram (bool or "auto").',
    label: "Telegram Native Commands",
  },
  "commands.nativeSkills": {
    help: 'Override native skill commands for Telegram (bool or "auto").',
    label: "Telegram Native Skill Commands",
  },
  configWrites: {
    help: "Allow Telegram to write config in response to channel events/commands (default: true).",
    label: "Telegram Config Writes",
  },
  customCommands: {
    help: "Additional Telegram bot menu commands (merged with native; conflicts ignored).",
    label: "Telegram Custom Commands",
  },
  dmPolicy: {
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.telegram.allowFrom=["*"].',
    label: "Telegram DM Policy",
  },
  execApprovals: {
    help: "Telegram-native exec approval routing and approver authorization. When unset, OpenClaw auto-enables DM-first native approvals if approvers can be resolved for the selected bot account.",
    label: "Telegram Exec Approvals",
  },
  "execApprovals.agentFilter": {
    help: 'Optional allowlist of agent IDs eligible for Telegram exec approvals, for example `["main", "ops-agent"]`. Use this to keep approval prompts scoped to the agents you actually operate from Telegram.',
    label: "Telegram Exec Approval Agent Filter",
  },
  "execApprovals.approvers": {
    help: "Telegram user IDs allowed to approve exec requests for this bot account. Use numeric Telegram user IDs. If you leave this unset, OpenClaw falls back to numeric owner IDs inferred from channels.telegram.allowFrom and direct-message defaultTo when possible.",
    label: "Telegram Exec Approval Approvers",
  },
  "execApprovals.enabled": {
    help: 'Controls Telegram native exec approvals for this account: unset or "auto" enables DM-first native approvals when approvers can be resolved, true forces native approvals on, and false disables them.',
    label: "Telegram Exec Approvals Enabled",
  },
  "execApprovals.sessionFilter": {
    help: "Optional session-key filters matched as substring or regex-style patterns before Telegram approval routing is used. Use narrow patterns so Telegram approvals only appear for intended sessions.",
    label: "Telegram Exec Approval Session Filter",
  },
  "execApprovals.target": {
    help: 'Controls where Telegram approval prompts are sent: "dm" sends to approver DMs (default), "channel" sends to the originating Telegram chat/topic, and "both" sends to both. Channel delivery exposes the command text to the chat, so only use it in trusted groups/topics.',
    label: "Telegram Exec Approval Target",
  },
  "network.autoSelectFamily": {
    help: "Override Node autoSelectFamily for Telegram (true=enable, false=disable).",
    label: "Telegram autoSelectFamily",
  },
  "network.dangerouslyAllowPrivateNetwork": {
    help: "Dangerous opt-in for trusted fake-IP or transparent-proxy environments where Telegram media downloads resolve api.telegram.org to private/internal/special-use addresses.",
    label: "Telegram Dangerously Allow Private Network",
  },
  "retry.attempts": {
    help: "Max retry attempts for outbound Telegram API calls (default: 3).",
    label: "Telegram Retry Attempts",
  },
  "retry.jitter": {
    help: "Jitter factor (0-1) applied to Telegram retry delays.",
    label: "Telegram Retry Jitter",
  },
  "retry.maxDelayMs": {
    help: "Maximum retry delay cap in ms for Telegram outbound calls.",
    label: "Telegram Retry Max Delay (ms)",
  },
  "retry.minDelayMs": {
    help: "Minimum retry delay in ms for Telegram outbound calls.",
    label: "Telegram Retry Min Delay (ms)",
  },
  silentErrorReplies: {
    help: "When true, Telegram bot replies marked as errors are sent silently (no notification sound). Default: false.",
    label: "Telegram Silent Error Replies",
  },
  streaming: {
    help: 'Unified Telegram stream preview mode: "off" | "partial" | "block" | "progress" (default: "partial"). "progress" maps to "partial" on Telegram. Legacy boolean/streamMode keys are auto-mapped.',
    label: "Telegram Streaming Mode",
  },
  "streaming.block.coalesce": {
    help: "Merge streamed Telegram block replies before sending final delivery.",
    label: "Telegram Block Streaming Coalesce",
  },
  "streaming.block.enabled": {
    help: 'Enable chunked block-style Telegram preview delivery when channels.telegram.streaming.mode="block".',
    label: "Telegram Block Streaming Enabled",
  },
  "streaming.chunkMode": {
    help: 'Chunking mode for outbound Telegram text delivery: "length" (default) or "newline".',
    label: "Telegram Chunk Mode",
  },
  "streaming.mode": {
    help: 'Canonical Telegram preview mode: "off" | "partial" | "block" | "progress" (default: "partial"). "progress" maps to "partial" on Telegram.',
    label: "Telegram Streaming Mode",
  },
  "streaming.preview.chunk.breakPreference": {
    help: "Preferred breakpoints for Telegram draft chunks (paragraph | newline | sentence).",
    label: "Telegram Draft Chunk Break Preference",
  },
  "streaming.preview.chunk.maxChars": {
    help: 'Target max size for a Telegram block preview chunk when channels.telegram.streaming.mode="block".',
    label: "Telegram Draft Chunk Max Chars",
  },
  "streaming.preview.chunk.minChars": {
    help: 'Minimum chars before emitting a Telegram block preview chunk when channels.telegram.streaming.mode="block".',
    label: "Telegram Draft Chunk Min Chars",
  },
  "threadBindings.enabled": {
    help: "Enable Telegram conversation binding features (/focus, /unfocus, /agents, and /session idle|max-age). Overrides session.threadBindings.enabled when set.",
    label: "Telegram Thread Binding Enabled",
  },
  "threadBindings.idleHours": {
    help: "Inactivity window in hours for Telegram bound sessions. Set 0 to disable idle auto-unfocus (default: 24). Overrides session.threadBindings.idleHours when set.",
    label: "Telegram Thread Binding Idle Timeout (hours)",
  },
  "threadBindings.maxAgeHours": {
    help: "Optional hard max age in hours for Telegram bound sessions. Set 0 to disable hard cap (default: 0). Overrides session.threadBindings.maxAgeHours when set.",
    label: "Telegram Thread Binding Max Age (hours)",
  },
  "threadBindings.spawnAcpSessions": {
    help: "Allow ACP spawns with thread=true to auto-bind Telegram current conversations when supported.",
    label: "Telegram Thread-Bound ACP Spawn",
  },
  "threadBindings.spawnSubagentSessions": {
    help: "Allow subagent spawns with thread=true to auto-bind Telegram current conversations when supported.",
    label: "Telegram Thread-Bound Subagent Spawn",
  },
  timeoutSeconds: {
    help: "Max seconds before Telegram API requests are aborted (default: 500 per grammY).",
    label: "Telegram API Timeout (seconds)",
  },
  trustedLocalFileRoots: {
    help: "Trusted local filesystem roots for self-hosted Telegram Bot API absolute file_path values. Only absolute paths inside these roots are read directly; all other absolute paths are rejected.",
    label: "Telegram Trusted Local File Roots",
  },
} satisfies Record<string, ChannelConfigUiHint>;
