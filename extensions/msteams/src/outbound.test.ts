import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  createPoll: vi.fn(),
  sendMessageMSTeams: vi.fn(),
  sendPollMSTeams: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageMSTeams: mocks.sendMessageMSTeams,
  sendPollMSTeams: mocks.sendPollMSTeams,
}));

vi.mock("./polls.js", () => ({
  createMSTeamsPollStoreFs: () => ({
    createPoll: mocks.createPoll,
  }),
}));

import { msteamsOutbound } from "./outbound.js";

describe("msteamsOutbound cfg threading", () => {
  beforeEach(() => {
    mocks.sendMessageMSTeams.mockReset();
    mocks.sendPollMSTeams.mockReset();
    mocks.createPoll.mockReset();
    mocks.sendMessageMSTeams.mockResolvedValue({
      conversationId: "conv-1",
      messageId: "msg-1",
    });
    mocks.sendPollMSTeams.mockResolvedValue({
      conversationId: "conv-1",
      messageId: "msg-poll-1",
      pollId: "poll-1",
    });
    mocks.createPoll.mockResolvedValue(undefined);
  });

  it("passes resolved cfg to sendMessageMSTeams for text sends", async () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "resolved-app-id",
        },
      },
    } as OpenClawConfig;

    await msteamsOutbound.sendText!({
      cfg,
      text: "hello",
      to: "conversation:abc",
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      cfg,
      text: "hello",
      to: "conversation:abc",
    });
  });

  it("passes resolved cfg and media roots for media sends", async () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "resolved-app-id",
        },
      },
    } as OpenClawConfig;

    await msteamsOutbound.sendMedia!({
      cfg,
      mediaLocalRoots: ["/tmp"],
      mediaUrl: "file:///tmp/photo.png",
      text: "photo",
      to: "conversation:abc",
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      cfg,
      mediaLocalRoots: ["/tmp"],
      mediaUrl: "file:///tmp/photo.png",
      text: "photo",
      to: "conversation:abc",
    });
  });

  it("passes resolved cfg to sendPollMSTeams and stores poll metadata", async () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "resolved-app-id",
        },
      },
    } as OpenClawConfig;

    await msteamsOutbound.sendPoll!({
      cfg,
      poll: {
        options: ["Pizza", "Sushi"],
        question: "Snack?",
      },
      to: "conversation:abc",
    });

    expect(mocks.sendPollMSTeams).toHaveBeenCalledWith({
      cfg,
      maxSelections: 1,
      options: ["Pizza", "Sushi"],
      question: "Snack?",
      to: "conversation:abc",
    });
    expect(mocks.createPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "poll-1",
        options: ["Pizza", "Sushi"],
        question: "Snack?",
      }),
    );
  });

  it("chunks outbound text without requiring MSTeams runtime initialization", () => {
    const { chunker } = msteamsOutbound;
    if (!chunker) {
      throw new Error("msteams outbound.chunker unavailable");
    }

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });
});
