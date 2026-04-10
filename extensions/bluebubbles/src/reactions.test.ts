import { describe, expect, it, vi } from "vitest";
import { sendBlueBubblesReaction } from "./reactions.js";
import { installBlueBubblesFetchTestHooks } from "./test-harness.js";

vi.mock("./accounts.js", async () => {
  const { createBlueBubblesAccountsMockModule } = await import("./test-harness.js");
  return createBlueBubblesAccountsMockModule();
});

const mockFetch = vi.fn();
const noopPrivateApiStatusMock = {
  mockReturnValue: () => {},
};

installBlueBubblesFetchTestHooks({
  mockFetch,
  privateApiStatusMock: noopPrivateApiStatusMock,
});

describe("reactions", () => {
  describe("sendBlueBubblesReaction", () => {
    async function expectRemovedReaction(emoji: string, expectedReaction = "-love") {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesReaction({
        chatGuid: "chat-123",
        emoji,
        messageGuid: "msg-123",
        opts: {
          password: "test",
          serverUrl: "http://localhost:1234",
        },
        remove: true,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reaction).toBe(expectedReaction);
    }

    it("throws when chatGuid is empty", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "",
          emoji: "love",
          messageGuid: "msg-123",
          opts: {
            password: "test",
            serverUrl: "http://localhost:1234",
          },
        }),
      ).rejects.toThrow("chatGuid");
    });

    it("throws when messageGuid is empty", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          emoji: "love",
          messageGuid: "",
          opts: {
            password: "test",
            serverUrl: "http://localhost:1234",
          },
        }),
      ).rejects.toThrow("messageGuid");
    });

    it("throws when emoji is empty", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          emoji: "",
          messageGuid: "msg-123",
          opts: {
            password: "test",
            serverUrl: "http://localhost:1234",
          },
        }),
      ).rejects.toThrow("emoji or name");
    });

    it("throws when serverUrl is missing", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          emoji: "love",
          messageGuid: "msg-123",
          opts: {},
        }),
      ).rejects.toThrow("serverUrl is required");
    });

    it("throws when password is missing", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          emoji: "love",
          messageGuid: "msg-123",
          opts: {
            serverUrl: "http://localhost:1234",
          },
        }),
      ).rejects.toThrow("password is required");
    });

    it("throws for unsupported reaction type", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          emoji: "unsupported",
          messageGuid: "msg-123",
          opts: {
            password: "test",
            serverUrl: "http://localhost:1234",
          },
        }),
      ).rejects.toThrow("Unsupported BlueBubbles reaction");
    });

    describe("reaction type normalization", () => {
      const testCases = [
        { expected: "love", input: "love" },
        { expected: "like", input: "like" },
        { expected: "dislike", input: "dislike" },
        { expected: "laugh", input: "laugh" },
        { expected: "emphasize", input: "emphasize" },
        { expected: "question", input: "question" },
        { expected: "love", input: "heart" },
        { expected: "like", input: "thumbs_up" },
        { expected: "dislike", input: "thumbs-down" },
        { expected: "dislike", input: "thumbs_down" },
        { expected: "laugh", input: "haha" },
        { expected: "laugh", input: "lol" },
        { expected: "emphasize", input: "emphasis" },
        { expected: "emphasize", input: "exclaim" },
        { expected: "love", input: "❤️" },
        { expected: "love", input: "❤" },
        { expected: "love", input: "♥️" },
        { expected: "love", input: "😍" },
        { expected: "like", input: "👍" },
        { expected: "dislike", input: "👎" },
        { expected: "laugh", input: "😂" },
        { expected: "laugh", input: "🤣" },
        { expected: "laugh", input: "😆" },
        { expected: "emphasize", input: "‼️" },
        { expected: "emphasize", input: "‼" },
        { expected: "emphasize", input: "❗" },
        { expected: "question", input: "❓" },
        { expected: "question", input: "❔" },
        { expected: "love", input: "LOVE" },
        { expected: "like", input: "Like" },
      ];

      for (const { input, expected } of testCases) {
        it(`normalizes "${input}" to "${expected}"`, async () => {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            text: () => Promise.resolve(""),
          });

          await sendBlueBubblesReaction({
            chatGuid: "chat-123",
            emoji: input,
            messageGuid: "msg-123",
            opts: {
              password: "test",
              serverUrl: "http://localhost:1234",
            },
          });

          const body = JSON.parse(mockFetch.mock.calls[0][1].body);
          expect(body.reaction).toBe(expected);
        });
      }
    });

    it("sends reaction successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesReaction({
        chatGuid: "iMessage;-;+15551234567",
        emoji: "love",
        messageGuid: "msg-uuid-123",
        opts: {
          password: "test-password",
          serverUrl: "http://localhost:1234",
        },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/message/react"),
        expect.objectContaining({
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chatGuid).toBe("iMessage;-;+15551234567");
      expect(body.selectedMessageGuid).toBe("msg-uuid-123");
      expect(body.reaction).toBe("love");
      expect(body.partIndex).toBe(0);
    });

    it("includes password in URL query", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesReaction({
        chatGuid: "chat-123",
        emoji: "like",
        messageGuid: "msg-123",
        opts: {
          password: "my-react-password",
          serverUrl: "http://localhost:1234",
        },
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("password=my-react-password");
    });

    it("sends reaction removal with dash prefix", async () => {
      await expectRemovedReaction("love");
    });

    it("strips leading dash from emoji when remove flag is set", async () => {
      await expectRemovedReaction("-love");
    });

    it("uses custom partIndex when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesReaction({
        chatGuid: "chat-123",
        emoji: "laugh",
        messageGuid: "msg-123",
        opts: {
          password: "test",
          serverUrl: "http://localhost:1234",
        },
        partIndex: 3,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.partIndex).toBe(3);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Invalid reaction type"),
      });

      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          emoji: "like",
          messageGuid: "msg-123",
          opts: {
            password: "test",
            serverUrl: "http://localhost:1234",
          },
        }),
      ).rejects.toThrow("reaction failed (400): Invalid reaction type");
    });

    it("resolves credentials from config", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesReaction({
        chatGuid: "chat-123",
        emoji: "emphasize",
        messageGuid: "msg-123",
        opts: {
          cfg: {
            channels: {
              bluebubbles: {
                password: "react-pass",
                serverUrl: "http://react-server:7777",
              },
            },
          },
        },
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("react-server:7777");
      expect(calledUrl).toContain("password=react-pass");
    });

    it("trims chatGuid and messageGuid", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesReaction({
        chatGuid: "  chat-with-spaces  ",
        emoji: "question",
        messageGuid: "  msg-with-spaces  ",
        opts: {
          password: "test",
          serverUrl: "http://localhost:1234",
        },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chatGuid).toBe("chat-with-spaces");
      expect(body.selectedMessageGuid).toBe("msg-with-spaces");
    });

    describe("reaction removal aliases", () => {
      it("handles emoji-based removal", async () => {
        await expectRemovedReaction("👍", "-like");
      });

      it("handles text alias removal", async () => {
        await expectRemovedReaction("haha", "-laugh");
      });
    });
  });
});
