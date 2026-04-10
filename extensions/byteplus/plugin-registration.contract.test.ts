import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "byteplus",
  providerIds: ["byteplus", "byteplus-plan"],
  requireGenerateVideo: true,
  videoGenerationProviderIds: ["byteplus"],
});
