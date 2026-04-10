import { describe, expect, it, vi } from "vitest";
import { createOutboundSendDepsFromCliSource } from "./outbound-send-mapping.js";

describe("createOutboundSendDepsFromCliSource", () => {
  it("adds generic legacy aliases for channel-keyed send deps", () => {
    const deps = {
      discord: vi.fn(),
      imessage: vi.fn(),
      signal: vi.fn(),
      slack: vi.fn(),
      telegram: vi.fn(),
      whatsapp: vi.fn(),
    };

    const outbound = createOutboundSendDepsFromCliSource(deps);

    expect(outbound).toEqual({
      discord: deps.discord,
      imessage: deps.imessage,
      sendDiscord: deps.discord,
      sendImessage: deps.imessage,
      sendSignal: deps.signal,
      sendSlack: deps.slack,
      sendTelegram: deps.telegram,
      sendWhatsapp: deps.whatsapp,
      signal: deps.signal,
      slack: deps.slack,
      telegram: deps.telegram,
      whatsapp: deps.whatsapp,
    });
  });
});
