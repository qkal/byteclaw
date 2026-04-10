import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import {
  DEFAULT_COMMAND_SPECS,
  parseSlashCommandPayload,
  registerSlashCommands,
  resolveCallbackUrl,
  resolveCommandText,
  resolveSlashCommandConfig,
} from "./slash-commands.js";

describe("slash-commands", () => {
  async function registerSingleStatusCommand(
    requestImpl: (path: string, init?: { method?: string }) => Promise<unknown>,
  ) {
    const client: MattermostClient = {
      apiBaseUrl: "https://chat.example.com/api/v4",
      baseUrl: "https://chat.example.com",
      fetchImpl: vi.fn<typeof fetch>(),
      request: async <T>(path: string, init?: RequestInit) => (await requestImpl(path, init)) as T,
      token: "bot-token",
    };
    return registerSlashCommands({
      callbackUrl: "http://gateway/callback",
      client,
      commands: [
        {
          autoComplete: true,
          description: "status",
          trigger: "oc_status",
        },
      ],
      creatorUserId: "bot-user",
      teamId: "team-1",
    });
  }

  it("parses application/x-www-form-urlencoded payloads", () => {
    const payload = parseSlashCommandPayload(
      "token=t1&team_id=team&channel_id=ch1&user_id=u1&command=%2Foc_status&text=now",
      "application/x-www-form-urlencoded",
    );
    expect(payload).toMatchObject({
      channel_id: "ch1",
      command: "/oc_status",
      team_id: "team",
      text: "now",
      token: "t1",
      user_id: "u1",
    });
  });

  it("parses application/json payloads", () => {
    const payload = parseSlashCommandPayload(
      JSON.stringify({
        channel_id: "ch2",
        command: "/oc_model",
        team_id: "team",
        text: "gpt-5",
        token: "t2",
        user_id: "u2",
      }),
      "application/json; charset=utf-8",
    );
    expect(payload).toMatchObject({
      command: "/oc_model",
      text: "gpt-5",
      token: "t2",
    });
  });

  it("returns null for malformed payloads missing required fields", () => {
    const payload = parseSlashCommandPayload(
      JSON.stringify({ command: "/oc_help", token: "t3" }),
      "application/json",
    );
    expect(payload).toBeNull();
  });

  it("resolves command text with trigger map fallback", () => {
    const triggerMap = new Map<string, string>([["oc_status", "status"]]);
    expect(resolveCommandText("oc_status", "   ", triggerMap)).toBe("/status");
    expect(resolveCommandText("oc_status", " now ", triggerMap)).toBe("/status now");
    expect(resolveCommandText("oc_models", " openai ", undefined)).toBe("/models openai");
    expect(resolveCommandText("oc_help", "", undefined)).toBe("/help");
  });

  it("registers both public model slash commands", () => {
    expect(
      DEFAULT_COMMAND_SPECS.filter(
        (spec) => spec.trigger === "oc_model" || spec.trigger === "oc_models",
      ).map((spec) => spec.trigger),
    ).toEqual(["oc_model", "oc_models"]);
  });

  it("normalizes callback path in slash config", () => {
    const config = resolveSlashCommandConfig({ callbackPath: "api/channels/mattermost/command" });
    expect(config.callbackPath).toBe("/api/channels/mattermost/command");
  });

  it("falls back to localhost callback URL for wildcard bind hosts", () => {
    const config = resolveSlashCommandConfig({ callbackPath: "/api/channels/mattermost/command" });
    const callbackUrl = resolveCallbackUrl({
      config,
      gatewayHost: "0.0.0.0",
      gatewayPort: 18_789,
    });
    expect(callbackUrl).toBe("http://localhost:18789/api/channels/mattermost/command");
  });

  it("reuses existing command when trigger already points to callback URL", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            auto_complete: true,
            creator_id: "bot-user",
            id: "cmd-1",
            method: "P",
            team_id: "team-1",
            token: "tok-1",
            trigger: "oc_status",
            url: "http://gateway/callback",
          },
        ];
      }
      throw new Error(`unexpected request path: ${path}`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(result).toHaveLength(1);
    expect(result[0]?.managed).toBe(false);
    expect(result[0]?.id).toBe("cmd-1");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("skips foreign command trigger collisions instead of mutating non-owned commands", async () => {
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            auto_complete: true,
            creator_id: "another-bot-user",
            id: "cmd-foreign-1",
            method: "P",
            team_id: "team-1",
            token: "tok-foreign-1",
            trigger: "oc_status",
            url: "http://foreign/callback",
          },
        ];
      }
      if (init?.method === "POST" || init?.method === "PUT" || init?.method === "DELETE") {
        throw new Error("should not mutate foreign commands");
      }
      throw new Error(`unexpected request path: ${path}`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(result).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
