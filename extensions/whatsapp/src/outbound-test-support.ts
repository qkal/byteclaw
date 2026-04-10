import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { MockInstance } from "vitest";

export function createWhatsAppPollFixture() {
  const cfg = { marker: "resolved-cfg" } as OpenClawConfig;
  const poll = {
    maxSelections: 1,
    options: ["Pizza", "Sushi"],
    question: "Lunch?",
  };
  return {
    accountId: "work",
    cfg,
    poll,
    to: "+1555",
  };
}

export function expectWhatsAppPollSent(
  sendPollWhatsApp: MockInstance,
  params: {
    cfg: OpenClawConfig;
    poll: { question: string; options: string[]; maxSelections: number };
    to?: string;
    accountId?: string;
  },
) {
  const expected = [
    params.to ?? "+1555",
    params.poll,
    {
      accountId: params.accountId ?? "work",
      cfg: params.cfg,
      verbose: false,
    },
  ];
  const actual = sendPollWhatsApp.mock.calls.at(-1);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected WhatsApp poll send ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
