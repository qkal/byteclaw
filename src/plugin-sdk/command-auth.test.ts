import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
  resolveSenderCommandAuthorization,
} from "./command-auth.js";

const baseCfg = {
  commands: { useAccessGroups: true },
} as unknown as OpenClawConfig;

async function resolveAuthorization(params: {
  senderId: string;
  configuredAllowFrom?: string[];
  configuredGroupAllowFrom?: string[];
}) {
  return resolveSenderCommandAuthorization({
    cfg: baseCfg,
    configuredAllowFrom: params.configuredAllowFrom ?? ["dm-owner"],
    configuredGroupAllowFrom: params.configuredGroupAllowFrom ?? ["group-owner"],
    dmPolicy: "pairing",
    isGroup: true,
    isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
    rawBody: "/status",
    readAllowFromStore: async () => ["paired-user"],
    resolveCommandAuthorizedFromAuthorizers: ({ useAccessGroups, authorizers }) =>
      useAccessGroups && authorizers.some((entry) => entry.configured && entry.allowed),
    senderId: params.senderId,
    shouldComputeCommandAuthorized: () => true,
  });
}

describe("plugin-sdk/command-auth", () => {
  it("keeps deprecated command status builders available for compatibility", () => {
    const cfg = { commands: { config: false, debug: false } } as unknown as OpenClawConfig;

    expect(buildHelpMessage(cfg)).toContain("/commands for full list");
    expect(buildCommandsMessage(cfg)).toContain("More: /tools for available capabilities");
    expect(buildCommandsMessagePaginated(cfg)).toMatchObject({
      currentPage: 1,
      totalPages: expect.any(Number),
    });
  });

  it("resolves command authorization across allowlist sources", async () => {
    const cases = [
      {
        expectedAuthorized: true,
        expectedSenderAllowed: true,
        name: "authorizes group commands from explicit group allowlist",
        senderId: "group-owner",
      },
      {
        expectedAuthorized: false,
        expectedSenderAllowed: false,
        name: "keeps pairing-store identities DM-only for group command auth",
        senderId: "paired-user",
      },
    ];

    for (const testCase of cases) {
      const result = await resolveAuthorization({ senderId: testCase.senderId });
      expect(result.commandAuthorized).toBe(testCase.expectedAuthorized);
      expect(result.senderAllowedForCommands).toBe(testCase.expectedSenderAllowed);
      expect(result.effectiveAllowFrom).toEqual(["dm-owner"]);
      expect(result.effectiveGroupAllowFrom).toEqual(["group-owner"]);
    }
  });
});
