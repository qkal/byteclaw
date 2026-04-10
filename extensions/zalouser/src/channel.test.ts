import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import "./zalo-js.test-mocks.js";
import {
  zalouserAuthAdapter,
  zalouserGroupsAdapter,
  zalouserMessageActions,
  zalouserOutboundAdapter,
  zalouserPairingTextAdapter,
  zalouserResolverAdapter,
  zalouserSecurityAdapter,
} from "./channel.adapters.js";
import { setZalouserRuntime } from "./runtime.js";
import { sendMessageZalouser, sendReactionZalouser } from "./send.js";
import {
  listZaloFriendsMatchingMock,
  startZaloQrLoginMock,
  waitForZaloQrLoginMock,
} from "./zalo-js.test-mocks.js";

vi.mock("./qr-temp-file.js", () => ({
  writeQrDataUrlToTempFile: vi.fn(async () => null),
}));

vi.mock("./send.js", async () => {
  const actual = (await vi.importActual("./send.js")) as Record<string, unknown>;
  return {
    ...actual,
    sendMessageZalouser: vi.fn(async () => ({ messageId: "mid-1", ok: true })),
    sendReactionZalouser: vi.fn(async () => ({ ok: true })),
  };
});

const mockSendMessage = vi.mocked(sendMessageZalouser);
const mockSendReaction = vi.mocked(sendReactionZalouser);

function requireZalouserSendText() {
  const { sendText } = zalouserOutboundAdapter;
  if (!sendText) {
    throw new Error("zalouser outbound.sendText unavailable");
  }
  return sendText;
}

function getResolveToolPolicy() {
  const { resolveToolPolicy } = zalouserGroupsAdapter;
  if (!resolveToolPolicy) {
    throw new Error("resolveToolPolicy unavailable");
  }
  return resolveToolPolicy;
}

function requireZalouserResolveRequireMention() {
  const { resolveRequireMention } = zalouserGroupsAdapter;
  if (!resolveRequireMention) {
    throw new Error("resolveRequireMention unavailable");
  }
  return resolveRequireMention;
}

function requireZalouserPairingNormalizer() {
  const { normalizeAllowEntry } = zalouserPairingTextAdapter;
  if (!normalizeAllowEntry) {
    throw new Error("pairing.normalizeAllowEntry unavailable");
  }
  return normalizeAllowEntry;
}

function resolveGroupToolPolicy(
  groups: Record<string, { tools: { allow?: string[]; deny?: string[] } }>,
  groupId: string,
) {
  return getResolveToolPolicy()({
    accountId: "default",
    cfg: {
      channels: {
        zalouser: {
          groups,
        },
      },
    },
    groupChannel: groupId,
    groupId,
  });
}

describe("zalouser outbound", () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    setZalouserRuntime({
      channel: {
        text: {
          resolveChunkMode: vi.fn(() => "newline"),
          resolveTextChunkLimit: vi.fn(() => 10),
        },
      },
    } as never);
  });

  it("passes markdown chunk settings through sendText", async () => {
    const sendText = requireZalouserSendText();

    const result = await sendText({
      accountId: "default",
      cfg: { channels: { zalouser: { enabled: true } } } as never,
      text: "hello world\nthis is a test",
      to: "group:123456",
    } as never);

    expect(mockSendMessage).toHaveBeenCalledWith(
      "123456",
      "hello world\nthis is a test",
      expect.objectContaining({
        isGroup: true,
        profile: "default",
        textChunkLimit: 10,
        textChunkMode: "newline",
        textMode: "markdown",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        channel: "zalouser",
        messageId: "mid-1",
        ok: true,
      }),
    );
  });
});

describe("zalouser outbound chunking", () => {
  it("chunks outbound text without requiring Zalouser runtime initialization", () => {
    const { chunker } = zalouserOutboundAdapter;
    if (!chunker) {
      throw new Error("zalouser outbound.chunker unavailable");
    }

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });
});

