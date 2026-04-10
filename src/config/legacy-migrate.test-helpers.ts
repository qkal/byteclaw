export const WHISPER_BASE_AUDIO_MODEL = {
  enabled: true,
  models: [
    {
      args: ["--model", "base"],
      command: "whisper",
      timeoutSeconds: 2,
      type: "cli",
    },
  ],
};
