import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  imageGenerationProviderIds: ["comfy"],
  musicGenerationProviderIds: ["comfy"],
  pluginId: "comfy",
  providerIds: ["comfy"],
  requireGenerateImage: true,
  requireGenerateVideo: true,
  videoGenerationProviderIds: ["comfy"],
});
