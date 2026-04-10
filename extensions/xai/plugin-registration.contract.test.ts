import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "xai",
  providerIds: ["xai"],
  requireGenerateVideo: true,
  toolNames: ["code_execution", "x_search"],
  videoGenerationProviderIds: ["xai"],
  webSearchProviderIds: ["grok"],
});
