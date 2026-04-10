import { describe, expect, it } from "vitest";
import {
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../test-utils/secret-ref-test-vectors.js";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
import { isSecretsApplyPlan, resolveValidatedPlanTarget } from "./plan.js";

describe("secrets plan validation", () => {
  it("accepts legacy provider target types", () => {
    const resolved = resolveValidatedPlanTarget({
      path: "models.providers.openai.apiKey",
      pathSegments: ["models", "providers", "openai", "apiKey"],
      providerId: "openai",
      type: "models.providers.apiKey",
    });
    expect(resolved?.pathSegments).toEqual(["models", "providers", "openai", "apiKey"]);
  });

  it("accepts expanded target types beyond legacy surface", () => {
    const resolved = resolveValidatedPlanTarget({
      path: "channels.telegram.botToken",
      pathSegments: ["channels", "telegram", "botToken"],
      type: "channels.telegram.botToken",
    });
    expect(resolved?.pathSegments).toEqual(["channels", "telegram", "botToken"]);
  });

  it("accepts model provider header targets with wildcard-backed paths", () => {
    const resolved = resolveValidatedPlanTarget({
      path: "models.providers.openai.headers.x-api-key",
      pathSegments: ["models", "providers", "openai", "headers", "x-api-key"],
      providerId: "openai",
      type: "models.providers.headers",
    });
    expect(resolved?.pathSegments).toEqual([
      "models",
      "providers",
      "openai",
      "headers",
      "x-api-key",
    ]);
  });

  it("rejects target paths that do not match the registered shape", () => {
    const resolved = resolveValidatedPlanTarget({
      path: "channels.telegram.webhookSecret",
      pathSegments: ["channels", "telegram", "webhookSecret"],
      type: "channels.telegram.botToken",
    });
    expect(resolved).toBeNull();
  });

  it("validates plan files with non-legacy target types", () => {
    const isValid = isSecretsApplyPlan({
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      protocolVersion: 1,
      targets: [
        {
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          providerId: TALK_TEST_PROVIDER_ID,
          ref: { id: "TALK_API_KEY", provider: "default", source: "env" },
          type: "talk.providers.*.apiKey",
        },
      ],
      version: 1,
    });
    expect(isValid).toBe(true);
  });

  it("requires agentId for auth-profiles plan targets", () => {
    const withoutAgent = isSecretsApplyPlan({
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      protocolVersion: 1,
      targets: [
        {
          path: "profiles.openai:default.key",
          pathSegments: ["profiles", "openai:default", "key"],
          ref: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
          type: "auth-profiles.api_key.key",
        },
      ],
      version: 1,
    });
    expect(withoutAgent).toBe(false);

    const withAgent = isSecretsApplyPlan({
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      protocolVersion: 1,
      targets: [
        {
          agentId: "main",
          path: "profiles.openai:default.key",
          pathSegments: ["profiles", "openai:default", "key"],
          ref: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
          type: "auth-profiles.api_key.key",
        },
      ],
      version: 1,
    });
    expect(withAgent).toBe(true);
  });

  it("accepts valid exec secret ref ids in plans", () => {
    for (const id of VALID_EXEC_SECRET_REF_IDS) {
      const isValid = isSecretsApplyPlan({
        generatedAt: "2026-03-10T00:00:00.000Z",
        generatedBy: "manual",
        protocolVersion: 1,
        targets: [
          {
            path: TALK_TEST_PROVIDER_API_KEY_PATH,
            pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
            providerId: TALK_TEST_PROVIDER_ID,
            ref: { id, provider: "vault", source: "exec" },
            type: "talk.providers.*.apiKey",
          },
        ],
        version: 1,
      });
      expect(isValid, `expected valid plan exec ref id: ${id}`).toBe(true);
    }
  });

  it("rejects invalid exec secret ref ids in plans", () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      const isValid = isSecretsApplyPlan({
        generatedAt: "2026-03-10T00:00:00.000Z",
        generatedBy: "manual",
        protocolVersion: 1,
        targets: [
          {
            path: TALK_TEST_PROVIDER_API_KEY_PATH,
            pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
            providerId: TALK_TEST_PROVIDER_ID,
            ref: { id, provider: "vault", source: "exec" },
            type: "talk.providers.*.apiKey",
          },
        ],
        version: 1,
      });
      expect(isValid, `expected invalid plan exec ref id: ${id}`).toBe(false);
    }
  });
});
