import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  imageGenerationProviderIds: ["vydra"],
  manifestAuthChoice: {
    choiceId: "vydra-api-key",
    choiceLabel: "Vydra API key",
    groupHint: "Image, video, and speech",
    groupId: "vydra",
    groupLabel: "Vydra",
    pluginId: "vydra",
  },
  pluginId: "vydra",
  providerIds: ["vydra"],
  requireGenerateImage: true,
  requireGenerateVideo: true,
  requireSpeechVoices: true,
  speechProviderIds: ["vydra"],
  videoGenerationProviderIds: ["vydra"],
});
