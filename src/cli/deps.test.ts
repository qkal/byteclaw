import { beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";
import type { ChannelPlugin } from "../channels/plugins/types.js";

const runtimeFactories = vi.hoisted(() => ({
  discord: vi.fn(),
  imessage: vi.fn(),
  signal: vi.fn(),
  slack: vi.fn(),
  telegram: vi.fn(),
  whatsapp: vi.fn(),
}));

const sendFns = vi.hoisted(() => ({
  discord: vi.fn(async () => ({ channelId: "discord:1", messageId: "d1" })),
  imessage: vi.fn(async () => ({ chatId: "imessage:1", messageId: "i1" })),
  signal: vi.fn(async () => ({ conversationId: "signal:1", messageId: "sg1" })),
  slack: vi.fn(async () => ({ channelId: "slack:1", messageId: "s1" })),
  telegram: vi.fn(async () => ({ chatId: "telegram:1", messageId: "t1" })),
  whatsapp: vi.fn(async () => ({ messageId: "w1", toJid: "whatsapp:1" })),
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () =>
    ["whatsapp", "telegram", "discord", "slack", "signal", "imessage"].map(
      (id) =>
        ({
          id,
          meta: { blurb: "", docsPath: `/channels/${id}`, label: id, selectionLabel: id },
        }) as ChannelPlugin,
    ),
}));

vi.mock("./send-runtime/channel-outbound-send.js", () => ({
  createChannelOutboundRuntimeSend: ({
    channelId,
  }: {
    channelId: keyof typeof runtimeFactories;
  }) => {
    runtimeFactories[channelId]();
    return { sendMessage: sendFns[channelId] };
  },
}));

describe("createDefaultDeps", () => {
  async function loadCreateDefaultDeps(scope: string) {
    return (
      await importFreshModule<typeof import("./deps.js")>(
        import.meta.url,
        `./deps.js?scope=${scope}`,
      )
    ).createDefaultDeps;
  }

  function expectUnusedRuntimeFactoriesNotLoaded(exclude: keyof typeof runtimeFactories): void {
    const keys = Object.keys(runtimeFactories) as (keyof typeof runtimeFactories)[];
    for (const key of keys) {
      if (key === exclude) {
        continue;
      }
      expect(runtimeFactories[key]).not.toHaveBeenCalled();
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not build runtime send surfaces until a dependency is used", async () => {
    const createDefaultDeps = await loadCreateDefaultDeps("lazy-load");
    const deps = createDefaultDeps();

    expect(runtimeFactories.whatsapp).not.toHaveBeenCalled();
    expect(runtimeFactories.telegram).not.toHaveBeenCalled();
    expect(runtimeFactories.discord).not.toHaveBeenCalled();
    expect(runtimeFactories.slack).not.toHaveBeenCalled();
    expect(runtimeFactories.signal).not.toHaveBeenCalled();
    expect(runtimeFactories.imessage).not.toHaveBeenCalled();

    const sendTelegram = deps.telegram as (...args: unknown[]) => Promise<unknown>;
    await sendTelegram("chat", "hello", { verbose: false });

    expect(runtimeFactories.telegram).toHaveBeenCalledTimes(1);
    expect(sendFns.telegram).toHaveBeenCalledTimes(1);
    expectUnusedRuntimeFactoriesNotLoaded("telegram");
  });

  it("reuses cached runtime send surfaces after first lazy load", async () => {
    const createDefaultDeps = await loadCreateDefaultDeps("module-cache");
    const deps = createDefaultDeps();
    const sendDiscord = deps.discord as (...args: unknown[]) => Promise<unknown>;

    await sendDiscord("channel", "first", { verbose: false });
    await sendDiscord("channel", "second", { verbose: false });

    expect(runtimeFactories.discord).toHaveBeenCalledTimes(1);
    expect(sendFns.discord).toHaveBeenCalledTimes(2);
  });
});
