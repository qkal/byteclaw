import { pluginRegistrationContractCases } from "../../test/helpers/plugins/plugin-registration-contract-cases.js";
import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  ...pluginRegistrationContractCases.google,
  requireDescribeImages: true,
  requireGenerateImage: true,
  requireGenerateVideo: true,
  videoGenerationProviderIds: ["google"],
  webSearchProviderIds: ["gemini"],
});
