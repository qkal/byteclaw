import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveAgentIdentityMock = vi.hoisted(() => vi.fn());
const resolveAgentAvatarMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/identity.js", () => ({
  resolveAgentIdentity: (...args: unknown[]) => resolveAgentIdentityMock(...args),
}));

vi.mock("../../agents/identity-avatar.js", () => ({
  resolveAgentAvatar: (...args: unknown[]) => resolveAgentAvatarMock(...args),
}));

type IdentityModule = typeof import("./identity.js");

let normalizeOutboundIdentity: IdentityModule["normalizeOutboundIdentity"];
let resolveAgentOutboundIdentity: IdentityModule["resolveAgentOutboundIdentity"];

beforeAll(async () => {
  ({ normalizeOutboundIdentity, resolveAgentOutboundIdentity } = await import("./identity.js"));
});

beforeEach(() => {
  resolveAgentIdentityMock.mockReset();
  resolveAgentAvatarMock.mockReset();
});

describe("normalizeOutboundIdentity", () => {
  it.each([
    {
      expected: {
        avatarUrl: "https://example.com/a.png",
        emoji: "🤖",
        name: "Demo Bot",
        theme: "ocean",
      },
      input: {
        avatarUrl: " https://example.com/a.png ",
        emoji: "  🤖  ",
        name: "  Demo Bot  ",
        theme: "  ocean  ",
      },
    },
    {
      expected: undefined,
      input: {
        avatarUrl: "\n",
        emoji: "",
        name: "  ",
      },
    },
  ])("normalizes outbound identity for %j", ({ input, expected }) => {
    expect(normalizeOutboundIdentity(input)).toEqual(expected);
  });
});

describe("resolveAgentOutboundIdentity", () => {
  it.each([
    {
      avatar: {
        kind: "remote",
        url: "https://example.com/avatar.png",
      },
      expected: {
        avatarUrl: "https://example.com/avatar.png",
        emoji: "🕶️",
        name: "Agent Smith",
        theme: "noir",
      },
      identity: {
        emoji: "  🕶️  ",
        name: "  Agent Smith  ",
        theme: "  noir  ",
      },
    },
    {
      avatar: {
        dataUrl: "data:image/png;base64,abc",
        kind: "data",
      },
      expected: undefined,
      identity: {
        emoji: "",
        name: "   ",
      },
    },
    {
      avatar: {
        kind: "remote",
        url: "   ",
      },
      expected: {
        emoji: "🕶️",
        name: "Agent Smith",
      },
      identity: {
        emoji: "  🕶️  ",
        name: "  Agent Smith  ",
      },
    },
  ])("resolves outbound identity for %j", ({ identity, avatar, expected }) => {
    resolveAgentIdentityMock.mockReturnValueOnce(identity);
    resolveAgentAvatarMock.mockReturnValueOnce(avatar);
    expect(resolveAgentOutboundIdentity({} as never, "main")).toEqual(expected);
  });
});
