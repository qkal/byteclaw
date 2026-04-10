import type { FlexBox, FlexBubble, FlexText } from "./types.js";

export function attachFooterText(bubble: FlexBubble, footer: string) {
  bubble.footer = {
    backgroundColor: "#FAFAFA",
    contents: [
      {
        align: "center",
        color: "#AAAAAA",
        size: "xs",
        text: footer,
        type: "text",
        wrap: true,
      } as FlexText,
    ],
    layout: "vertical",
    paddingAll: "lg",
    type: "box",
  } as FlexBox;
}
