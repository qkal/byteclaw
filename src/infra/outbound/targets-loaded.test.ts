import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { tryResolveLoadedOutboundTarget } from "./targets-loaded.js";

const mocks = vi.hoisted(() => ({
  getLoadedChannelPlugin: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: mocks.getLoadedChannelPlugin,
}));

describe("tryResolveLoadedOutboundTarget", () => {
  beforeEach(() => {
    mocks.getLoadedChannelPlugin.mockReset();
  });

  it("returns undefined when no loaded plugin exists", () => {
    mocks.getLoadedChannelPlugin.mockReturnValue(undefined);

    expect(tryResolveLoadedOutboundTarget({ channel: "telegram", to: "123" })).toBeUndefined();
  });

  it("uses loaded plugin config defaultTo fallback", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { defaultTo: "123456789" } },
    };
    mocks.getLoadedChannelPlugin.mockReturnValue({
      capabilities: {},
      config: {
        resolveDefaultTo: ({ cfg }: { cfg: OpenClawConfig }) => cfg.channels?.telegram?.defaultTo,
      },
      id: "telegram",
      messaging: {},
      meta: { label: "Telegram" },
      outbound: {},
    });

    expect(
      tryResolveLoadedOutboundTarget({
        cfg,
        channel: "telegram",
        mode: "implicit",
        to: "",
      }),
    ).toEqual({ ok: true, to: "123456789" });
  });
});
