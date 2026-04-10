import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const pluginRegistry = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => pluginRegistry.list,
}));

import { resolveLinkChannelContext } from "./status.link-channel.js";

describe("resolveLinkChannelContext", () => {
  it("returns linked context from read-only inspected account state", async () => {
    const account = { configured: true, enabled: true };
    pluginRegistry.list = [
      {
        config: {
          inspectAccount: () => account,
          listAccountIds: () => ["default"],
          resolveAccount: () => {
            throw new Error("should not be called in read-only mode");
          },
        },
        id: "discord",
        meta: { label: "Discord" },
        status: {
          buildChannelSummary: () => ({ authAgeMs: 1234, linked: true }),
        },
      },
    ];

    const result = await resolveLinkChannelContext({} as OpenClawConfig);
    expect(result?.linked).toBe(true);
    expect(result?.authAgeMs).toBe(1234);
    expect(result?.account).toBe(account);
  });

  it("degrades safely when account resolution throws", async () => {
    pluginRegistry.list = [
      {
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => {
            throw new Error("missing secret");
          },
        },
        id: "discord",
        meta: { label: "Discord" },
      },
    ];

    const result = await resolveLinkChannelContext({} as OpenClawConfig);
    expect(result).toBeNull();
  });
});
