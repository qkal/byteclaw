import { describe, expect, it, vi } from "vitest";
import { resolveSlackChannelAllowlist } from "./resolve-channels.js";

describe("resolveSlackChannelAllowlist", () => {
  it("resolves by name and prefers active channels", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [
            { id: "C1", is_archived: true, name: "general" },
            { id: "C2", is_archived: false, name: "general" },
          ],
        }),
      },
    };

    const res = await resolveSlackChannelAllowlist({
      client: client as never,
      entries: ["#general"],
      token: "xoxb-test",
    });

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.id).toBe("C2");
  });

  it("keeps unresolved entries", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({ channels: [] }),
      },
    };

    const res = await resolveSlackChannelAllowlist({
      client: client as never,
      entries: ["#does-not-exist"],
      token: "xoxb-test",
    });

    expect(res[0]?.resolved).toBe(false);
  });
});
