import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.js";
import { resolveSecretRefValues } from "../../../src/secrets/resolve.js";
import {
  applyResolvedAssignments,
  createResolverContext,
} from "../../../src/secrets/runtime-shared.js";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

describe("googlechat secret contract", () => {
  it("resolves account serviceAccount SecretRefs for enabled accounts", async () => {
    const sourceConfig = {
      channels: {
        googlechat: {
          accounts: {
            work: {
              enabled: true,
              serviceAccountRef: {
                id: "GOOGLECHAT_SERVICE_ACCOUNT",
                provider: "default",
                source: "env",
              },
            },
          },
          enabled: true,
        },
      },
    } satisfies OpenClawConfig;
    const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      env: {
        GOOGLECHAT_SERVICE_ACCOUNT: '{"client_email":"bot@example.com"}',
      },
      sourceConfig,
    });

    collectRuntimeConfigAssignments({
      config: resolvedConfig,
      context,
      defaults: undefined,
    });

    const resolved = await resolveSecretRefValues(
      context.assignments.map((assignment) => assignment.ref),
      {
        cache: context.cache,
        config: sourceConfig,
        env: context.env,
      },
    );
    applyResolvedAssignments({
      assignments: context.assignments,
      resolved,
    });

    const workAccount = resolvedConfig.channels?.googlechat?.accounts?.work;
    expect(workAccount?.serviceAccount).toBe('{"client_email":"bot@example.com"}');
    expect(context.warnings).toEqual([]);
  });
});
