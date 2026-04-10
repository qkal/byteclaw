export const BLUEBUBBLES_ACTIONS = {
  addParticipant: { gate: "addParticipant", groupOnly: true },
  edit: { gate: "edit", unsupportedOnMacOS26: true },
  leaveGroup: { gate: "leaveGroup", groupOnly: true },
  react: { gate: "reactions" },
  removeParticipant: { gate: "removeParticipant", groupOnly: true },
  renameGroup: { gate: "renameGroup", groupOnly: true },
  reply: { gate: "reply" },
  sendAttachment: { gate: "sendAttachment" },
  sendWithEffect: { gate: "sendWithEffect" },
  setGroupIcon: { gate: "setGroupIcon", groupOnly: true },
  unsend: { gate: "unsend" },
} as const;

type BlueBubblesActionSpecs = typeof BLUEBUBBLES_ACTIONS;

export const BLUEBUBBLES_ACTION_NAMES = Object.keys(
  BLUEBUBBLES_ACTIONS,
) as (keyof BlueBubblesActionSpecs)[];
