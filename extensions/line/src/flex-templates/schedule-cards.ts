import { attachFooterText } from "./common.js";
import type { Action, FlexBox, FlexBubble, FlexComponent, FlexText } from "./types.js";

function buildTitleSubtitleHeader(params: { title: string; subtitle?: string }): FlexComponent[] {
  const { title, subtitle } = params;
  const headerContents: FlexComponent[] = [
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
    headerContents.push({
      color: "#888888",
      margin: "sm",
      size: "sm",
      text: subtitle,
      type: "text",
      wrap: true,
    } as FlexText);
  }

  return headerContents;
}

function buildCardHeaderSections(headerContents: FlexComponent[]): FlexComponent[] {
  return [
    {
      contents: headerContents,
      layout: "vertical",
      paddingBottom: "lg",
      type: "box",
    } as FlexBox,
    {
      color: "#EEEEEE",
      type: "separator",
    },
  ];
}

function createMegaBubbleWithFooter(params: {
  bodyContents: FlexComponent[];
  footer?: string;
}): FlexBubble {
  const bubble: FlexBubble = {
    body: {
      backgroundColor: "#FFFFFF",
      contents: params.bodyContents,
      layout: "vertical",
      paddingAll: "xl",
      type: "box",
    },
    size: "mega",
    type: "bubble",
  };

  if (params.footer) {
    attachFooterText(bubble, params.footer);
  }

  return bubble;
}

/**
 * Create a receipt/summary card (for orders, transactions, data tables)
 *
 * Editorial design: Clean table layout with alternating row backgrounds,
 * prominent total section, and clear visual hierarchy.
 */
export function createReceiptCard(params: {
  title: string;
  subtitle?: string;
  items: { name: string; value: string; highlight?: boolean }[];
  total?: { label: string; value: string };
  footer?: string;
}): FlexBubble {
  const { title, subtitle, items, total, footer } = params;

  const itemRows: FlexComponent[] = items.slice(0, 12).map(
    (item, index) =>
      ({
        backgroundColor: index % 2 === 0 ? "#FFFFFF" : "#FAFAFA",
        contents: [
          {
            color: item.highlight ? "#111111" : "#666666",
            flex: 3,
            size: "sm",
            text: item.name,
            type: "text",
            weight: item.highlight ? "bold" : "regular",
            wrap: true,
          } as FlexText,
          {
            align: "end",
            color: item.highlight ? "#06C755" : "#333333",
            flex: 2,
            size: "sm",
            text: item.value,
            type: "text",
            weight: item.highlight ? "bold" : "regular",
            wrap: true,
          } as FlexText,
        ],
        layout: "horizontal",
        paddingAll: "md",
        type: "box",
      }) as FlexBox,
  );

  // Header section
  const headerContents = buildTitleSubtitleHeader({ subtitle, title });

  const bodyContents: FlexComponent[] = [
    ...buildCardHeaderSections(headerContents),
    {
      borderColor: "#EEEEEE",
      borderWidth: "light",
      contents: itemRows,
      cornerRadius: "md",
      layout: "vertical",
      margin: "md",
      type: "box",
    } as FlexBox,
  ];

  // Total section with emphasis
  if (total) {
    bodyContents.push({
      backgroundColor: "#F0FDF4",
      contents: [
        {
          color: "#111111",
          flex: 2,
          size: "lg",
          text: total.label,
          type: "text",
          weight: "bold",
        } as FlexText,
        {
          align: "end",
          color: "#06C755",
          flex: 2,
          size: "xl",
          text: total.value,
          type: "text",
          weight: "bold",
        } as FlexText,
      ],
      cornerRadius: "lg",
      layout: "horizontal",
      margin: "xl",
      paddingAll: "lg",
      type: "box",
    } as FlexBox);
  }

  return createMegaBubbleWithFooter({ bodyContents, footer });
}

/**
 * Create a calendar event card (for meetings, appointments, reminders)
 *
 * Editorial design: Date as hero, strong typographic hierarchy,
 * color-blocked zones, full text wrapping for readability.
 */
