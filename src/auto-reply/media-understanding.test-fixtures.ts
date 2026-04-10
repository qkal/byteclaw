export function createSuccessfulImageMediaDecision() {
  return {
    attachments: [
      {
        attachmentIndex: 0,
        attempts: [
          {
            model: "gpt-5.4",
            outcome: "success",
            provider: "openai",
            type: "provider",
          },
        ],
        chosen: {
          model: "gpt-5.4",
          outcome: "success",
          provider: "openai",
          type: "provider",
        },
      },
    ],
    capability: "image",
    outcome: "success",
  } as const;
}
