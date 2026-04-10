import { attachFooterText } from "./common.js";
import type {
  Action,
  CardAction,
  FlexBox,
  FlexBubble,
  FlexButton,
  FlexCarousel,
  FlexComponent,
  FlexImage,
  FlexText,
  ListItem,
} from "./types.js";

/**
 * Create an info card with title, body, and optional footer
 *
 * Editorial design: Clean hierarchy with accent bar, generous spacing,
 * and subtle background zones for visual separation.
 */
export function createInfoCard(title: string, body: string, footer?: string): FlexBubble {
  const bubble: FlexBubble = {
    body: {
      backgroundColor: "#FFFFFF",
      contents: [
        // Title with accent bar
        {
          contents: [
            {
              type: "box",
              layout: "vertical",
              contents: [],
              width: "4px",
              backgroundColor: "#06C755",
              cornerRadius: "2px",
            } as FlexBox,
            {
              type: "text",
              text: title,
              weight: "bold",
              size: "xl",
              color: "#111111",
              wrap: true,
              flex: 1,
              margin: "lg",
            } as FlexText,
          ],
          layout: "horizontal",
          type: "box",
        } as FlexBox,
        // Body text in subtle container
        {
          backgroundColor: "#F8F9FA",
          contents: [
            {
              type: "text",
              text: body,
              size: "md",
              color: "#444444",
              wrap: true,
              lineSpacing: "6px",
            } as FlexText,
          ],
          cornerRadius: "lg",
          layout: "vertical",
          margin: "xl",
          paddingAll: "lg",
          type: "box",
        } as FlexBox,
      ],
      layout: "vertical",
      paddingAll: "xl",
      type: "box",
    },
    size: "mega",
    type: "bubble",
  };

  if (footer) {
    attachFooterText(bubble, footer);
  }

  return bubble;
}

/**
 * Create a list card with title and multiple items
 *
 * Editorial design: Numbered/bulleted list with clear visual hierarchy,
 * accent dots for each item, and generous spacing.
 */
