import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
import {
  buildConfigureCandidates,
  buildConfigureCandidatesForScope,
  buildSecretsConfigurePlan,
  collectConfigureProviderChanges,
  hasConfigurePlanChanges,
} from "./configure-plan.js";

describe("secrets configure plan helpers", () => {
  it("builds configure candidates from supported configure targets", () => {
    const config = {
      channels: {
        telegram: {
          botToken: "token", // Pragma: allowlist secret
        },
      },
      talk: {
        providers: {
          [TALK_TEST_PROVIDER_ID]: {
            apiKey: "plain", // Pragma: allowlist secret
          },
        },
      },
    } as OpenClawConfig;

    const candidates = buildConfigureCandidates(config);
    const paths = candidates.map((entry) => entry.path);
    expect(paths).toContain(TALK_TEST_PROVIDER_API_KEY_PATH);
    expect(paths).toContain("channels.telegram.botToken");
  });

  it("collects provider upserts and deletes", () => {
    const original = {
      secrets: {
        providers: {
          default: { source: "env" },
          legacy: { source: "env" },
        },
      },
    } as OpenClawConfig;
    const next = {
      secrets: {
        providers: {
          default: { allowlist: ["OPENAI_API_KEY"], source: "env" },
          modern: { source: "env" },
        },
      },
    } as OpenClawConfig;

    const changes = collectConfigureProviderChanges({ next, original });
    expect(Object.keys(changes.upserts).toSorted()).toEqual(["default", "modern"]);
    expect(changes.deletes).toEqual(["legacy"]);
  });

  it("discovers auth-profiles candidates for the selected agent scope", () => {
    const candidates = buildConfigureCandidatesForScope({
      authProfiles: {
        agentId: "main",
        store: {
          profiles: {
            "openai:default": {
              key: "sk",
              provider: "openai",
              type: "api_key",
            },
          },
          version: 1,
        },
      },
      config: {} as OpenClawConfig,
    });
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "main",
          authProfileProvider: "openai",
          configFile: "auth-profiles.json",
          path: "profiles.openai:default.key",
          type: "auth-profiles.api_key.key",
        }),
      ]),
    );
  });

  it("captures existing refs for prefilled configure prompts", () => {
    const candidates = buildConfigureCandidatesForScope({
      authProfiles: {
        agentId: "main",
        store: {
          profiles: {
            "openai:default": {
              keyRef: {
                id: "OPENAI_API_KEY",
                provider: "default",
                source: "env",
              },
              provider: "openai",
              type: "api_key",
            },
          },
          version: 1,
        },
      },
      config: {
        talk: {
          providers: {
            [TALK_TEST_PROVIDER_ID]: {
              apiKey: {
                id: "TALK_API_KEY",
                provider: "default",
                source: "env",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          existingRef: {
            id: "TALK_API_KEY",
            provider: "default",
            source: "env",
          },
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
        }),
        expect.objectContaining({
          existingRef: {
            id: "OPENAI_API_KEY",
            provider: "default",
            source: "env", // Pragma: allowlist secret
          },
          path: "profiles.openai:default.key",
        }),
      ]),
    );
  });

  it("marks normalized alias paths as derived when not authored directly", () => {
    const candidates = buildConfigureCandidatesForScope({
      authoredOpenClawConfig: {
        talk: {
          apiKey: "demo-talk-key", // Pragma: allowlist secret
        },
      } as OpenClawConfig,
      config: {
        talk: {
          apiKey: "demo-talk-key",
          provider: TALK_TEST_PROVIDER_ID,
          providers: {
            [TALK_TEST_PROVIDER_ID]: {
              apiKey: "demo-talk-key", // pragma: allowlist secret
            },
          }, // Pragma: allowlist secret
        },
      } as OpenClawConfig,
    });

    const normalized = candidates.find((entry) => entry.path === TALK_TEST_PROVIDER_API_KEY_PATH);
    expect(normalized?.isDerived).toBe(true);
  });

  it("reports configure change presence and builds deterministic plan shape", () => {
    const selected = new Map([
      [
        TALK_TEST_PROVIDER_API_KEY_PATH,
        {
          configFile: "openclaw.json" as const,
          expectedResolvedValue: "string" as const,
          label: TALK_TEST_PROVIDER_API_KEY_PATH,
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: ["talk", "providers", TALK_TEST_PROVIDER_ID, "apiKey"],
          providerId: TALK_TEST_PROVIDER_ID,
          ref: {
            id: "TALK_API_KEY",
            provider: "default",
            source: "env" as const,
          },
          type: "talk.providers.*.apiKey",
        },
      ],
    ]);
    const providerChanges = {
      deletes: [],
      upserts: {
        default: { source: "env" as const },
      },
    };
    expect(
      hasConfigurePlanChanges({
        providerChanges,
        selectedTargets: selected,
      }),
    ).toBe(true);

    const plan = buildSecretsConfigurePlan({
      generatedAt: "2026-02-28T00:00:00.000Z",
      providerChanges,
      selectedTargets: selected,
    });
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]?.path).toBe(TALK_TEST_PROVIDER_API_KEY_PATH);
    expect(plan.providerUpserts).toBeDefined();
    expect(plan.options).toEqual({
      scrubAuthProfilesForProviderTargets: true,
      scrubEnv: true,
      scrubLegacyAuthJson: true,
    });
  });
});
