import { describe, expect, it } from "vitest";
import {
  formatWhatsAppConfigAllowFromEntries,
  resolveWhatsAppConfigAllowFrom,
  resolveWhatsAppConfigDefaultTo,
} from "./config-accessors.js";

describe("whatsapp config accessors", () => {
  it("reads merged allowFrom/defaultTo from resolved account config", () => {
    const cfg = {
      channels: {
        whatsapp: {
          accounts: {
            alt: {
              allowFrom: ["+49222", "+49333"],
              defaultTo: " alt:chat ",
            },
          },
          allowFrom: ["+49111"],
          defaultTo: " root:chat ",
        },
      },
    };

    expect(resolveWhatsAppConfigAllowFrom({ accountId: "alt", cfg })).toEqual(["+49222", "+49333"]);
    expect(resolveWhatsAppConfigDefaultTo({ accountId: "alt", cfg })).toBe("alt:chat");
  });

  it("normalizes allowFrom entries like the channel plugin", () => {
    expect(
      formatWhatsAppConfigAllowFromEntries([" whatsapp:+49123 ", "*", "49124@s.whatsapp.net"]),
    ).toEqual(["+49123", "*", "+49124"]);
  });
});
