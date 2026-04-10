import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const slackChannelConfigUiHints = {
  "": {
    help: "Slack channel provider configuration for bot/app tokens, streaming behavior, and DM policy controls. Keep token handling and thread behavior explicit to avoid noisy workspace interactions.",
    label: "Slack",
  },
  allowBots: {
    help: "Allow bot-authored messages to trigger Slack replies (default: false).",
    label: "Slack Allow Bot Messages",
  },
  appToken: {
    help: "Slack app-level token used for Socket Mode connections and event transport when enabled. Use least-privilege app scopes and store this token as a secret.",
    label: "Slack App Token",
  },
  botToken: {
    help: "Slack bot token used for standard chat actions in the configured workspace. Keep this credential scoped and rotate if workspace app permissions change.",
    label: "Slack Bot Token",
  },
  "capabilities.interactiveReplies": {
    help: "Enable agent-authored Slack interactive reply directives (`[[slack_buttons: ...]]`, `[[slack_select: ...]]`). Default: false.",
    label: "Slack Interactive Replies",
  },
  "commands.native": {
    help: 'Override native commands for Slack (bool or "auto").',
    label: "Slack Native Commands",
  },
  "commands.nativeSkills": {
    help: 'Override native skill commands for Slack (bool or "auto").',
    label: "Slack Native Skill Commands",
  },
  configWrites: {
    help: "Allow Slack to write config in response to channel events/commands (default: true).",
    label: "Slack Config Writes",
  },
  "dm.policy": {
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.slack.allowFrom=["*"] (legacy: channels.slack.dm.allowFrom).',
    label: "Slack DM Policy",
  },
  dmPolicy: {
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.slack.allowFrom=["*"].',
    label: "Slack DM Policy",
  },
  execApprovals: {
    help: "Slack-native exec approval routing and approver authorization. When unset, OpenClaw auto-enables DM-first native approvals if approvers can be resolved for this workspace account.",
    label: "Slack Exec Approvals",
  },
  "execApprovals.agentFilter": {
    help: 'Optional allowlist of agent IDs eligible for Slack exec approvals, for example `["main", "ops-agent"]`. Use this to keep approval prompts scoped to the agents you actually operate from Slack.',
    label: "Slack Exec Approval Agent Filter",
  },
  "execApprovals.approvers": {
    help: "Slack user IDs allowed to approve exec requests for this workspace account. Use Slack user IDs or user targets such as `U123`, `user:U123`, or `<@U123>`. If you leave this unset, OpenClaw falls back to commands.ownerAllowFrom when possible.",
    label: "Slack Exec Approval Approvers",
  },
  "execApprovals.enabled": {
    help: 'Controls Slack native exec approvals for this account: unset or "auto" enables DM-first native approvals when approvers can be resolved, true forces native approvals on, and false disables them.',
    label: "Slack Exec Approvals Enabled",
  },
  "execApprovals.sessionFilter": {
    help: "Optional session-key filters matched as substring or regex-style patterns before Slack approval routing is used. Use narrow patterns so Slack approvals only appear for intended sessions.",
    label: "Slack Exec Approval Session Filter",
  },
  "execApprovals.target": {
    help: 'Controls where Slack approval prompts are sent: "dm" sends to approver DMs (default), "channel" sends to the originating Slack chat/thread, and "both" sends to both. Channel delivery exposes the command text to the chat, so only use it in trusted channels.',
    label: "Slack Exec Approval Target",
  },
  streaming: {
    help: 'Unified Slack stream preview mode: "off" | "partial" | "block" | "progress". Legacy boolean/streamMode keys are auto-mapped.',
    label: "Slack Streaming Mode",
  },
  "streaming.block.coalesce": {
    help: "Merge streamed Slack block replies before final delivery.",
    label: "Slack Block Streaming Coalesce",
  },
  "streaming.block.enabled": {
    help: 'Enable chunked block-style Slack preview delivery when channels.slack.streaming.mode="block".',
    label: "Slack Block Streaming Enabled",
  },
  "streaming.chunkMode": {
    help: 'Chunking mode for outbound Slack text delivery: "length" (default) or "newline".',
    label: "Slack Chunk Mode",
  },
  "streaming.mode": {
    help: 'Canonical Slack preview mode: "off" | "partial" | "block" | "progress".',
    label: "Slack Streaming Mode",
  },
  "streaming.nativeTransport": {
    help: "Enable native Slack text streaming (chat.startStream/chat.appendStream/chat.stopStream) when channels.slack.streaming.mode is partial (default: true). Requires a reply thread target; top-level DMs stay on the non-thread fallback path.",
    label: "Slack Native Streaming",
  },
  "thread.historyScope": {
    help: 'Scope for Slack thread history context ("thread" isolates per thread; "channel" reuses channel history).',
    label: "Slack Thread History Scope",
  },
  "thread.inheritParent": {
    help: "If true, Slack thread sessions inherit the parent channel transcript (default: false).",
    label: "Slack Thread Parent Inheritance",
  },
  "thread.initialHistoryLimit": {
    help: "Maximum number of existing Slack thread messages to fetch when starting a new thread session (default: 20, set to 0 to disable).",
    label: "Slack Thread Initial History Limit",
  },
  "thread.requireExplicitMention": {
    help: "If true, require an explicit @mention even inside threads where the bot has participated. Suppresses implicit thread mention behavior so the bot only responds to explicit @bot mentions in threads (default: false).",
    label: "Slack Thread Require Explicit Mention",
  },
  userToken: {
    help: "Optional Slack user token for workflows requiring user-context API access beyond bot permissions. Use sparingly and audit scopes because this token can carry broader authority.",
    label: "Slack User Token",
  },
  userTokenReadOnly: {
    help: "When true, treat configured Slack user token usage as read-only helper behavior where possible. Keep enabled if you only need supplemental reads without user-context writes.",
    label: "Slack User Token Read Only",
  },
} satisfies Record<string, ChannelConfigUiHint>;
