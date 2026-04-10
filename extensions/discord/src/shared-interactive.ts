import { reduceInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import type {
  InteractiveButtonStyle,
  InteractiveReply,
} from "openclaw/plugin-sdk/interactive-runtime";
import type {
  DiscordComponentButtonStyle,
  DiscordComponentMessageSpec,
} from "./components.types.js";

function resolveDiscordInteractiveButtonStyle(
  style?: InteractiveButtonStyle,
): DiscordComponentButtonStyle | undefined {
  return style ?? "secondary";
}

const DISCORD_INTERACTIVE_BUTTON_ROW_SIZE = 5;

export function buildDiscordInteractiveComponents(
  interactive?: InteractiveReply,
): DiscordComponentMessageSpec | undefined {
  const blocks = reduceInteractiveReply(
    interactive,
    [] as NonNullable<DiscordComponentMessageSpec["blocks"]>,
    (state, block) => {
      if (block.type === "text") {
        const text = block.text.trim();
        if (text) {
          state.push({ text, type: "text" });
        }
        return state;
      }
      if (block.type === "buttons") {
        if (block.buttons.length === 0) {
          return state;
        }
        for (
          let index = 0;
          index < block.buttons.length;
          index += DISCORD_INTERACTIVE_BUTTON_ROW_SIZE
        ) {
          state.push({
            buttons: block.buttons
              .slice(index, index + DISCORD_INTERACTIVE_BUTTON_ROW_SIZE)
              .map((button) => ({
                callbackData: button.value,
                label: button.label,
                style: resolveDiscordInteractiveButtonStyle(button.style),
              })),
            type: "actions",
          });
        }
        return state;
      }
      if (block.type === "select" && block.options.length > 0) {
        state.push({
          select: {
            options: block.options.map((option) => ({
              label: option.label,
              value: option.value,
            })),
            placeholder: block.placeholder,
            type: "string",
          },
          type: "actions",
        });
      }
      return state;
    },
  );
  return blocks.length > 0 ? { blocks } : undefined;
}
