import type { ToolDisplaySpec as ToolDisplaySpecBase } from "./tool-display-common.js";

export type ToolDisplaySpec = ToolDisplaySpecBase & {
  emoji?: string;
};

export interface ToolDisplayConfig {
  version: number;
  fallback: ToolDisplaySpec;
  tools: Record<string, ToolDisplaySpec>;
}

export const TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
  fallback: {
    detailKeys: [
      "command",
      "path",
      "url",
      "targetUrl",
      "targetId",
      "ref",
      "element",
      "node",
      "nodeId",
      "id",
      "requestId",
      "to",
      "channelId",
      "guildId",
      "userId",
      "name",
      "query",
      "pattern",
      "messageId",
    ],
    emoji: "🧩",
  },
  tools: {
    agents_list: {
      detailKeys: [],
      emoji: "🧭",
      title: "Agents",
    },
    apply_patch: {
      detailKeys: [],
      emoji: "🩹",
      title: "Apply Patch",
    },
    attach: {
      detailKeys: ["path", "url", "fileName"],
      emoji: "📎",
      title: "Attach",
    },
    bash: {
      detailKeys: ["command"],
      emoji: "🛠️",
      title: "Bash",
    },
    browser: {
      actions: {
        act: {
          detailKeys: [
            "request.kind",
            "request.ref",
            "request.selector",
            "request.text",
            "request.value",
          ],
          label: "act",
        },
        close: {
          detailKeys: ["targetId"],
          label: "close",
        },
        console: {
          detailKeys: ["level", "targetId"],
          label: "console",
        },
        dialog: {
          detailKeys: ["accept", "promptText", "targetId"],
          label: "dialog",
        },
        focus: {
          detailKeys: ["targetId"],
          label: "focus",
        },
        navigate: {
          detailKeys: ["targetUrl", "targetId"],
          label: "navigate",
        },
        open: {
          detailKeys: ["targetUrl"],
          label: "open",
        },
        pdf: {
          detailKeys: ["targetId"],
          label: "pdf",
        },
        screenshot: {
          detailKeys: ["targetUrl", "targetId", "ref", "element"],
          label: "screenshot",
        },
        snapshot: {
          detailKeys: ["targetUrl", "targetId", "ref", "element", "format"],
          label: "snapshot",
        },
        start: {
          label: "start",
        },
        status: {
          label: "status",
        },
        stop: {
          label: "stop",
        },
        tabs: {
          label: "tabs",
        },
        upload: {
          detailKeys: ["paths", "ref", "inputRef", "element", "targetId"],
          label: "upload",
        },
      },
      emoji: "🌐",
      title: "Browser",
    },
    canvas: {
      actions: {
        a2ui_push: {
          detailKeys: ["jsonlPath", "node", "nodeId"],
          label: "A2UI push",
        },
        a2ui_reset: {
          detailKeys: ["node", "nodeId"],
          label: "A2UI reset",
        },
        eval: {
          detailKeys: ["javaScript", "node", "nodeId"],
          label: "eval",
        },
        hide: {
          detailKeys: ["node", "nodeId"],
          label: "hide",
        },
        navigate: {
          detailKeys: ["url", "node", "nodeId"],
          label: "navigate",
        },
        present: {
          detailKeys: ["target", "node", "nodeId"],
          label: "present",
        },
        snapshot: {
          detailKeys: ["format", "node", "nodeId"],
          label: "snapshot",
        },
      },
      emoji: "🖼️",
      title: "Canvas",
    },
    code_execution: {
      detailKeys: ["task"],
      emoji: "🧮",
      title: "Code Execution",
    },
    cron: {
      actions: {
        add: {
          detailKeys: ["job.name", "job.id", "job.schedule", "job.cron"],
          label: "add",
        },
        list: {
          label: "list",
        },
        remove: {
          detailKeys: ["id"],
          label: "remove",
        },
        run: {
          detailKeys: ["id"],
          label: "run",
        },
        runs: {
          detailKeys: ["id"],
          label: "runs",
        },
        status: {
          label: "status",
        },
        update: {
          detailKeys: ["id"],
          label: "update",
        },
        wake: {
          detailKeys: ["text", "mode"],
          label: "wake",
        },
      },
      emoji: "⏰",
      title: "Cron",
    },
    discord: {
      actions: {
        ban: {
          detailKeys: ["guildId", "userId"],
          label: "ban",
        },
        channelInfo: {
          detailKeys: ["channelId"],
          label: "channel",
        },
        channelList: {
          detailKeys: ["guildId"],
          label: "channels",
        },
        deleteMessage: {
          detailKeys: ["channelId", "messageId"],
          label: "delete",
        },
        editMessage: {
          detailKeys: ["channelId", "messageId"],
          label: "edit",
        },
        emojiList: {
          detailKeys: ["guildId"],
          label: "emoji list",
        },
        eventCreate: {
          detailKeys: ["guildId", "name"],
          label: "event create",
        },
        eventList: {
          detailKeys: ["guildId"],
          label: "events",
        },
        kick: {
          detailKeys: ["guildId", "userId"],
          label: "kick",
        },
        listPins: {
          detailKeys: ["channelId"],
          label: "list pins",
        },
        memberInfo: {
          detailKeys: ["guildId", "userId"],
          label: "member",
        },
        permissions: {
          detailKeys: ["channelId"],
          label: "permissions",
        },
        pinMessage: {
          detailKeys: ["channelId", "messageId"],
          label: "pin",
        },
        poll: {
          detailKeys: ["question", "to"],
          label: "poll",
        },
        react: {
          detailKeys: ["channelId", "messageId", "emoji"],
          label: "react",
        },
        reactions: {
          detailKeys: ["channelId", "messageId"],
          label: "reactions",
        },
        readMessages: {
          detailKeys: ["channelId", "limit"],
          label: "read messages",
        },
        roleAdd: {
          detailKeys: ["guildId", "userId", "roleId"],
          label: "role add",
        },
        roleInfo: {
          detailKeys: ["guildId"],
          label: "roles",
        },
        roleRemove: {
          detailKeys: ["guildId", "userId", "roleId"],
          label: "role remove",
        },
        searchMessages: {
          detailKeys: ["guildId", "content"],
          label: "search",
        },
        sendMessage: {
          detailKeys: ["to", "content"],
          label: "send",
        },
        sticker: {
          detailKeys: ["to", "stickerIds"],
          label: "sticker",
        },
        threadCreate: {
          detailKeys: ["channelId", "name"],
          label: "thread create",
        },
        threadList: {
          detailKeys: ["guildId", "channelId"],
          label: "thread list",
        },
        threadReply: {
          detailKeys: ["channelId", "content"],
          label: "thread reply",
        },
        timeout: {
          detailKeys: ["guildId", "userId"],
          label: "timeout",
        },
        unpinMessage: {
          detailKeys: ["channelId", "messageId"],
          label: "unpin",
        },
        voiceStatus: {
          detailKeys: ["guildId", "userId"],
          label: "voice",
        },
      },
      emoji: "💬",
      title: "Discord",
    },
    edit: {
      detailKeys: ["path"],
      emoji: "📝",
      title: "Edit",
    },
    exec: {
      detailKeys: ["command"],
      emoji: "🛠️",
      title: "Exec",
    },
    gateway: {
      actions: {
        restart: {
          detailKeys: ["reason", "delayMs"],
          label: "restart",
        },
      },
      emoji: "🔌",
      title: "Gateway",
    },
    image: {
      detailKeys: ["path", "paths", "url", "urls", "prompt", "model"],
      emoji: "🖼️",
      title: "Image",
    },
    image_generate: {
      actions: {
        generate: {
          detailKeys: ["prompt", "model", "count", "resolution", "aspectRatio"],
          label: "generate",
        },
        list: {
          detailKeys: ["provider", "model"],
          label: "list",
        },
      },
      emoji: "🎨",
      title: "Image Generation",
    },
    memory_get: {
      detailKeys: ["path", "from", "lines"],
      emoji: "📓",
      title: "Memory Get",
    },
    memory_search: {
      detailKeys: ["query"],
      emoji: "🧠",
      title: "Memory Search",
    },
    message: {
      actions: {
        ban: {
          detailKeys: ["provider", "guildId", "userId"],
          label: "ban",
        },
        "channel-info": {
          detailKeys: ["provider", "channelId"],
          label: "channel",
        },
        "channel-list": {
          detailKeys: ["provider", "guildId"],
          label: "channels",
        },
        delete: {
          detailKeys: ["provider", "to", "messageId"],
          label: "delete",
        },
        edit: {
          detailKeys: ["provider", "to", "messageId"],
          label: "edit",
        },
        "emoji-list": {
          detailKeys: ["provider", "guildId"],
          label: "emoji list",
        },
        "emoji-upload": {
          detailKeys: ["provider", "guildId", "emojiName"],
          label: "emoji upload",
        },
        "event-create": {
          detailKeys: ["provider", "guildId", "eventName"],
          label: "event create",
        },
        "event-list": {
          detailKeys: ["provider", "guildId"],
          label: "events",
        },
        kick: {
          detailKeys: ["provider", "guildId", "userId"],
          label: "kick",
        },
        "list-pins": {
          detailKeys: ["provider", "to"],
          label: "list pins",
        },
        "member-info": {
          detailKeys: ["provider", "guildId", "userId"],
          label: "member",
        },
        permissions: {
          detailKeys: ["provider", "channelId", "to"],
          label: "permissions",
        },
        pin: {
          detailKeys: ["provider", "to", "messageId"],
          label: "pin",
        },
        poll: {
          detailKeys: ["provider", "to", "pollQuestion"],
          label: "poll",
        },
        react: {
          detailKeys: ["provider", "to", "messageId", "emoji", "remove"],
          label: "react",
        },
        reactions: {
          detailKeys: ["provider", "to", "messageId", "limit"],
          label: "reactions",
        },
        read: {
          detailKeys: ["provider", "to", "limit"],
          label: "read",
        },
        "role-add": {
          detailKeys: ["provider", "guildId", "userId", "roleId"],
          label: "role add",
        },
        "role-info": {
          detailKeys: ["provider", "guildId"],
          label: "roles",
        },
        "role-remove": {
          detailKeys: ["provider", "guildId", "userId", "roleId"],
          label: "role remove",
        },
        search: {
          detailKeys: ["provider", "guildId", "query"],
          label: "search",
        },
        send: {
          detailKeys: ["provider", "to", "media", "replyTo", "threadId"],
          label: "send",
        },
        sticker: {
          detailKeys: ["provider", "to", "stickerId"],
          label: "sticker",
        },
        "sticker-upload": {
          detailKeys: ["provider", "guildId", "stickerName"],
          label: "sticker upload",
        },
        "thread-create": {
          detailKeys: ["provider", "channelId", "threadName"],
          label: "thread create",
        },
        "thread-list": {
          detailKeys: ["provider", "guildId", "channelId"],
          label: "thread list",
        },
        "thread-reply": {
          detailKeys: ["provider", "channelId", "messageId"],
          label: "thread reply",
        },
        timeout: {
          detailKeys: ["provider", "guildId", "userId"],
          label: "timeout",
        },
        unpin: {
          detailKeys: ["provider", "to", "messageId"],
          label: "unpin",
        },
        "voice-status": {
          detailKeys: ["provider", "guildId", "userId"],
          label: "voice",
        },
      },
      emoji: "✉️",
      title: "Message",
    },
    music_generate: {
      actions: {
        generate: {
          detailKeys: ["prompt", "model", "durationSeconds", "format", "instrumental"],
          label: "generate",
        },
        list: {
          detailKeys: ["provider", "model"],
          label: "list",
        },
      },
      emoji: "🎵",
      title: "Music Generation",
    },
    nodes: {
      actions: {
        approve: {
          detailKeys: ["requestId"],
          label: "approve",
        },
        camera_clip: {
          detailKeys: ["node", "nodeId", "facing", "duration", "durationMs"],
          label: "camera clip",
        },
        camera_list: {
          detailKeys: ["node", "nodeId"],
          label: "camera list",
        },
        camera_snap: {
          detailKeys: ["node", "nodeId", "facing", "deviceId"],
          label: "camera snap",
        },
        describe: {
          detailKeys: ["node", "nodeId"],
          label: "describe",
        },
        notify: {
          detailKeys: ["node", "nodeId", "title", "body"],
          label: "notify",
        },
        pending: {
          label: "pending",
        },
        reject: {
          detailKeys: ["requestId"],
          label: "reject",
        },
        screen_record: {
          detailKeys: ["node", "nodeId", "duration", "durationMs", "fps", "screenIndex"],
          label: "screen record",
        },
        status: {
          label: "status",
        },
      },
      emoji: "📱",
      title: "Nodes",
    },
    pdf: {
      detailKeys: ["path", "paths", "url", "urls", "prompt", "pageRange", "model"],
      emoji: "📑",
      title: "PDF",
    },
    process: {
      detailKeys: ["sessionId"],
      emoji: "🧰",
      title: "Process",
    },
    read: {
      detailKeys: ["path"],
      emoji: "📖",
      title: "Read",
    },
    session_status: {
      detailKeys: ["sessionKey", "model"],
      emoji: "📊",
      title: "Session Status",
    },
    sessions_history: {
      detailKeys: ["sessionKey", "limit", "includeTools"],
      emoji: "🧾",
      title: "Session History",
    },
    sessions_list: {
      detailKeys: ["kinds", "limit", "activeMinutes", "messageLimit"],
      emoji: "🗂️",
      title: "Sessions",
    },
    sessions_send: {
      detailKeys: ["label", "sessionKey", "agentId", "timeoutSeconds"],
      emoji: "📨",
      title: "Session Send",
    },
    sessions_spawn: {
      detailKeys: ["label", "task", "agentId", "model", "thinking", "runTimeoutSeconds", "cleanup"],
      emoji: "🧑‍🔧",
      title: "Sub-agent",
    },
    sessions_yield: {
      detailKeys: ["message"],
      emoji: "⏸️",
      title: "Yield",
    },
    subagents: {
      actions: {
        kill: {
          detailKeys: ["target"],
          label: "kill",
        },
        list: {
          detailKeys: ["recentMinutes"],
          label: "list",
        },
        steer: {
          detailKeys: ["target"],
          label: "steer",
        },
      },
      emoji: "🤖",
      title: "Subagents",
    },
    tool_call: {
      detailKeys: [],
      emoji: "🧰",
      title: "Tool Call",
    },
    tool_call_update: {
      detailKeys: [],
      emoji: "🧰",
      title: "Tool Call",
    },
    tts: {
      detailKeys: ["text", "channel"],
      emoji: "🔊",
      title: "TTS",
    },
    update_plan: {
      detailKeys: ["explanation", "plan.0.step"],
      emoji: "🗺️",
      title: "Update Plan",
    },
    video_generate: {
      actions: {
        generate: {
          detailKeys: [
            "prompt",
            "model",
            "durationSeconds",
            "resolution",
            "aspectRatio",
            "audio",
            "watermark",
          ],
          label: "generate",
        },
        list: {
          detailKeys: ["provider", "model"],
          label: "list",
        },
      },
      emoji: "🎬",
      title: "Video Generation",
    },
    web_fetch: {
      detailKeys: ["url", "extractMode", "maxChars"],
      emoji: "📄",
      title: "Web Fetch",
    },
    web_search: {
      detailKeys: ["query", "count"],
      emoji: "🔎",
      title: "Web Search",
    },
    whatsapp_login: {
      actions: {
        start: {
          label: "start",
        },
        wait: {
          label: "wait",
        },
      },
      emoji: "🟢",
      title: "WhatsApp Login",
    },
    write: {
      detailKeys: ["path"],
      emoji: "✍️",
      title: "Write",
    },
  },
  version: 1,
};

export function serializeToolDisplayConfig(
  config: ToolDisplayConfig = TOOL_DISPLAY_CONFIG,
): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