export function createListCard(title: string, items: ListItem[]): FlexBubble {
  const itemContents: FlexComponent[] = items.slice(0, 8).map((item, index) => {
    const itemContents: FlexComponent[] = [
      {
        color: "#1a1a1a",
        size: "md",
        text: item.title,
        type: "text",
        weight: "bold",
        wrap: true,
      } as FlexText,
    ];

    if (item.subtitle) {
      itemContents.push({
        color: "#888888",
        margin: "xs",
        size: "sm",
        text: item.subtitle,
        type: "text",
        wrap: true,
      } as FlexText);
    }

    const itemBox: FlexBox = {
      contents: [
        // Accent dot
        {
          alignItems: "center",
          contents: [
            {
              type: "box",
              layout: "vertical",
              contents: [],
              width: "8px",
              height: "8px",
              backgroundColor: index === 0 ? "#06C755" : "#DDDDDD",
              cornerRadius: "4px",
            } as FlexBox,
          ],
          layout: "vertical",
          paddingTop: "sm",
          type: "box",
          width: "20px",
        } as FlexBox,
        // Item content
        {
          contents: itemContents,
          flex: 1,
          layout: "vertical",
          type: "box",
        } as FlexBox,
      ],
      layout: "horizontal",
      margin: index > 0 ? "lg" : undefined,
      type: "box",
    };

    if (item.action) {
      itemBox.action = item.action;
    }

    return itemBox;
  });

  return {
    body: {
      backgroundColor: "#FFFFFF",
      contents: [
        {
          color: "#111111",
          size: "xl",
          text: title,
          type: "text",
          weight: "bold",
          wrap: true,
        } as FlexText,
        {
          color: "#EEEEEE",
          margin: "lg",
          type: "separator",
        },
        {
          contents: itemContents,
          layout: "vertical",
          margin: "lg",
          type: "box",
        } as FlexBox,
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
 * Create an image card with image, title, and optional body text
 */
export function createImageCard(
  imageUrl: string,
  title: string,
  body?: string,
  options?: {
    aspectRatio?: "1:1" | "1.51:1" | "1.91:1" | "4:3" | "16:9" | "20:13" | "2:1" | "3:1";
    aspectMode?: "cover" | "fit";
    action?: Action;
  },
): FlexBubble {
  const bubble: FlexBubble = {
    body: {
      contents: [
        {
          size: "xl",
          text: title,
          type: "text",
          weight: "bold",
          wrap: true,
        } as FlexText,
      ],
      layout: "vertical",
      paddingAll: "lg",
      type: "box",
    },
    hero: {
      action: options?.action,
      aspectMode: options?.aspectMode ?? "cover",
      aspectRatio: options?.aspectRatio ?? "20:13",
      size: "full",
      type: "image",
      url: imageUrl,
    } as FlexImage,
    type: "bubble",
  };

  if (body && bubble.body) {
    bubble.body.contents.push({
      color: "#666666",
      margin: "md",
      size: "md",
      text: body,
      type: "text",
      wrap: true,
    } as FlexText);
  }

  return bubble;
}

/**
 * Create an action card with title, body, and action buttons
 */
export function createActionCard(
  title: string,
  body: string,
  actions: CardAction[],
  options?: {
    imageUrl?: string;
    aspectRatio?: "1:1" | "1.51:1" | "1.91:1" | "4:3" | "16:9" | "20:13" | "2:1" | "3:1";
  },
): FlexBubble {
  const bubble: FlexBubble = {
    body: {
      contents: [
        {
          size: "xl",
          text: title,
          type: "text",
          weight: "bold",
          wrap: true,
        } as FlexText,
        {
          color: "#666666",
          margin: "md",
          size: "md",
          text: body,
          type: "text",
          wrap: true,
        } as FlexText,
      ],
      layout: "vertical",
      paddingAll: "lg",
      type: "box",
    },
    footer: {
      contents: actions.slice(0, 4).map(
        (action, index) =>
          ({
            action: action.action,
            margin: index > 0 ? "sm" : undefined,
            style: index === 0 ? "primary" : "secondary",
            type: "button",
          }) as FlexButton,
      ),
      layout: "vertical",
      paddingAll: "md",
      type: "box",
    },
    type: "bubble",
  };

  if (options?.imageUrl) {
    bubble.hero = {
      aspectMode: "cover",
      aspectRatio: options.aspectRatio ?? "20:13",
      size: "full",
      type: "image",
      url: options.imageUrl,
    } as FlexImage;
  }

  return bubble;
}

/**
 * Create a carousel container from multiple bubbles
 * LINE allows max 12 bubbles in a carousel
 */
export function createCarousel(bubbles: FlexBubble[]): FlexCarousel {
  return {
    contents: bubbles.slice(0, 12),
    type: "carousel",
  };
}

/**
 * Create a notification bubble (for alerts, status updates)
 *
 * Editorial design: Bold status indicator with accent color,
 * clear typography, optional icon for context.
 */
export function createNotificationBubble(
  text: string,
  options?: {
    icon?: string;
    type?: "info" | "success" | "warning" | "error";
    title?: string;
  },
): FlexBubble {
  // Color based on notification type
  const colors = {
    error: { accent: "#EF4444", bg: "#FEF2F2" },
    info: { accent: "#3B82F6", bg: "#EFF6FF" },
    success: { accent: "#06C755", bg: "#F0FDF4" },
    warning: { accent: "#F59E0B", bg: "#FFFBEB" },
  };
  const typeColors = colors[options?.type ?? "info"];

  const contents: FlexComponent[] = [];

  // Accent bar
  contents.push({
    backgroundColor: typeColors.accent,
    contents: [],
    cornerRadius: "2px",
    layout: "vertical",
    type: "box",
    width: "4px",
  } as FlexBox);

  // Content section
  const textContents: FlexComponent[] = [];

  if (options?.title) {
    textContents.push({
      color: "#111111",
      size: "md",
      text: options.title,
      type: "text",
      weight: "bold",
      wrap: true,
    } as FlexText);
  }

  textContents.push({
    color: options?.title ? "#666666" : "#333333",
    margin: options?.title ? "sm" : undefined,
    size: options?.title ? "sm" : "md",
    text,
    type: "text",
    wrap: true,
  } as FlexText);

  contents.push({
    contents: textContents,
    flex: 1,
    layout: "vertical",
    paddingStart: "lg",
    type: "box",
  } as FlexBox);

  return {
    body: {
      backgroundColor: typeColors.bg,
      contents,
      layout: "horizontal",
      paddingAll: "xl",
      type: "box",
    },
    type: "bubble",
  };
}
