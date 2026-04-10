import { describe, expect, it } from "vitest";
import {
  resolveIMessageConfigAllowFrom,
  resolveIMessageConfigDefaultTo,
} from "./config-accessors.js";

describe("imessage config accessors", () => {
  it("reads merged allowFrom/defaultTo from resolved account config", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            alt: {
              allowFrom: ["chat_id:9", "user@example.com"],
              defaultTo: " alt:chat ",
            },
          },
          allowFrom: ["root"],
          defaultTo: " root:chat ",
        },
      },
    };

    expect(resolveIMessageConfigAllowFrom({ accountId: "alt", cfg })).toEqual([
      "chat_id:9",
      "user@example.com",
    ]);
    expect(resolveIMessageConfigDefaultTo({ accountId: "alt", cfg })).toBe("alt:chat");
  });
});
