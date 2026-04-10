import type { GatewayPlugin } from "@buape/carbon/gateway";
import type { DiscordActionConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearGateways, registerGateway } from "../monitor/gateway-registry.js";
import type { ActionGate } from "../runtime-api.js";
import { handleDiscordPresenceAction } from "./runtime.presence.js";

const mockUpdatePresence = vi.fn();

function createMockGateway(connected = true): GatewayPlugin {
  return { isConnected: connected, updatePresence: mockUpdatePresence } as unknown as GatewayPlugin;
}

const presenceEnabled: ActionGate<DiscordActionConfig> = (key) => key === "presence";
const presenceDisabled: ActionGate<DiscordActionConfig> = () => false;

describe("handleDiscordPresenceAction", () => {
  async function setPresence(
    params: Record<string, unknown>,
    actionGate: ActionGate<DiscordActionConfig> = presenceEnabled,
  ) {
    return await handleDiscordPresenceAction("setPresence", params, actionGate);
  }

  beforeEach(() => {
    mockUpdatePresence.mockClear();
    clearGateways();
    registerGateway(undefined, createMockGateway());
  });

  it("sets playing activity", async () => {
    const result = await handleDiscordPresenceAction(
      "setPresence",
      { activityName: "with fire", activityType: "playing", status: "online" },
      presenceEnabled,
    );
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      activities: [{ name: "with fire", type: 0 }],
      afk: false,
      since: null,
      status: "online",
    });
    const textBlock = result.content.find((block) => block.type === "text");
    const payload = JSON.parse(
      (textBlock as { type: "text"; text: string } | undefined)?.text ?? "{}",
    );
    expect(payload.ok).toBe(true);
    expect(payload.activities[0]).toEqual({ name: "with fire", type: 0 });
  });

  it.each([
    {
      expectedActivities: [{ name: "My Stream", type: 1, url: "https://twitch.tv/example" }],
      name: "streaming activity with URL",
      params: {
        activityName: "My Stream",
        activityType: "streaming",
        activityUrl: "https://twitch.tv/example",
      },
    },
    {
      expectedActivities: [{ name: "My Stream", type: 1 }],
      name: "streaming activity without URL",
      params: { activityName: "My Stream", activityType: "streaming" },
    },
    {
      expectedActivities: [{ name: "Spotify", type: 2 }],
      name: "listening activity",
      params: { activityName: "Spotify", activityType: "listening" },
    },
    {
      expectedActivities: [{ name: "you", type: 3 }],
      name: "watching activity",
      params: { activityName: "you", activityType: "watching" },
    },
    {
      expectedActivities: [{ name: "", state: "Vibing", type: 4 }],
      name: "custom activity using state",
      params: { activityState: "Vibing", activityType: "custom" },
    },
    {
      expectedActivities: [{ name: "My Game", state: "In the lobby", type: 0 }],
      name: "activity with state",
      params: { activityName: "My Game", activityState: "In the lobby", activityType: "playing" },
    },
    {
      expectedActivities: [{ name: "", type: 0 }],
      name: "default empty activity name when only type provided",
      params: { activityType: "playing" },
    },
  ])("sets $name", async ({ params, expectedActivities }) => {
    await setPresence(params);
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      activities: expectedActivities,
      afk: false,
      since: null,
      status: "online",
    });
  });

  it("sets status-only without activity", async () => {
    await setPresence({ status: "idle" });
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      activities: [],
      afk: false,
      since: null,
      status: "idle",
    });
  });

  it.each([
    { expectedMessage: /Invalid status/, name: "invalid status", params: { status: "offline" } },
    {
      expectedMessage: /Invalid activityType/,
      name: "invalid activity type",
      params: { activityType: "invalid" },
    },
  ])("rejects $name", async ({ params, expectedMessage }) => {
    await expect(setPresence(params)).rejects.toThrow(expectedMessage);
  });

  it("defaults status to online", async () => {
    await setPresence({ activityName: "test", activityType: "playing" });
    expect(mockUpdatePresence).toHaveBeenCalledWith(expect.objectContaining({ status: "online" }));
  });

  it("respects presence gating", async () => {
    await expect(setPresence({ status: "online" }, presenceDisabled)).rejects.toThrow(/disabled/);
  });

  it("errors when gateway is not registered", async () => {
    clearGateways();
    await expect(setPresence({ status: "dnd" })).rejects.toThrow(/not available/);
  });

  it("errors when gateway is not connected", async () => {
    clearGateways();
    registerGateway(undefined, createMockGateway(false));
    await expect(setPresence({ status: "dnd" })).rejects.toThrow(/not connected/);
  });

  it("uses accountId to resolve gateway", async () => {
    const accountGateway = createMockGateway();
    registerGateway("my-account", accountGateway);
    await setPresence({ accountId: "my-account", activityName: "test", activityType: "playing" });
    expect(mockUpdatePresence).toHaveBeenCalled();
  });

  it("requires activityType when activityName is provided", async () => {
    await expect(setPresence({ activityName: "My Game" })).rejects.toThrow(
      /activityType is required/,
    );
  });

  it("rejects unknown presence actions", async () => {
    await expect(handleDiscordPresenceAction("unknownAction", {}, presenceEnabled)).rejects.toThrow(
      /Unknown presence action/,
    );
  });
});
