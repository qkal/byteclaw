import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";

const probeBlueBubblesMock = vi.hoisted(() => vi.fn());
const cfg: OpenClawConfig = {};

vi.mock("./channel.runtime.js", () => ({
  blueBubblesChannelRuntime: {
    probeBlueBubbles: probeBlueBubblesMock,
  },
}));

vi.mock("../../../src/channels/plugins/bundled.js", () => ({
  bundledChannelPlugins: [],
  bundledChannelSetupPlugins: [],
}));

let bluebubblesPlugin: typeof import("./channel.js").bluebubblesPlugin;

describe("bluebubblesPlugin.status.probeAccount", () => {
  beforeAll(async () => {
    ({ bluebubblesPlugin } = await import("./channel.js"));
  });

  beforeEach(() => {
    probeBlueBubblesMock.mockReset();
    probeBlueBubblesMock.mockResolvedValue({ ok: true, status: 200 });
  });

  it("auto-enables private-network probes for loopback server URLs", async () => {
    await bluebubblesPlugin.status?.probeAccount?.({
      account: {
        accountId: "default",
        baseUrl: "http://localhost:1234",
        config: {
          password: "test-password",
          serverUrl: "http://localhost:1234",
        },
        configured: true,
        enabled: true,
      },
      cfg,
      timeoutMs: 5000,
    });

    expect(probeBlueBubblesMock).toHaveBeenCalledWith({
      allowPrivateNetwork: true,
      baseUrl: "http://localhost:1234",
      password: "test-password",
      timeoutMs: 5000,
    });
  });

  it("respects an explicit private-network opt-out for loopback server URLs", async () => {
    await bluebubblesPlugin.status?.probeAccount?.({
      account: {
        accountId: "default",
        baseUrl: "http://localhost:1234",
        config: {
          network: {
            dangerouslyAllowPrivateNetwork: false,
          },
          password: "test-password",
          serverUrl: "http://localhost:1234",
        },
        configured: true,
        enabled: true,
      },
      cfg,
      timeoutMs: 5000,
    });

    expect(probeBlueBubblesMock).toHaveBeenCalledWith({
      allowPrivateNetwork: false,
      baseUrl: "http://localhost:1234",
      password: "test-password",
      timeoutMs: 5000,
    });
  });
});