export function createEventCard(params: {
  title: string;
  date: string;
  time?: string;
  location?: string;
  description?: string;
  calendar?: string;
  isAllDay?: boolean;
  action?: Action;
}): FlexBubble {
  const { title, date, time, location, description, calendar, isAllDay, action } = params;

  // Hero date block - the most important information
  const dateBlock: FlexBox = {
    borderWidth: "none",
    contents: [
      {
        color: "#06C755",
        size: "sm",
        text: date.toUpperCase(),
        type: "text",
        weight: "bold",
        wrap: true,
      } as FlexText,
      {
        color: "#111111",
        margin: "xs",
        size: "xxl",
        text: isAllDay ? "ALL DAY" : (time ?? ""),
        type: "text",
        weight: "bold",
        wrap: true,
      } as FlexText,
    ],
    layout: "vertical",
    paddingBottom: "lg",
    type: "box",
  };

  // If no time and not all day, hide the time display
  if (!time && !isAllDay) {
    dateBlock.contents = [
      {
        color: "#111111",
        size: "xl",
        text: date,
        type: "text",
        weight: "bold",
        wrap: true,
      } as FlexText,
    ];
  }

  // Event title with accent bar
  const titleBlock: FlexBox = {
    borderColor: "#EEEEEE",
    borderWidth: "light",
    contents: [
      {
        backgroundColor: "#06C755",
        contents: [],
        cornerRadius: "2px",
        layout: "vertical",
        type: "box",
        width: "4px",
      } as FlexBox,
      {
        contents: [
          {
            type: "text",
            text: title,
            size: "lg",
            weight: "bold",
            color: "#1a1a1a",
            wrap: true,
          } as FlexText,
          ...(calendar
            ? [
                {
                  type: "text",
                  text: calendar,
                  size: "xs",
                  color: "#888888",
                  margin: "sm",
                  wrap: true,
                } as FlexText,
              ]
            : []),
        ],
        flex: 1,
        layout: "vertical",
        paddingStart: "lg",
        type: "box",
      } as FlexBox,
    ],
    layout: "horizontal",
    paddingBottom: "lg",
    paddingTop: "lg",
    type: "box",
  };

  const bodyContents: FlexComponent[] = [dateBlock, titleBlock];

  // Details section (location + description) in subtle background
  const hasDetails = location || description;
  if (hasDetails) {
    const detailItems: FlexComponent[] = [];

    if (location) {
      detailItems.push({
        alignItems: "flex-start",
        contents: [
          {
            flex: 0,
            size: "sm",
            text: "📍",
            type: "text",
          } as FlexText,
          {
            color: "#444444",
            flex: 1,
            margin: "md",
            size: "sm",
            text: location,
            type: "text",
            wrap: true,
          } as FlexText,
        ],
        layout: "horizontal",
        type: "box",
      } as FlexBox);
    }

    if (description) {
      detailItems.push({
        color: "#666666",
        margin: location ? "lg" : "none",
        size: "sm",
        text: description,
        type: "text",
        wrap: true,
      } as FlexText);
    }

    bodyContents.push({
      backgroundColor: "#F8F9FA",
      contents: detailItems,
      cornerRadius: "lg",
      layout: "vertical",
      margin: "lg",
      paddingAll: "lg",
      type: "box",
    } as FlexBox);
  }

  return {
    body: {
      action,
      backgroundColor: "#FFFFFF",
      contents: bodyContents,
      layout: "vertical",
      paddingAll: "xl",
      type: "box",
    },
    size: "mega",
    type: "bubble",
  };
}

/**
 * Create a calendar agenda card showing multiple events
 *
 * Editorial timeline design: Time-focused left column with event details
 * on the right. Visual accent bars indicate event priority/recency.
 */
export function createAgendaCard(params: {
  title: string;
  subtitle?: string;
  events: {
    title: string;
    time?: string;
    location?: string;
    calendar?: string;
    isNow?: boolean;
  }[];
  footer?: string;
}): FlexBubble {
  const { title, subtitle, events, footer } = params;

  // Header with title and optional subtitle
  const headerContents = buildTitleSubtitleHeader({ subtitle, title });

  // Event timeline items
  const eventItems: FlexComponent[] = events.slice(0, 6).map((event, index) => {
    const isActive = event.isNow || index === 0;
    const accentColor = isActive ? "#06C755" : "#E5E5E5";

    // Time column (fixed width)
    const timeColumn: FlexBox = {
      contents: [
        {
          align: "end",
          color: isActive ? "#06C755" : "#666666",
          size: "sm",
          text: event.time ?? "—",
          type: "text",
          weight: isActive ? "bold" : "regular",
          wrap: true,
        } as FlexText,
      ],
      justifyContent: "flex-start",
      layout: "vertical",
      type: "box",
      width: "65px",
    };

    // Accent dot
    const dotColumn: FlexBox = {
      alignItems: "center",
      contents: [
        {
          backgroundColor: accentColor,
          contents: [],
          cornerRadius: "5px",
          height: "10px",
          layout: "vertical",
          type: "box",
          width: "10px",
        } as FlexBox,
      ],
      justifyContent: "flex-start",
      layout: "vertical",
      paddingTop: "xs",
      type: "box",
      width: "24px",
    };

    // Event details column
    const detailContents: FlexComponent[] = [
      {
        color: "#1a1a1a",
        size: "md",
        text: event.title,
        type: "text",
        weight: "bold",
        wrap: true,
      } as FlexText,
    ];

    // Secondary info line
    const secondaryParts: string[] = [];
    if (event.location) {
      secondaryParts.push(event.location);
    }
    if (event.calendar) {
      secondaryParts.push(event.calendar);
    }

    if (secondaryParts.length > 0) {
      detailContents.push({
        color: "#888888",
        margin: "xs",
        size: "xs",
        text: secondaryParts.join(" · "),
        type: "text",
        wrap: true,
      } as FlexText);
    }

    const detailColumn: FlexBox = {
      contents: detailContents,
      flex: 1,
      layout: "vertical",
      type: "box",
    };

    return {
      alignItems: "flex-start",
      contents: [timeColumn, dotColumn, detailColumn],
      layout: "horizontal",
      margin: index > 0 ? "xl" : undefined,
      type: "box",
    } as FlexBox;
  });

  const bodyContents: FlexComponent[] = [
    ...buildCardHeaderSections(headerContents),
    {
      contents: eventItems,
      layout: "vertical",
      paddingTop: "xl",
      type: "box",
    } as FlexBox,
  ];

  return createMegaBubbleWithFooter({ bodyContents, footer });
}
