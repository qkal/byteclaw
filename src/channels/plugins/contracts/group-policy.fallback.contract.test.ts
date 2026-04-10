import { describe, expect, it } from "vitest";
import { installChannelRuntimeGroupPolicyFallbackSuite } from "../../../../test/helpers/channels/group-policy-contract-suites.js";
import {
  resolveWhatsAppRuntimeGroupPolicy,
  resolveZaloRuntimeGroupPolicy,
} from "../../../../test/helpers/channels/group-policy-contract.js";
import { resolveOpenProviderRuntimeGroupPolicy } from "../../../config/runtime-group-policy.js";

describe("channel runtime group policy fallback contract", () => {
  describe("slack", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      configuredLabel: "keeps open default when channels.slack is configured",
      defaultGroupPolicyUnderTest: "open",
      missingConfigLabel: "fails closed when channels.slack is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
      resolve: resolveOpenProviderRuntimeGroupPolicy,
    });
  });

  describe("telegram", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      configuredLabel: "keeps open fallback when channels.telegram is configured",
      defaultGroupPolicyUnderTest: "disabled",
      missingConfigLabel: "fails closed when channels.telegram is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit defaults when provider config is missing",
      resolve: resolveOpenProviderRuntimeGroupPolicy,
    });
  });

  describe("whatsapp", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      configuredLabel: "keeps open fallback when channels.whatsapp is configured",
      defaultGroupPolicyUnderTest: "disabled",
      missingConfigLabel: "fails closed when channels.whatsapp is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
      resolve: resolveWhatsAppRuntimeGroupPolicy,
    });
  });

  describe("imessage", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      configuredLabel: "keeps open fallback when channels.imessage is configured",
      defaultGroupPolicyUnderTest: "disabled",
      missingConfigLabel: "fails closed when channels.imessage is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
      resolve: resolveOpenProviderRuntimeGroupPolicy,
    });
  });

  describe("discord", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      configuredLabel: "keeps open default when channels.discord is configured",
      defaultGroupPolicyUnderTest: "open",
      missingConfigLabel: "fails closed when channels.discord is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
      resolve: resolveOpenProviderRuntimeGroupPolicy,
    });

    it.each([
      {
        groupPolicy: "disabled",
        providerConfigPresent: false,
      },
    ] as const)("respects explicit provider policy %#", (testCase) => {
      const resolved = resolveOpenProviderRuntimeGroupPolicy(testCase);
      expect(resolved.groupPolicy).toBe("disabled");
      expect(resolved.providerMissingFallbackApplied).toBe(false);
    });
  });

  describe("zalo", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      configuredLabel: "keeps open fallback when channels.zalo is configured",
      defaultGroupPolicyUnderTest: "open",
      missingConfigLabel: "fails closed when channels.zalo is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
      resolve: resolveZaloRuntimeGroupPolicy,
    });
  });
});
