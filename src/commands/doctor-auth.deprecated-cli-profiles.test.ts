import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { captureEnv } from "../test-utils/env.js";
import { maybeRepairLegacyOAuthProfileIds } from "./doctor-auth.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import type { DoctorRepairMode } from "./doctor-repair-mode.js";

const resolvePluginProvidersMock = vi.fn<() => ProviderPlugin[]>(() => []);
const isPluginProvidersLoadInFlightMock = vi.fn(() => false);

vi.mock("../plugins/providers.runtime.js", () => ({
  isPluginProvidersLoadInFlight: () => isPluginProvidersLoadInFlightMock(),
  resolvePluginProviders: () => resolvePluginProvidersMock(),
}));

let envSnapshot: ReturnType<typeof captureEnv>;
let tempAgentDir: string | undefined;

function makePrompter(confirmValue: boolean): DoctorPrompter {
  const repairMode: DoctorRepairMode = {
    canPrompt: true,
    nonInteractive: false,
    shouldForce: false,
    shouldRepair: confirmValue,
    updateInProgress: false,
  };
  return {
    confirm: vi.fn().mockResolvedValue(confirmValue),
    confirmAggressiveAutoFix: vi.fn().mockResolvedValue(confirmValue),
    confirmAutoFix: vi.fn().mockResolvedValue(confirmValue),
    confirmRuntimeRepair: vi.fn().mockResolvedValue(confirmValue),
    repairMode,
    select: vi.fn().mockResolvedValue(""),
    shouldForce: repairMode.shouldForce,
    shouldRepair: repairMode.shouldRepair,
  };
}

beforeEach(() => {
  envSnapshot = captureEnv(["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"]);
  tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
  process.env.OPENCLAW_AGENT_DIR = tempAgentDir;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  resolvePluginProvidersMock.mockReset();
  resolvePluginProvidersMock.mockReturnValue([]);
  isPluginProvidersLoadInFlightMock.mockReset();
  isPluginProvidersLoadInFlightMock.mockReturnValue(false);
});

afterEach(() => {
  envSnapshot.restore();
  if (tempAgentDir) {
    fs.rmSync(tempAgentDir, { force: true, recursive: true });
    tempAgentDir = undefined;
  }
});

describe("maybeRepairLegacyOAuthProfileIds", () => {
  it("repairs provider-owned legacy OAuth profile ids", async () => {
    if (!tempAgentDir) {
      throw new Error("Missing temp agent dir");
    }
    const authPath = path.join(tempAgentDir, "auth-profiles.json");
    fs.writeFileSync(
      authPath,
      `${JSON.stringify(
        {
          lastGood: {
            anthropic: "anthropic:user@example.com",
          },
          profiles: {
            "anthropic:user@example.com": {
              access: "token-a",
              email: "user@example.com",
              expires: Date.now() + 60_000,
              provider: "anthropic",
              refresh: "token-r",
              type: "oauth",
            },
          },
          version: 1,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    resolvePluginProvidersMock.mockReturnValue([
      {
        auth: [],
        id: "anthropic",
        label: "Anthropic",
        oauthProfileIdRepairs: [{ legacyProfileId: "anthropic:default" }],
      },
    ]);

    const next = await maybeRepairLegacyOAuthProfileIds(
      {
        auth: {
          order: {
            anthropic: ["anthropic:default"],
          },
          profiles: {
            "anthropic:default": { mode: "oauth", provider: "anthropic" },
          },
        },
      } as OpenClawConfig,
      makePrompter(true),
    );

    expect(next.auth?.profiles?.["anthropic:default"]).toBeUndefined();
    expect(next.auth?.profiles?.["anthropic:user@example.com"]).toMatchObject({
      email: "user@example.com",
      mode: "oauth",
      provider: "anthropic",
    });
    expect(next.auth?.order?.anthropic).toEqual(["anthropic:user@example.com"]);
  });
});
