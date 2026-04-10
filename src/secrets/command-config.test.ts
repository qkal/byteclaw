import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
  buildTalkTestProviderConfig,
} from "../test-utils/talk-test-provider.js";
import { collectCommandSecretAssignmentsFromSnapshot } from "./command-config.js";

describe("collectCommandSecretAssignmentsFromSnapshot", () => {
  it("returns assignments from the active runtime snapshot for configured refs", () => {
    const sourceConfig = buildTalkTestProviderConfig({
      id: "TALK_API_KEY",
      provider: "default",
      source: "env",
    });
    const resolvedConfig = buildTalkTestProviderConfig("talk-key"); // Pragma: allowlist secret

    const result = collectCommandSecretAssignmentsFromSnapshot({
      commandName: "memory status",
      resolvedConfig,
      sourceConfig,
      targetIds: new Set(["talk.providers.*.apiKey"]),
    });

    expect(result.assignments).toEqual([
      {
        path: TALK_TEST_PROVIDER_API_KEY_PATH,
        pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
        value: "talk-key",
      },
    ]);
  });

  it("throws when configured refs are unresolved in the snapshot", () => {
    const sourceConfig = buildTalkTestProviderConfig({
      id: "TALK_API_KEY",
      provider: "default",
      source: "env",
    });
    const resolvedConfig = buildTalkTestProviderConfig(undefined);

    expect(() =>
      collectCommandSecretAssignmentsFromSnapshot({
        commandName: "memory search",
        resolvedConfig,
        sourceConfig,
        targetIds: new Set(["talk.providers.*.apiKey"]),
      }),
    ).toThrow(new RegExp(`memory search: ${TALK_TEST_PROVIDER_API_KEY_PATH} is unresolved`));
  });

  it("skips unresolved refs that are marked inactive by runtime warnings", () => {
    const sourceConfig = {
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              apiKey: { id: "DEFAULT_MEMORY_KEY", provider: "default", source: "env" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig = {
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              apiKey: { id: "DEFAULT_MEMORY_KEY", provider: "default", source: "env" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = collectCommandSecretAssignmentsFromSnapshot({
      commandName: "memory search",
      inactiveRefPaths: new Set(["agents.defaults.memorySearch.remote.apiKey"]),
      resolvedConfig,
      sourceConfig,
      targetIds: new Set(["agents.defaults.memorySearch.remote.apiKey"]),
    });

    expect(result.assignments).toEqual([]);
    expect(result.diagnostics).toEqual([
      "agents.defaults.memorySearch.remote.apiKey: secret ref is configured on an inactive surface; skipping command-time assignment.",
    ]);
  });
});
