/**
 * Builds an Adaptive Card for welcoming users when the bot is added to a conversation.
 */

const DEFAULT_PROMPT_STARTERS = [
  "What can you do?",
  "Summarize my last meeting",
  "Help me draft an email",
];

export interface WelcomeCardOptions {
  /** Bot display name. Falls back to "OpenClaw". */
  botName?: string;
  /** Custom prompt starters. Falls back to defaults. */
  promptStarters?: string[];
}

/**
 * Build a welcome Adaptive Card for 1:1 personal chats.
 */
export function buildWelcomeCard(options?: WelcomeCardOptions): Record<string, unknown> {
  const botName = options?.botName || "OpenClaw";
  const starters = options?.promptStarters?.length
    ? options.promptStarters
    : DEFAULT_PROMPT_STARTERS;

  return {
    actions: starters.map((label) => ({
      data: { msteams: { type: "imBack", value: label } },
      title: label,
      type: "Action.Submit",
    })),
    body: [
      {
        size: "medium",
        text: `Hi! I'm ${botName}.`,
        type: "TextBlock",
        weight: "bolder",
      },
      {
        text: "I can help you with questions, tasks, and more. Here are some things to try:",
        type: "TextBlock",
        wrap: true,
      },
    ],
    type: "AdaptiveCard",
    version: "1.5",
  };
}

/**
 * Build a brief welcome message for group chats (when the bot is @mentioned).
 */
export function buildGroupWelcomeText(botName?: string): string {
  const name = botName || "OpenClaw";
  return `Hi! I'm ${name}. Mention me with @${name} to get started.`;
}
