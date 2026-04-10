import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "runway",
  requireGenerateVideo: true,
  videoGenerationProviderIds: ["runway"],
});
