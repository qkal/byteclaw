import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendMessageMatrix: vi.fn(),
  sendPollMatrix: vi.fn(),
}));

vi.mock("./matrix/send.js", () => ({
  sendMessageMatrix: mocks.sendMessageMatrix,
  sendPollMatrix: mocks.sendPollMatrix,
}));

vi.mock("./runtime.js", () => ({
  getMatrixRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
    },
  }),
}));

import { matrixOutbound } from "./outbound.js";

describe("matrixOutbound cfg threading", () => {
  beforeEach(() => {
    mocks.sendMessageMatrix.mockReset();
    mocks.sendPollMatrix.mockReset();
    mocks.sendMessageMatrix.mockResolvedValue({ messageId: "evt-1", roomId: "!room:example" });
    mocks.sendPollMatrix.mockResolvedValue({ eventId: "$poll", roomId: "!room:example" });
  });

  it("chunks outbound text without requiring Matrix runtime initialization", () => {
    const {chunker} = matrixOutbound;
    if (!chunker) {
      throw new Error("matrixOutbound.chunker missing");
    }

    expect(() => chunker("hello world", 5)).not.toThrow();
    expect(chunker("hello world", 5)).toEqual(["hello", "world"]);
  });

  it("passes resolved cfg to sendMessageMatrix for text sends", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    await matrixOutbound.sendText!({
      accountId: "default",
      cfg,
      replyToId: "$reply",
      text: "hello",
      threadId: "$thread",
      to: "room:!room:example",
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room:example",
      "hello",
      expect.objectContaining({
        accountId: "default",
        cfg,
        replyToId: "$reply",
        threadId: "$thread",
      }),
    );
  });

  it("passes resolved cfg to sendMessageMatrix for media sends", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    await matrixOutbound.sendMedia!({
      accountId: "default",
      audioAsVoice: true,
      cfg,
      mediaLocalRoots: ["/tmp/openclaw"],
      mediaUrl: "file:///tmp/cat.png",
      text: "caption",
      to: "room:!room:example",
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room:example",
      "caption",
      expect.objectContaining({
        audioAsVoice: true,
        cfg,
        mediaLocalRoots: ["/tmp/openclaw"],
        mediaUrl: "file:///tmp/cat.png",
      }),
    );
  });

  it("passes resolved cfg through injected deps.matrix", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;
    const matrix = vi.fn(async () => ({
      messageId: "evt-injected",
      roomId: "!room:example",
    }));

    await matrixOutbound.sendText!({
      accountId: "default",
      cfg,
      deps: { matrix },
      replyToId: "$reply",
      text: "hello via deps",
      threadId: "$thread",
      to: "room:!room:example",
    });

    expect(matrix).toHaveBeenCalledWith(
      "room:!room:example",
      "hello via deps",
      expect.objectContaining({
        accountId: "default",
        cfg,
        replyToId: "$reply",
        threadId: "$thread",
      }),
    );
  });

  it("passes resolved cfg to sendPollMatrix", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    await matrixOutbound.sendPoll!({
      accountId: "default",
      cfg,
      poll: {
        options: ["Pizza", "Sushi"],
        question: "Snack?",
      },
      threadId: "$thread",
      to: "room:!room:example",
    });

    expect(mocks.sendPollMatrix).toHaveBeenCalledWith(
      "room:!room:example",
      expect.objectContaining({
        options: ["Pizza", "Sushi"],
        question: "Snack?",
      }),
      expect.objectContaining({
        accountId: "default",
        cfg,
        threadId: "$thread",
      }),
    );
  });
});
