import { describe, expect, it, vi } from "vitest";
import { resolveSlackUserAllowlist } from "./resolve-users.js";

describe("resolveSlackUserAllowlist", () => {
  it("resolves by email and prefers active human users", async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue({
          members: [
            {
              deleted: false,
              id: "U1",
              is_bot: true,
              name: "bot-user",
              profile: { email: "person@example.com" },
            },
            {
              deleted: false,
              id: "U2",
              is_bot: false,
              name: "person",
              profile: { display_name: "Person", email: "person@example.com" },
            },
          ],
        }),
      },
    };

    const res = await resolveSlackUserAllowlist({
      client: client as never,
      entries: ["person@example.com"],
      token: "xoxb-test",
    });

    expect(res[0]).toMatchObject({
      email: "person@example.com",
      id: "U2",
      isBot: false,
      name: "Person",
      resolved: true,
    });
  });

  it("keeps unresolved users", async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue({ members: [] }),
      },
    };

    const res = await resolveSlackUserAllowlist({
      client: client as never,
      entries: ["@missing-user"],
      token: "xoxb-test",
    });

    expect(res[0]).toEqual({ input: "@missing-user", resolved: false });
  });
});
