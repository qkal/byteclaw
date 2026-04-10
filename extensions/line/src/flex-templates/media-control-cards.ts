import type {
  FlexBox,
  FlexBubble,
  FlexButton,
  FlexComponent,
  FlexImage,
  FlexText,
} from "./types.js";

/**
 * Create a media player card for Sonos, Spotify, Apple Music, etc.
 *
 * Editorial design: Album art hero with gradient overlay for text,
 * prominent now-playing indicator, refined playback controls.
 */
export function createMediaPlayerCard(params: {
  title: string;
  subtitle?: string;
  source?: string;
  imageUrl?: string;
  isPlaying?: boolean;
  progress?: string;
  controls?: {
    previous?: { data: string };
    play?: { data: string };
    pause?: { data: string };
    next?: { data: string };
  };
  extraActions?: { label: string; data: string }[];
}): FlexBubble {
  const { title, subtitle, source, imageUrl, isPlaying, progress, controls, extraActions } = params;

  // Track info section
  const trackInfo: FlexComponent[] = [
    {
      color: "#111111",
      size: "xl",
      text: title,
      type: "text",
      weight: "bold",
      wrap: true,
    } as FlexText,
  ];

  if (subtitle) {
    trackInfo.push({
      color: "#666666",
      margin: "sm",
      size: "md",
      text: subtitle,
      type: "text",
      wrap: true,
    } as FlexText);
  }

  // Status row with source and playing indicator
  const statusItems: FlexComponent[] = [];

  if (isPlaying !== undefined) {
    statusItems.push({
      alignItems: "center",
      contents: [
        {
          backgroundColor: isPlaying ? "#06C755" : "#CCCCCC",
          contents: [],
          cornerRadius: "4px",
          height: "8px",
          layout: "vertical",
          type: "box",
          width: "8px",
        } as FlexBox,
        {
          color: isPlaying ? "#06C755" : "#888888",
          margin: "sm",
          size: "xs",
          text: isPlaying ? "Now Playing" : "Paused",
          type: "text",
          weight: "bold",
        } as FlexText,
      ],
      layout: "horizontal",
      type: "box",
    } as FlexBox);
  }

  if (source) {
    statusItems.push({
      color: "#AAAAAA",
      margin: statusItems.length > 0 ? "lg" : undefined,
      size: "xs",
      text: source,
      type: "text",
    } as FlexText);
  }

  if (progress) {
    statusItems.push({
      align: "end",
      color: "#888888",
      flex: 1,
      size: "xs",
      text: progress,
      type: "text",
    } as FlexText);
  }

  const bodyContents: FlexComponent[] = [
    {
      contents: trackInfo,
      layout: "vertical",
      type: "box",
    } as FlexBox,
  ];

  if (statusItems.length > 0) {
    bodyContents.push({
      alignItems: "center",
      contents: statusItems,
      layout: "horizontal",
      margin: "lg",
      type: "box",
    } as FlexBox);
  }

  const bubble: FlexBubble = {
    body: {
      backgroundColor: "#FFFFFF",
      contents: bodyContents,
      layout: "vertical",
      paddingAll: "xl",
      type: "box",
    },
    size: "mega",
    type: "bubble",
  };

  // Album art hero
  if (imageUrl) {
    bubble.hero = {
      aspectMode: "cover",
      aspectRatio: "1:1",
      size: "full",
      type: "image",
      url: imageUrl,
    } as FlexImage;
  }

  // Control buttons in footer
  if (controls || extraActions?.length) {
    const footerContents: FlexComponent[] = [];

    // Main playback controls with refined styling
    if (controls) {
      const controlButtons: FlexComponent[] = [];

      if (controls.previous) {
        controlButtons.push({
          action: {
            data: controls.previous.data,
            label: "⏮",
            type: "postback",
          },
          flex: 1,
          height: "sm",
          style: "secondary",
          type: "button",
        } as FlexButton);
      }

      if (controls.play) {
        controlButtons.push({
          action: {
            data: controls.play.data,
            label: "▶",
            type: "postback",
          },
          flex: 1,
          height: "sm",
          margin: controls.previous ? "md" : undefined,
          style: isPlaying ? "secondary" : "primary",
          type: "button",
        } as FlexButton);
      }

      if (controls.pause) {
        controlButtons.push({
          action: {
            data: controls.pause.data,
            label: "⏸",
            type: "postback",
          },
          flex: 1,
          height: "sm",
          margin: controlButtons.length > 0 ? "md" : undefined,
          style: isPlaying ? "primary" : "secondary",
          type: "button",
        } as FlexButton);
      }

      if (controls.next) {
        controlButtons.push({
          action: {
            data: controls.next.data,
            label: "⏭",
            type: "postback",
          },
          flex: 1,
          height: "sm",
          margin: controlButtons.length > 0 ? "md" : undefined,
          style: "secondary",
          type: "button",
        } as FlexButton);
      }

      if (controlButtons.length > 0) {
        footerContents.push({
          contents: controlButtons,
          layout: "horizontal",
          type: "box",
        } as FlexBox);
      }
    }

    // Extra actions
    if (extraActions?.length) {
      footerContents.push({
        contents: extraActions.slice(0, 2).map(
          (action, index) =>
            ({
              action: {
                data: action.data,
                label: action.label.slice(0, 15),
                type: "postback",
              },
              flex: 1,
              height: "sm",
              margin: index > 0 ? "md" : undefined,
              style: "secondary",
              type: "button",
            }) as FlexButton,
        ),
        layout: "horizontal",
        margin: "md",
        type: "box",
      } as FlexBox);
    }

    if (footerContents.length > 0) {
      bubble.footer = {
        backgroundColor: "#FAFAFA",
        contents: footerContents,
        layout: "vertical",
        paddingAll: "lg",
        type: "box",
      };
    }
  }

  return bubble;
}

