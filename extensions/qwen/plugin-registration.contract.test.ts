import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  mediaUnderstandingProviderIds: ["qwen"],
  pluginId: "qwen",
  providerIds: ["qwen"],
  requireDescribeImages: true,
  requireGenerateVideo: true,
  videoGenerationProviderIds: ["qwen"],
});
