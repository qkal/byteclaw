import { Type } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";

const discordComponentEmojiSchema = Type.Object({
  animated: Type.Optional(Type.Boolean()),
  id: Type.Optional(Type.String()),
  name: Type.String(),
});

const discordComponentOptionSchema = Type.Object({
  default: Type.Optional(Type.Boolean()),
  description: Type.Optional(Type.String()),
  emoji: Type.Optional(discordComponentEmojiSchema),
  label: Type.String(),
  value: Type.String(),
});

const discordComponentButtonSchema = Type.Object({
  allowedUsers: Type.Optional(
    Type.Array(
      Type.String({
        description: "Discord user ids or names allowed to interact with this button.",
      }),
    ),
  ),
  disabled: Type.Optional(Type.Boolean()),
  emoji: Type.Optional(discordComponentEmojiSchema),
  label: Type.String(),
  style: Type.Optional(stringEnum(["primary", "secondary", "success", "danger", "link"])),
  url: Type.Optional(Type.String()),
});

const discordComponentSelectSchema = Type.Object({
  maxValues: Type.Optional(Type.Number()),
  minValues: Type.Optional(Type.Number()),
  options: Type.Optional(Type.Array(discordComponentOptionSchema)),
  placeholder: Type.Optional(Type.String()),
  type: Type.Optional(stringEnum(["string", "user", "role", "mentionable", "channel"])),
});

const discordComponentBlockSchema = Type.Object({
  accessory: Type.Optional(
    Type.Object({
      button: Type.Optional(discordComponentButtonSchema),
      type: Type.String(),
      url: Type.Optional(Type.String()),
    }),
  ),
  buttons: Type.Optional(Type.Array(discordComponentButtonSchema)),
  divider: Type.Optional(Type.Boolean()),
  file: Type.Optional(Type.String()),
  items: Type.Optional(
    Type.Array(
      Type.Object({
        description: Type.Optional(Type.String()),
        spoiler: Type.Optional(Type.Boolean()),
        url: Type.String(),
      }),
    ),
  ),
  select: Type.Optional(discordComponentSelectSchema),
  spacing: Type.Optional(stringEnum(["small", "large"])),
  spoiler: Type.Optional(Type.Boolean()),
  text: Type.Optional(Type.String()),
  texts: Type.Optional(Type.Array(Type.String())),
  type: Type.String(),
});

const discordComponentModalFieldSchema = Type.Object({
  description: Type.Optional(Type.String()),
  label: Type.String(),
  maxLength: Type.Optional(Type.Number()),
  maxValues: Type.Optional(Type.Number()),
  minLength: Type.Optional(Type.Number()),
  minValues: Type.Optional(Type.Number()),
  name: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(discordComponentOptionSchema)),
  placeholder: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
  style: Type.Optional(stringEnum(["short", "paragraph"])),
  type: Type.String(),
});

const discordComponentModalSchema = Type.Object({
  fields: Type.Array(discordComponentModalFieldSchema),
  title: Type.String(),
  triggerLabel: Type.Optional(Type.String()),
  triggerStyle: Type.Optional(stringEnum(["primary", "secondary", "success", "danger", "link"])),
});

export function createDiscordMessageToolComponentsSchema() {
  return Type.Object(
    {
      blocks: Type.Optional(Type.Array(discordComponentBlockSchema)),
      container: Type.Optional(
        Type.Object({
          accentColor: Type.Optional(Type.String()),
          spoiler: Type.Optional(Type.Boolean()),
        }),
      ),
      modal: Type.Optional(discordComponentModalSchema),
      reusable: Type.Optional(
        Type.Boolean({
          description: "Allow components to be used multiple times until they expire.",
        }),
      ),
      text: Type.Optional(Type.String()),
    },
    {
      description:
        "Discord components v2 payload. Set reusable=true to keep buttons, selects, and forms active until expiry.",
    },
  );
}