/**
 * Create an Apple TV remote card with a D-pad and control rows.
 */
export function createAppleTvRemoteCard(params: {
  deviceName: string;
  status?: string;
  actionData: {
    up: string;
    down: string;
    left: string;
    right: string;
    select: string;
    menu: string;
    home: string;
    play: string;
    pause: string;
    volumeUp: string;
    volumeDown: string;
    mute: string;
  };
}): FlexBubble {
  const { deviceName, status, actionData } = params;

  const headerContents: FlexComponent[] = [
    {
      color: "#111111",
      size: "xl",
      text: deviceName,
      type: "text",
      weight: "bold",
      wrap: true,
    } as FlexText,
  ];

  if (status) {
    headerContents.push({
      color: "#666666",
      margin: "sm",
      size: "sm",
      text: status,
      type: "text",
      wrap: true,
    } as FlexText);
  }

  const makeButton = (
    label: string,
    data: string,
    style: "primary" | "secondary" = "secondary",
  ): FlexButton => ({
    action: {
      data,
      label,
      type: "postback",
    },
    flex: 1,
    height: "sm",
    style,
    type: "button",
  });

  const dpadRows: FlexComponent[] = [
    {
      contents: [{ type: "filler" }, makeButton("↑", actionData.up), { type: "filler" }],
      layout: "horizontal",
      type: "box",
    } as FlexBox,
    {
      contents: [
        makeButton("←", actionData.left),
        makeButton("OK", actionData.select, "primary"),
        makeButton("→", actionData.right),
      ],
      layout: "horizontal",
      margin: "md",
      type: "box",
    } as FlexBox,
    {
      contents: [{ type: "filler" }, makeButton("↓", actionData.down), { type: "filler" }],
      layout: "horizontal",
      margin: "md",
      type: "box",
    } as FlexBox,
  ];

  const menuRow: FlexComponent = {
    contents: [makeButton("Menu", actionData.menu), makeButton("Home", actionData.home)],
    layout: "horizontal",
    margin: "lg",
    type: "box",
  } as FlexBox;

  const playbackRow: FlexComponent = {
    contents: [makeButton("Play", actionData.play), makeButton("Pause", actionData.pause)],
    layout: "horizontal",
    margin: "md",
    type: "box",
  } as FlexBox;

  const volumeRow: FlexComponent = {
    contents: [
      makeButton("Vol +", actionData.volumeUp),
      makeButton("Mute", actionData.mute),
      makeButton("Vol -", actionData.volumeDown),
    ],
    layout: "horizontal",
    margin: "md",
    type: "box",
  } as FlexBox;

  return {
    body: {
      backgroundColor: "#FFFFFF",
      contents: [
        {
          contents: headerContents,
          layout: "vertical",
          type: "box",
        } as FlexBox,
        {
          color: "#EEEEEE",
          margin: "lg",
          type: "separator",
        },
        ...dpadRows,
        menuRow,
        playbackRow,
        volumeRow,
      ],
      layout: "vertical",
      paddingAll: "xl",
      type: "box",
    },
    size: "mega",
    type: "bubble",
  };
}

