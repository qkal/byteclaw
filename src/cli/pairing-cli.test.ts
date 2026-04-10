import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerPairingCli } from "./pairing-cli.js";

const mocks = vi.hoisted(() => ({
  approveChannelPairingCode: vi.fn(),
  getPairingAdapter: vi.fn((channel: string) => ({
    idLabel: pairingIdLabels[channel] ?? "userId",
  })),
  listChannelPairingRequests: vi.fn(),
  listPairingChannels: vi.fn(() => ["telegram", "discord", "imessage"]),
  normalizeChannelId: vi.fn((raw: string) => {
    if (!raw) {
      return null;
    }
    if (raw === "imsg") {
      return "imessage";
    }
    if (["telegram", "discord", "imessage"].includes(raw)) {
      return raw;
    }
    return null;
  }),
  notifyPairingApproved: vi.fn(),
}));

const {
  listChannelPairingRequests,
  approveChannelPairingCode,
  notifyPairingApproved,
  normalizeChannelId,
  getPairingAdapter,
  listPairingChannels,
} = mocks;

const pairingIdLabels: Record<string, string> = {
  discord: "discordUserId",
  telegram: "telegramUserId",
};

vi.mock("../pairing/pairing-store.js", () => ({
  approveChannelPairingCode: mocks.approveChannelPairingCode,
  listChannelPairingRequests: mocks.listChannelPairingRequests,
}));

vi.mock("../channels/plugins/pairing.js", () => ({
  getPairingAdapter: mocks.getPairingAdapter,
  listPairingChannels: mocks.listPairingChannels,
  notifyPairingApproved: mocks.notifyPairingApproved,
}));

vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

describe("pairing cli", () => {
  beforeEach(() => {
    listChannelPairingRequests.mockClear();
    listChannelPairingRequests.mockResolvedValue([]);
    approveChannelPairingCode.mockClear();
    approveChannelPairingCode.mockResolvedValue({
      entry: {
        code: "ABCDEFGH",
        createdAt: "2026-01-08T00:00:00Z",
        id: "123",
        lastSeenAt: "2026-01-08T00:00:00Z",
      },
      id: "123",
    });
    notifyPairingApproved.mockClear();
    normalizeChannelId.mockClear();
    getPairingAdapter.mockClear();
    listPairingChannels.mockClear();
    notifyPairingApproved.mockResolvedValue(undefined);
  });

  function createProgram() {
    const program = new Command();
    program.name("test");
    registerPairingCli(program);
    return program;
  }

  async function runPairing(args: string[]) {
    const program = createProgram();
    await program.parseAsync(args, { from: "user" });
  }

  function mockApprovedPairing() {
    approveChannelPairingCode.mockResolvedValueOnce({
      entry: {
        code: "ABCDEFGH",
        createdAt: "2026-01-08T00:00:00Z",
        id: "123",
        lastSeenAt: "2026-01-08T00:00:00Z",
      },
      id: "123",
    });
  }

  it("evaluates pairing channels when registering the CLI (not at import)", async () => {
    expect(listPairingChannels).not.toHaveBeenCalled();

    createProgram();

    expect(listPairingChannels).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      channel: "telegram",
      id: "123",
      label: "telegramUserId",
      meta: { username: "peter" },
      name: "telegram ids",
    },
    {
      channel: "discord",
      id: "999",
      label: "discordUserId",
      meta: { tag: "Ada#0001" },
      name: "discord ids",
    },
  ])("labels $name correctly", async ({ channel, id, label, meta }) => {
    listChannelPairingRequests.mockResolvedValueOnce([
      {
        code: "ABC123",
        createdAt: "2026-01-08T00:00:00Z",
        id,
        lastSeenAt: "2026-01-08T00:00:00Z",
        meta,
      },
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runPairing(["pairing", "list", "--channel", channel]);
      const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain(label);
      expect(output).toContain(id);
    } finally {
      log.mockRestore();
    }
  });

  it("accepts channel as positional for list", async () => {
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list", "telegram"]);

    expect(listChannelPairingRequests).toHaveBeenCalledWith("telegram");
  });

  it("forwards --account for list", async () => {
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list", "--channel", "telegram", "--account", "yy"]);

    expect(listChannelPairingRequests).toHaveBeenCalledWith("telegram", process.env, "yy");
  });

  it("normalizes channel aliases", async () => {
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list", "imsg"]);

    expect(normalizeChannelId).toHaveBeenCalledWith("imsg");
    expect(listChannelPairingRequests).toHaveBeenCalledWith("imessage");
  });

  it("accepts extension channels outside the registry", async () => {
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list", "zalo"]);

    expect(normalizeChannelId).toHaveBeenCalledWith("zalo");
    expect(listChannelPairingRequests).toHaveBeenCalledWith("zalo");
  });

  it("defaults list to the sole available channel", async () => {
    listPairingChannels.mockReturnValueOnce(["slack"]);
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list"]);

    expect(listChannelPairingRequests).toHaveBeenCalledWith("slack");
  });

  it("accepts channel as positional for approve (npm-run compatible)", async () => {
    mockApprovedPairing();

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runPairing(["pairing", "approve", "telegram", "ABCDEFGH"]);

      expect(approveChannelPairingCode).toHaveBeenCalledWith({
        channel: "telegram",
        code: "ABCDEFGH",
      });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Approved"));
    } finally {
      log.mockRestore();
    }
  });

  it("forwards --account for approve", async () => {
    mockApprovedPairing();

    await runPairing([
      "pairing",
      "approve",
      "--channel",
      "telegram",
      "--account",
      "yy",
      "ABCDEFGH",
    ]);

    expect(approveChannelPairingCode).toHaveBeenCalledWith({
      accountId: "yy",
      channel: "telegram",
      code: "ABCDEFGH",
    });
  });

  it("defaults approve to the sole available channel when only code is provided", async () => {
    listPairingChannels.mockReturnValueOnce(["slack"]);
    mockApprovedPairing();

    await runPairing(["pairing", "approve", "ABCDEFGH"]);

    expect(approveChannelPairingCode).toHaveBeenCalledWith({
      channel: "slack",
      code: "ABCDEFGH",
    });
  });

  it("keeps approve usage error when multiple channels exist and channel is omitted", async () => {
    await expect(runPairing(["pairing", "approve", "ABCDEFGH"])).rejects.toThrow("Usage:");
  });
});