describe("zalouser channel policies", () => {
  beforeEach(() => {
    mockSendReaction.mockClear();
    mockSendReaction.mockResolvedValue({ ok: true });
  });

  it("normalizes dm allowlist entries after trimming channel prefixes", () => {
    const { resolveDmPolicy } = zalouserSecurityAdapter;
    if (!resolveDmPolicy) {
      throw new Error("resolveDmPolicy unavailable");
    }

    const cfg = {
      channels: {
        zalouser: {
          allowFrom: ["  zlu:123456  "],
          dmPolicy: "allowlist",
        },
      },
    } as never;
    const account = {
      accountId: "default",
      authenticated: false,
      config: {
        allowFrom: ["  zlu:123456  "],
        dmPolicy: "allowlist",
      },
      enabled: true,
      profile: "default",
    } as never;

    const result = resolveDmPolicy({ account, cfg });
    if (!result) {
      throw new Error("zalouser resolveDmPolicy returned null");
    }

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  zlu:123456  "]);
    expect(result.normalizeEntry?.("  zlu:123456  ")).toBe("123456");
  });

  it("normalizes pairing allowlist entries after trimming channel prefixes", () => {
    const normalizeAllowEntry = requireZalouserPairingNormalizer();

    expect(normalizeAllowEntry("  zlu:123456  ")).toBe("123456");
    expect(normalizeAllowEntry("  zalouser:654321  ")).toBe("654321");
  });

  it("resolves requireMention from group config", () => {
    const resolveRequireMention = requireZalouserResolveRequireMention();
    const requireMention = resolveRequireMention({
      accountId: "default",
      cfg: {
        channels: {
          zalouser: {
            groups: {
              "123": { requireMention: false },
            },
          },
        },
      },
      groupChannel: "123",
      groupId: "123",
    });
    expect(requireMention).toBe(false);
  });

  it("resolves group tool policy by explicit group id", () => {
    const policy = resolveGroupToolPolicy({ "123": { tools: { allow: ["search"] } } }, "123");
    expect(policy).toEqual({ allow: ["search"] });
  });

  it("falls back to wildcard group policy", () => {
    const policy = resolveGroupToolPolicy({ "*": { tools: { deny: ["system.run"] } } }, "missing");
    expect(policy).toEqual({ deny: ["system.run"] });
  });

  it("handles react action", async () => {
    const actions = zalouserMessageActions;
    expect(
      actions?.describeMessageTool?.({ cfg: { channels: { zalouser: { enabled: true } } } })
        ?.actions,
    ).toEqual(["react"]);
    const result = await actions?.handleAction?.({
      action: "react",
      cfg: {
        channels: {
          zalouser: {
            enabled: true,
            profile: "default",
          },
        },
      },
      channel: "zalouser",
      params: {
        cliMsgId: "222",
        emoji: "👍",
        messageId: "111",
        threadId: "123456",
      },
    });
    expect(mockSendReaction).toHaveBeenCalledWith({
      cliMsgId: "222",
      emoji: "👍",
      isGroup: false,
      msgId: "111",
      profile: "default",
      remove: false,
      threadId: "123456",
    });
    expect(result).toMatchObject({
      content: [{ text: "Reacted 👍 on 111", type: "text" }],
      details: {
        cliMsgId: "222",
        messageId: "111",
        threadId: "123456",
      },
    });
  });

  it("honors the selected Zalouser account during discovery", () => {
    const actions = zalouserMessageActions;
    const cfg = {
      channels: {
        zalouser: {
          accounts: {
            default: {
              enabled: false,
              profile: "default",
            },
            work: {
              enabled: true,
              profile: "work",
            },
          },
          enabled: true,
          profile: "default",
        },
      },
    };

    expect(actions?.describeMessageTool?.({ accountId: "default", cfg })).toBeNull();
    expect(actions?.describeMessageTool?.({ accountId: "work", cfg })?.actions).toEqual(["react"]);
  });
});

describe("zalouser account resolution", () => {
  beforeEach(() => {
    listZaloFriendsMatchingMock.mockReset();
    startZaloQrLoginMock.mockReset();
    waitForZaloQrLoginMock.mockReset();
  });

  it("uses the configured default account for omitted target lookup", async () => {
    const { resolveTargets } = zalouserResolverAdapter;
    if (!resolveTargets) {
      throw new Error("zalouser resolver.resolveTargets unavailable");
    }

    listZaloFriendsMatchingMock.mockResolvedValue([
      { displayName: "Work User", userId: "42" } as never,
    ]);

    const result = await resolveTargets({
      cfg: {
        channels: {
          zalouser: {
            accounts: {
              work: {
                profile: "work-profile",
              },
            },
            defaultAccount: "work",
          },
        },
      } as never,
      inputs: ["Work User"],
      kind: "user",
      runtime: createNonExitingRuntimeEnv(),
    });

    expect(listZaloFriendsMatchingMock).toHaveBeenCalledWith("work-profile", "Work User");
    expect(result).toEqual([
      expect.objectContaining({
        id: "42",
        input: "Work User",
        name: "Work User",
        resolved: true,
      }),
    ]);
  });

  it("uses the configured default account for omitted qr login", async () => {
    const { login } = zalouserAuthAdapter;
    if (!login) {
      throw new Error("zalouser auth.login unavailable");
    }

    startZaloQrLoginMock.mockResolvedValue({
      message: "qr ready",
      qrDataUrl: "data:image/png;base64,abc",
    } as never);
    waitForZaloQrLoginMock.mockResolvedValue({
      connected: true,
      displayName: "Work User",
      userId: "u-1",
    } as never);

    const runtime = createNonExitingRuntimeEnv();

    await login({
      cfg: {
        channels: {
          zalouser: {
            accounts: {
              work: {
                profile: "work-profile",
              },
            },
            defaultAccount: "work",
          },
        },
      } as never,
      runtime,
    });

    expect(startZaloQrLoginMock).toHaveBeenCalledWith({
      profile: "work-profile",
      timeoutMs: 35_000,
    });
    expect(waitForZaloQrLoginMock).toHaveBeenCalledWith({
      profile: "work-profile",
      timeoutMs: 180_000,
    });
  });
});
