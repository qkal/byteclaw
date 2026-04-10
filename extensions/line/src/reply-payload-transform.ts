import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  createAgendaCard,
  createAppleTvRemoteCard,
  createDeviceControlCard,
  createEventCard,
  createMediaPlayerCard,
} from "./flex-templates.js";
import type { LineChannelData } from "./types.js";

/**
 * Parse LINE-specific directives from text and extract them into ReplyPayload fields.
 *
 * Supported directives:
 * - [[quick_replies: option1, option2, option3]]
 * - [[location: title | address | latitude | longitude]]
 * - [[confirm: question | yes_label | no_label]]
 * - [[buttons: title | text | btn1:data1, btn2:data2]]
 * - [[media_player: title | artist | source | imageUrl | playing/paused]]
 * - [[event: title | date | time | location | description]]
 * - [[agenda: title | event1_title:event1_time, event2_title:event2_time, ...]]
 * - [[device: name | type | status | ctrl1:data1, ctrl2:data2]]
 * - [[appletv_remote: name | status]]
 */
export function parseLineDirectives(payload: ReplyPayload): ReplyPayload {
  let { text } = payload;
  if (!text) {
    return payload;
  }

  const result: ReplyPayload = { ...payload };
  const lineData: LineChannelData = {
    ...(result.channelData?.line as LineChannelData | undefined),
  };
  const toSlug = (value: string): string =>
    normalizeLowercaseStringOrEmpty(value)
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "device";
  const lineActionData = (action: string, extras?: Record<string, string>): string => {
    const base = [`line.action=${encodeURIComponent(action)}`];
    if (extras) {
      for (const [key, value] of Object.entries(extras)) {
        base.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
    }
    return base.join("&");
  };

  const quickRepliesMatch = text.match(/\[\[quick_replies:\s*([^\]]+)\]\]/i);
  if (quickRepliesMatch) {
    const options = quickRepliesMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (options.length > 0) {
      lineData.quickReplies = [...(lineData.quickReplies || []), ...options];
    }
    text = text.replace(quickRepliesMatch[0], "").trim();
  }

  const locationMatch = text.match(/\[\[location:\s*([^\]]+)\]\]/i);
  if (locationMatch && !lineData.location) {
    const parts = locationMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 4) {
      const [title, address, latStr, lonStr] = parts;
      const latitude = Number.parseFloat(latStr);
      const longitude = Number.parseFloat(lonStr);
      if (!isNaN(latitude) && !isNaN(longitude)) {
        lineData.location = {
          address: address || "",
          latitude,
          longitude,
          title: title || "Location",
        };
      }
    }
    text = text.replace(locationMatch[0], "").trim();
  }

  const confirmMatch = text.match(/\[\[confirm:\s*([^\]]+)\]\]/i);
  if (confirmMatch && !lineData.templateMessage) {
    const parts = confirmMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 3) {
      const [question, yesPart, noPart] = parts;
      const [yesLabel, yesData] = yesPart.includes(":")
        ? yesPart.split(":").map((s) => s.trim())
        : [yesPart, normalizeLowercaseStringOrEmpty(yesPart)];
      const [noLabel, noData] = noPart.includes(":")
        ? noPart.split(":").map((s) => s.trim())
        : [noPart, normalizeLowercaseStringOrEmpty(noPart)];

      lineData.templateMessage = {
        altText: question,
        cancelData: noData,
        cancelLabel: noLabel,
        confirmData: yesData,
        confirmLabel: yesLabel,
        text: question,
        type: "confirm",
      };
    }
    text = text.replace(confirmMatch[0], "").trim();
  }

  const buttonsMatch = text.match(/\[\[buttons:\s*([^\]]+)\]\]/i);
  if (buttonsMatch && !lineData.templateMessage) {
    const parts = buttonsMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 3) {
      const [title, bodyText, actionsStr] = parts;

      const actions = actionsStr.split(",").map((actionStr) => {
        const trimmed = actionStr.trim();
        const colonIndex = (() => {
          const index = trimmed.indexOf(":");
          if (index === -1) {
            return -1;
          }
          const lower = normalizeLowercaseStringOrEmpty(trimmed);
          if (lower.startsWith("http://") || lower.startsWith("https://")) {
            return -1;
          }
          return index;
        })();

        let label: string;
        let data: string;

        if (colonIndex === -1) {
          label = trimmed;
          data = trimmed;
        } else {
          label = trimmed.slice(0, colonIndex).trim();
          data = trimmed.slice(colonIndex + 1).trim();
        }

        if (data.startsWith("http://") || data.startsWith("https://")) {
          return { label, type: "uri" as const, uri: data };
        }
        if (data.includes("=")) {
          return { data, label, type: "postback" as const };
        }
        return { data: data || label, label, type: "message" as const };
      });

      if (actions.length > 0) {
        lineData.templateMessage = {
          actions: actions.slice(0, 4),
          altText: `${title}: ${bodyText}`,
          text: bodyText,
          title,
          type: "buttons",
        };
      }
    }
    text = text.replace(buttonsMatch[0], "").trim();
  }

  const mediaPlayerMatch = text.match(/\[\[media_player:\s*([^\]]+)\]\]/i);
  if (mediaPlayerMatch && !lineData.flexMessage) {
    const parts = mediaPlayerMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 1) {
      const [title, artist, source, imageUrl, statusStr] = parts;
      const isPlaying = normalizeLowercaseStringOrEmpty(statusStr) === "playing";
      const validImageUrl = imageUrl?.startsWith("https://") ? imageUrl : undefined;
      const deviceKey = toSlug(source || title || "media");
      const card = createMediaPlayerCard({
        controls: {
          next: { data: lineActionData("next", { "line.device": deviceKey }) },
          pause: { data: lineActionData("pause", { "line.device": deviceKey }) },
          play: { data: lineActionData("play", { "line.device": deviceKey }) },
          previous: { data: lineActionData("previous", { "line.device": deviceKey }) },
        },
        imageUrl: validImageUrl,
        isPlaying: statusStr ? isPlaying : undefined,
        source: source || undefined,
        subtitle: artist || undefined,
        title: title || "Unknown Track",
      });

      lineData.flexMessage = {
        altText: `🎵 ${title}${artist ? ` - ${artist}` : ""}`,
        contents: card,
      };
    }
    text = text.replace(mediaPlayerMatch[0], "").trim();
  }

  const eventMatch = text.match(/\[\[event:\s*([^\]]+)\]\]/i);
  if (eventMatch && !lineData.flexMessage) {
    const parts = eventMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 2) {
      const [title, date, time, location, description] = parts;

      const card = createEventCard({
        date: date || "TBD",
        description: description || undefined,
        location: location || undefined,
        time: time || undefined,
        title: title || "Event",
      });

      lineData.flexMessage = {
        altText: `📅 ${title} - ${date}${time ? ` ${time}` : ""}`,
        contents: card,
      };
    }
    text = text.replace(eventMatch[0], "").trim();
  }

  const appleTvMatch = text.match(/\[\[appletv_remote:\s*([^\]]+)\]\]/i);
  if (appleTvMatch && !lineData.flexMessage) {
    const parts = appleTvMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 1) {
      const [deviceName, status] = parts;
      const deviceKey = toSlug(deviceName || "apple_tv");

      const card = createAppleTvRemoteCard({
        actionData: {
          down: lineActionData("down", { "line.device": deviceKey }),
          home: lineActionData("home", { "line.device": deviceKey }),
          left: lineActionData("left", { "line.device": deviceKey }),
          menu: lineActionData("menu", { "line.device": deviceKey }),
          mute: lineActionData("mute", { "line.device": deviceKey }),
          pause: lineActionData("pause", { "line.device": deviceKey }),
          play: lineActionData("play", { "line.device": deviceKey }),
          right: lineActionData("right", { "line.device": deviceKey }),
          select: lineActionData("select", { "line.device": deviceKey }),
          up: lineActionData("up", { "line.device": deviceKey }),
          volumeDown: lineActionData("volume_down", { "line.device": deviceKey }),
          volumeUp: lineActionData("volume_up", { "line.device": deviceKey }),
        },
        deviceName: deviceName || "Apple TV",
        status: status || undefined,
      });

      lineData.flexMessage = {
        altText: `📺 ${deviceName || "Apple TV"} Remote`,
        contents: card,
      };
    }
    text = text.replace(appleTvMatch[0], "").trim();
  }

  const agendaMatch = text.match(/\[\[agenda:\s*([^\]]+)\]\]/i);
  if (agendaMatch && !lineData.flexMessage) {
    const parts = agendaMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 2) {
      const [title, eventsStr] = parts;
      const events = eventsStr.split(",").map((eventStr) => {
        const trimmed = eventStr.trim();
        const colonIdx = trimmed.lastIndexOf(":");
        if (colonIdx > 0) {
          return {
            time: trimmed.slice(colonIdx + 1).trim(),
            title: trimmed.slice(0, colonIdx).trim(),
          };
        }
        return { title: trimmed };
      });

      const card = createAgendaCard({
        events,
        title: title || "Agenda",
      });

      lineData.flexMessage = {
        altText: `📋 ${title} (${events.length} events)`,
        contents: card,
      };
    }
    text = text.replace(agendaMatch[0], "").trim();
  }

  const deviceMatch = text.match(/\[\[device:\s*([^\]]+)\]\]/i);
  if (deviceMatch && !lineData.flexMessage) {
    const parts = deviceMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 1) {
      const [deviceName, deviceType, status, controlsStr] = parts;
      const deviceKey = toSlug(deviceName || "device");
      const controls = controlsStr
        ? controlsStr.split(",").map((ctrlStr) => {
            const [label, data] = ctrlStr.split(":").map((s) => s.trim());
            const action = data || normalizeLowercaseStringOrEmpty(label).replace(/\s+/g, "_");
            return { data: lineActionData(action, { "line.device": deviceKey }), label };
          })
        : [];

      const card = createDeviceControlCard({
        controls,
        deviceName: deviceName || "Device",
        deviceType: deviceType || undefined,
        status: status || undefined,
      });

      lineData.flexMessage = {
        altText: `📱 ${deviceName}${status ? `: ${status}` : ""}`,
        contents: card,
      };
    }
    text = text.replace(deviceMatch[0], "").trim();
  }

  text = text.replace(/\n{3,}/g, "\n\n").trim();

  result.text = text || undefined;
  if (Object.keys(lineData).length > 0) {
    result.channelData = { ...result.channelData, line: lineData };
  }
  return result;
}

export function hasLineDirectives(text: string): boolean {
  return /\[\[(quick_replies|location|confirm|buttons|media_player|event|agenda|device|appletv_remote):/i.test(
    text,
  );
}
