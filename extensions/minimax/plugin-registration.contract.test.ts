import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  imageGenerationProviderIds: ["minimax", "minimax-portal"],
  mediaUnderstandingProviderIds: ["minimax", "minimax-portal"],
  pluginId: "minimax",
  providerIds: ["minimax", "minimax-portal"],
  requireDescribeImages: true,
  requireGenerateImage: true,
  requireGenerateVideo: true,
  speechProviderIds: ["minimax"],
  videoGenerationProviderIds: ["minimax"],
  webSearchProviderIds: ["minimax"],
});
