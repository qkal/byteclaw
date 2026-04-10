import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  imageGenerationProviderIds: ["fal"],
  pluginId: "fal",
  providerIds: ["fal"],
  requireGenerateImage: true,
  requireGenerateVideo: true,
  videoGenerationProviderIds: ["fal"],
});
