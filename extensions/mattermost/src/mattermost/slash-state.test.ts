import { describe, expect, it } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import {
  activateSlashCommands,
  deactivateSlashCommands,
  resolveSlashHandlerForToken,
} from "./slash-state.js";

function createResolvedMattermostAccount(accountId: string): ResolvedMattermostAccount {
  return {
    accountId,
    baseUrlSource: "config",
    botTokenSource: "config",
    config: {},
    enabled: true,
  };
}

const slashApi = {
  cfg: {},
  runtime: {
    error: () => {},
    exit: () => {},
    log: () => {},
  },
} satisfies {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
};

describe("slash-state token routing", () => {
  it("returns single match when token belongs to one account", () => {
    deactivateSlashCommands();
    activateSlashCommands({
      account: createResolvedMattermostAccount("a1"),
      api: slashApi,
      commandTokens: ["tok-a"],
      registeredCommands: [],
    });

    const match = resolveSlashHandlerForToken("tok-a");
    expect(match.kind).toBe("single");
    expect(match.accountIds).toEqual(["a1"]);
  });

  it("returns ambiguous when same token exists in multiple accounts", () => {
    deactivateSlashCommands();
    activateSlashCommands({
      account: createResolvedMattermostAccount("a1"),
      api: slashApi,
      commandTokens: ["tok-shared"],
      registeredCommands: [],
    });
    activateSlashCommands({
      account: createResolvedMattermostAccount("a2"),
      api: slashApi,
      commandTokens: ["tok-shared"],
      registeredCommands: [],
    });

    const match = resolveSlashHandlerForToken("tok-shared");
    expect(match.kind).toBe("ambiguous");
    expect(match.accountIds?.toSorted()).toEqual(["a1", "a2"]);
  });
});