/**
 * Create a device control card for Apple TV, smart home devices, etc.
 *
 * Editorial design: Device-focused header with status indicator,
 * clean control grid with clear visual hierarchy.
 */
export function createDeviceControlCard(params: {
  deviceName: string;
  deviceType?: string;
  status?: string;
  isOnline?: boolean;
  imageUrl?: string;
  controls: {
    label: string;
    icon?: string;
    data: string;
    style?: "primary" | "secondary";
  }[];
}): FlexBubble {
  const { deviceName, deviceType, status, isOnline, imageUrl, controls } = params;

  // Device header with status indicator
  const headerContents: FlexComponent[] = [
    {
      alignItems: "center",
      contents: [
        // Status dot
        {
          backgroundColor: isOnline !== false ? "#06C755" : "#FF5555",
          contents: [],
          cornerRadius: "5px",
          height: "10px",
          layout: "vertical",
          type: "box",
          width: "10px",
        } as FlexBox,
        {
          color: "#111111",
          flex: 1,
          margin: "md",
          size: "xl",
          text: deviceName,
          type: "text",
          weight: "bold",
          wrap: true,
        } as FlexText,
      ],
      layout: "horizontal",
      type: "box",
    } as FlexBox,
  ];

  if (deviceType) {
    headerContents.push({
      color: "#888888",
      margin: "sm",
      size: "sm",
      text: deviceType,
      type: "text",
    } as FlexText);
  }

  if (status) {
    headerContents.push({
      backgroundColor: "#F8F9FA",
      contents: [
        {
          color: "#444444",
          size: "sm",
          text: status,
          type: "text",
          wrap: true,
        } as FlexText,
      ],
      cornerRadius: "md",
      layout: "vertical",
      margin: "lg",
      paddingAll: "md",
      type: "box",
    } as FlexBox);
  }

  const bubble: FlexBubble = {
    body: {
      backgroundColor: "#FFFFFF",
      contents: headerContents,
      layout: "vertical",
      paddingAll: "xl",
      type: "box",
    },
    size: "mega",
    type: "bubble",
  };

  if (imageUrl) {
    bubble.hero = {
      aspectMode: "cover",
      aspectRatio: "16:9",
      size: "full",
      type: "image",
      url: imageUrl,
    } as FlexImage;
  }

  // Control buttons in refined grid layout (2 per row)
  if (controls.length > 0) {
    const rows: FlexComponent[] = [];
    const limitedControls = controls.slice(0, 6);

    for (let i = 0; i < limitedControls.length; i += 2) {
      const rowButtons: FlexComponent[] = [];

      for (let j = i; j < Math.min(i + 2, limitedControls.length); j++) {
        const ctrl = limitedControls[j];
        const buttonLabel = ctrl.icon ? `${ctrl.icon} ${ctrl.label}` : ctrl.label;

        rowButtons.push({
          action: {
            data: ctrl.data,
            label: buttonLabel.slice(0, 18),
            type: "postback",
          },
          flex: 1,
          height: "sm",
          margin: j > i ? "md" : undefined,
          style: ctrl.style ?? "secondary",
          type: "button",
        } as FlexButton);
      }

      // If odd number of controls in last row, add spacer
      if (rowButtons.length === 1) {
        rowButtons.push({
          type: "filler",
        });
      }

      rows.push({
        contents: rowButtons,
        layout: "horizontal",
        margin: i > 0 ? "md" : undefined,
        type: "box",
      } as FlexBox);
    }

    bubble.footer = {
      backgroundColor: "#FAFAFA",
      contents: rows,
      layout: "vertical",
      paddingAll: "lg",
      type: "box",
    };
  }

  return bubble;
}
