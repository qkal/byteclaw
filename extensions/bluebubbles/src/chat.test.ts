import { describe, expect, it, vi } from "vitest";
import "./test-mocks.js";
import {
  addBlueBubblesParticipant,
  editBlueBubblesMessage,
  leaveBlueBubblesChat,
  markBlueBubblesChatRead,
  removeBlueBubblesParticipant,
  renameBlueBubblesChat,
  sendBlueBubblesTyping,
  setGroupIconBlueBubbles,
  unsendBlueBubblesMessage,
} from "./chat.js";
import { getCachedBlueBubblesPrivateApiStatus } from "./probe.js";
import { installBlueBubblesFetchTestHooks } from "./test-harness.js";

const mockFetch = vi.fn();

installBlueBubblesFetchTestHooks({
  mockFetch,
  privateApiStatusMock: vi.mocked(getCachedBlueBubblesPrivateApiStatus),
});

describe("chat", () => {
  function mockOkTextResponse() {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(""),
    });
  }

  function mockTwoOkTextResponses() {
    mockOkTextResponse();
    mockOkTextResponse();
  }

  async function expectCalledUrlIncludesPassword(params: {
    password: string;
    invoke: () => Promise<void>;
  }) {
    mockOkTextResponse();
    await params.invoke();
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(`password=${params.password}`);
  }

  async function expectCalledUrlUsesConfigCredentials(params: {
    serverHost: string;
    password: string;
    invoke: (cfg: {
      channels: { bluebubbles: { serverUrl: string; password: string } };
    }) => Promise<void>;
  }) {
    mockOkTextResponse();
    await params.invoke({
      channels: {
        bluebubbles: {
          password: params.password,
          serverUrl: `http://${params.serverHost}`,
        },
      },
    });
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(params.serverHost);
    expect(calledUrl).toContain(`password=${params.password}`);
  }

  describe("markBlueBubblesChatRead", () => {
    it("does nothing when chatGuid is empty or whitespace", async () => {
      for (const chatGuid of ["", "   "]) {
        await markBlueBubblesChatRead(chatGuid, {
          password: "test",
          serverUrl: "http://localhost:1234",
        });
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws when required credentials are missing", async () => {
      await expect(markBlueBubblesChatRead("chat-guid", {})).rejects.toThrow(
        "serverUrl is required",
      );
      await expect(
        markBlueBubblesChatRead("chat-guid", {
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("password is required");
    });

    it("marks chat as read successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await markBlueBubblesChatRead("iMessage;-;+15551234567", {
        password: "test-password",
        serverUrl: "http://localhost:1234",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/chat/iMessage%3B-%3B%2B15551234567/read"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("does not send read receipt when private API is disabled", async () => {
      vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReturnValueOnce(false);

      await markBlueBubblesChatRead("iMessage;-;+15551234567", {
        password: "test-password",
        serverUrl: "http://localhost:1234",
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("includes password in URL query", async () => {
      await expectCalledUrlIncludesPassword({
        invoke: () =>
          markBlueBubblesChatRead("chat-123", {
            password: "my-secret",
            serverUrl: "http://localhost:1234",
          }),
        password: "my-secret",
      });
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Chat not found"),
      });

      await expect(
        markBlueBubblesChatRead("missing-chat", {
          password: "test",
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("read failed (404): Chat not found");
    });

    it("trims chatGuid before using", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await markBlueBubblesChatRead("  chat-with-spaces  ", {
        password: "test",
        serverUrl: "http://localhost:1234",
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/api/v1/chat/chat-with-spaces/read");
      expect(calledUrl).not.toContain("%20chat");
    });

    it("resolves credentials from config", async () => {
      await expectCalledUrlUsesConfigCredentials({
        invoke: (cfg) =>
          markBlueBubblesChatRead("chat-123", {
            cfg,
          }),
        password: "config-pass",
        serverHost: "config-server:9999",
      });
    });
  });

  describe("sendBlueBubblesTyping", () => {
    it("does nothing when chatGuid is empty or whitespace", async () => {
      for (const chatGuid of ["", "   "]) {
        await sendBlueBubblesTyping(chatGuid, true, {
          password: "test",
          serverUrl: "http://localhost:1234",
        });
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws when required credentials are missing", async () => {
      await expect(sendBlueBubblesTyping("chat-guid", true, {})).rejects.toThrow(
        "serverUrl is required",
      );
      await expect(
        sendBlueBubblesTyping("chat-guid", true, {
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("password is required");
    });

    it("does not send typing when private API is disabled", async () => {
      vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReturnValueOnce(false);

      await sendBlueBubblesTyping("iMessage;-;+15551234567", true, {
        password: "test",
        serverUrl: "http://localhost:1234",
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("uses POST for start and DELETE for stop", async () => {
      mockTwoOkTextResponses();

      await sendBlueBubblesTyping("iMessage;-;+15551234567", true, {
        password: "test",
        serverUrl: "http://localhost:1234",
      });
      await sendBlueBubblesTyping("iMessage;-;+15551234567", false, {
        password: "test",
        serverUrl: "http://localhost:1234",
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toContain(
        "/api/v1/chat/iMessage%3B-%3B%2B15551234567/typing",
      );
      expect(mockFetch.mock.calls[0][1].method).toBe("POST");
      expect(mockFetch.mock.calls[1][0]).toContain(
        "/api/v1/chat/iMessage%3B-%3B%2B15551234567/typing",
      );
      expect(mockFetch.mock.calls[1][1].method).toBe("DELETE");
    });

    it("includes password in URL query", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesTyping("chat-123", true, {
        password: "typing-secret",
        serverUrl: "http://localhost:1234",
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("password=typing-secret");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal error"),
      });

      await expect(
        sendBlueBubblesTyping("chat-123", true, {
          password: "test",
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("typing failed (500): Internal error");
    });

    it("trims chatGuid before using", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesTyping("  trimmed-chat  ", true, {
        password: "test",
        serverUrl: "http://localhost:1234",
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/api/v1/chat/trimmed-chat/typing");
    });

    it("encodes special characters in chatGuid", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesTyping("iMessage;+;group@chat.com", true, {
        password: "test",
        serverUrl: "http://localhost:1234",
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("iMessage%3B%2B%3Bgroup%40chat.com");
    });

    it("resolves credentials from config", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesTyping("chat-123", true, {
        cfg: {
          channels: {
            bluebubbles: {
              password: "typing-pass",
              serverUrl: "http://typing-server:8888",
            },
          },
        },
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("typing-server:8888");
      expect(calledUrl).toContain("password=typing-pass");
    });
  });

  describe("editBlueBubblesMessage", () => {
    it("throws when required args are missing", async () => {
      await expect(editBlueBubblesMessage("", "updated", {})).rejects.toThrow("messageGuid");
      await expect(editBlueBubblesMessage("message-guid", "   ", {})).rejects.toThrow("newText");
    });

    it("sends edit request with default payload values", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await editBlueBubblesMessage(" message-guid ", " updated text ", {
        password: "test-password",
        serverUrl: "http://localhost:1234",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/message/message-guid/edit"),
        expect.objectContaining({
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({
        backwardsCompatibilityMessage: "Edited to: updated text",
        editedMessage: "updated text",
        partIndex: 0,
      });
    });

    it("supports custom part index and backwards compatibility message", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await editBlueBubblesMessage("message-guid", "new text", {
        backwardsCompatMessage: "custom-backwards-message",
        partIndex: 3,
        password: "test-password",
        serverUrl: "http://localhost:1234",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.partIndex).toBe(3);
      expect(body.backwardsCompatibilityMessage).toBe("custom-backwards-message");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: () => Promise.resolve("Unprocessable"),
      });

      await expect(
        editBlueBubblesMessage("message-guid", "new text", {
          password: "test-password",
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("edit failed (422): Unprocessable");
    });
  });

  describe("unsendBlueBubblesMessage", () => {
    it("throws when messageGuid is missing", async () => {
      await expect(unsendBlueBubblesMessage("", {})).rejects.toThrow("messageGuid");
    });

    it("sends unsend request with default part index", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await unsendBlueBubblesMessage(" msg-123 ", {
        password: "test-password",
        serverUrl: "http://localhost:1234",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/message/msg-123/unsend"),
        expect.objectContaining({
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.partIndex).toBe(0);
    });

    it("uses custom part index", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await unsendBlueBubblesMessage("msg-123", {
        partIndex: 2,
        password: "test-password",
        serverUrl: "http://localhost:1234",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.partIndex).toBe(2);
    });
  });

  describe("group chat mutation actions", () => {
    it("renames chat", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await renameBlueBubblesChat(" chat-guid ", "New Group Name", {
        password: "test-password",
        serverUrl: "http://localhost:1234",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/chat/chat-guid"),
        expect.objectContaining({ method: "PUT" }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.displayName).toBe("New Group Name");
    });

    it("adds and removes participant using matching endpoint", async () => {
      mockTwoOkTextResponses();

      await addBlueBubblesParticipant("chat-guid", "+15551234567", {
        password: "test-password",
        serverUrl: "http://localhost:1234",
      });
      await removeBlueBubblesParticipant("chat-guid", "+15551234567", {
        password: "test-password",
        serverUrl: "http://localhost:1234",
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toContain("/api/v1/chat/chat-guid/participant");
      expect(mockFetch.mock.calls[0][1].method).toBe("POST");
      expect(mockFetch.mock.calls[1][0]).toContain("/api/v1/chat/chat-guid/participant");
      expect(mockFetch.mock.calls[1][1].method).toBe("DELETE");

      const addBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const removeBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(addBody.address).toBe("+15551234567");
      expect(removeBody.address).toBe("+15551234567");
    });

    it("leaves chat without JSON body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await leaveBlueBubblesChat("chat-guid", {
        password: "test-password",
        serverUrl: "http://localhost:1234",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/chat/chat-guid/leave"),
        expect.objectContaining({ method: "POST" }),
      );
      expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
      expect(mockFetch.mock.calls[0][1].headers).toBeUndefined();
    });
  });

  describe("setGroupIconBlueBubbles", () => {
    it("throws when chatGuid is empty", async () => {
      await expect(
        setGroupIconBlueBubbles("", new Uint8Array([1, 2, 3]), "icon.png", {
          password: "test",
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("chatGuid");
    });

    it("throws when buffer is empty", async () => {
      await expect(
        setGroupIconBlueBubbles("chat-guid", new Uint8Array(0), "icon.png", {
          password: "test",
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("image buffer");
    });

    it("throws when required credentials are missing", async () => {
      await expect(
        setGroupIconBlueBubbles("chat-guid", new Uint8Array([1, 2, 3]), "icon.png", {}),
      ).rejects.toThrow("serverUrl is required");
      await expect(
        setGroupIconBlueBubbles("chat-guid", new Uint8Array([1, 2, 3]), "icon.png", {
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("password is required");
    });

    it("throws when private API is disabled", async () => {
      vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReturnValueOnce(false);
      await expect(
        setGroupIconBlueBubbles("chat-guid", new Uint8Array([1, 2, 3]), "icon.png", {
          password: "test",
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("requires Private API");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("sets group icon successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      const buffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      await setGroupIconBlueBubbles("iMessage;-;chat-guid", buffer, "icon.png", {
        contentType: "image/png",
        password: "test-password",
        serverUrl: "http://localhost:1234",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/chat/iMessage%3B-%3Bchat-guid/icon"),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": expect.stringContaining("multipart/form-data"),
          }),
          method: "POST",
        }),
      );
    });

    it("includes password in URL query", async () => {
      await expectCalledUrlIncludesPassword({
        invoke: () =>
          setGroupIconBlueBubbles("chat-123", new Uint8Array([1, 2, 3]), "icon.png", {
            password: "my-secret",
            serverUrl: "http://localhost:1234",
          }),
        password: "my-secret",
      });
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal error"),
      });

      await expect(
        setGroupIconBlueBubbles("chat-123", new Uint8Array([1, 2, 3]), "icon.png", {
          password: "test",
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("setGroupIcon failed (500): Internal error");
    });

    it("trims chatGuid before using", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await setGroupIconBlueBubbles("  chat-with-spaces  ", new Uint8Array([1]), "icon.png", {
        password: "test",
        serverUrl: "http://localhost:1234",
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/api/v1/chat/chat-with-spaces/icon");
      expect(calledUrl).not.toContain("%20chat");
    });

    it("resolves credentials from config", async () => {
      await expectCalledUrlUsesConfigCredentials({
        invoke: (cfg) =>
          setGroupIconBlueBubbles("chat-123", new Uint8Array([1]), "icon.png", {
            cfg,
          }),
        password: "config-pass",
        serverHost: "config-server:9999",
      });
    });

    it("includes filename in multipart body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await setGroupIconBlueBubbles("chat-123", new Uint8Array([1, 2, 3]), "custom-icon.jpg", {
        contentType: "image/jpeg",
        password: "test",
        serverUrl: "http://localhost:1234",
      });

      const body = mockFetch.mock.calls[0][1].body as Uint8Array;
      const bodyString = new TextDecoder().decode(body);
      expect(bodyString).toContain('filename="custom-icon.jpg"');
      expect(bodyString).toContain("image/jpeg");
    });
  });
});
