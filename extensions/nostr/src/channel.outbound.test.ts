import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartAccountContext } from "../../../test/helpers/plugins/start-account-context.js";
import type { PluginRuntime } from "../runtime-api.js";
import { nostrOutboundAdapter, startNostrGatewayAccount } from "./gateway.js";
import { setNostrRuntime } from "./runtime.js";
import { TEST_RESOLVED_PRIVATE_KEY, buildResolvedNostrAccount } from "./test-fixtures.js";

const mocks = vi.hoisted(() => ({
  normalizePubkey: vi.fn((value: string) => `normalized-${value.toLowerCase()}`),
  startNostrBus: vi.fn(),
}));

vi.mock("./nostr-bus.js", () => ({
  DEFAULT_RELAYS: ["wss://relay.example.com"],
  getPublicKeyFromPrivate: vi.fn(() => "pubkey"),
  normalizePubkey: mocks.normalizePubkey,
  startNostrBus: mocks.startNostrBus,
}));

function createCfg() {
  return {
    channels: {
      nostr: {
        privateKey: TEST_RESOLVED_PRIVATE_KEY, // Pragma: allowlist secret
      },
    },
  };
}

function installOutboundRuntime(convertMarkdownTables = vi.fn((text: string) => text)) {
  const resolveMarkdownTableMode = vi.fn(() => "off");
  setNostrRuntime({
    channel: {
      text: {
        convertMarkdownTables,
        resolveMarkdownTableMode,
      },
    },
    reply: {},
  } as unknown as PluginRuntime);
  return { convertMarkdownTables, resolveMarkdownTableMode };
}

async function startOutboundAccount(accountId?: string) {
  const sendDm = vi.fn(async () => {});
  const bus = {
    close: vi.fn(),
    getMetrics: vi.fn(() => ({ counters: {} })),
    getProfileState: vi.fn(async () => null),
    publishProfile: vi.fn(),
    sendDm,
  };
  mocks.startNostrBus.mockResolvedValueOnce(bus as unknown);

  const cleanup = (await startNostrGatewayAccount(
    createStartAccountContext({
      account: buildResolvedNostrAccount(accountId ? { accountId } : undefined),
    }),
  )) as { stop: () => void };

  return { cleanup, sendDm };
}

describe("nostr outbound cfg threading", () => {
  afterEach(() => {
    mocks.normalizePubkey.mockClear();
    mocks.startNostrBus.mockReset();
  });

  it("uses resolved cfg when converting markdown tables before send", async () => {
    const { resolveMarkdownTableMode, convertMarkdownTables } = installOutboundRuntime(
      vi.fn((text: string) => `converted:${text}`),
    );
    const { cleanup, sendDm } = await startOutboundAccount();

    const cfg = createCfg();
    await nostrOutboundAdapter.sendText({
      accountId: "default",
      cfg: cfg as OpenClawConfig,
      text: "|a|b|",
      to: "NPUB123",
    });

    expect(resolveMarkdownTableMode).toHaveBeenCalledWith({
      accountId: "default",
      cfg,
      channel: "nostr",
    });
    expect(convertMarkdownTables).toHaveBeenCalledWith("|a|b|", "off");
    expect(mocks.normalizePubkey).toHaveBeenCalledWith("NPUB123");
    expect(sendDm).toHaveBeenCalledWith("normalized-npub123", "converted:|a|b|");

    cleanup.stop();
  });

  it("uses the configured defaultAccount when accountId is omitted", async () => {
    const { resolveMarkdownTableMode } = installOutboundRuntime();
    const { cleanup, sendDm } = await startOutboundAccount("work");

    const cfg = {
      channels: {
        nostr: {
          privateKey: TEST_RESOLVED_PRIVATE_KEY, // Pragma: allowlist secret
          defaultAccount: "work",
        },
      },
    };

    await nostrOutboundAdapter.sendText({
      cfg: cfg as OpenClawConfig,
      text: "hello",
      to: "NPUB123",
    });

    expect(resolveMarkdownTableMode).toHaveBeenCalledWith({
      accountId: "work",
      cfg,
      channel: "nostr",
    });
    expect(sendDm).toHaveBeenCalledWith("normalized-npub123", "hello");

    cleanup.stop();
  });
});
