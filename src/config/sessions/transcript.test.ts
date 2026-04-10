import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as transcriptEvents from "../../sessions/transcript-events.js";
import { resolveSessionTranscriptPathInDir } from "./paths.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
} from "./transcript.js";

describe("appendAssistantMessageToSessionTranscript", () => {
  const fixture = useTempSessionsFixture("transcript-test-");
  const sessionId = "test-session-id";
  const sessionKey = "test-session";

  function writeTranscriptStore() {
    fs.writeFileSync(
      fixture.storePath(),
      JSON.stringify({
        [sessionKey]: {
          channel: "discord",
          chatType: "direct",
          sessionId,
        },
      }),
      "utf8",
    );
  }

  it("creates transcript file and appends message for valid session", async () => {
    writeTranscriptStore();

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      text: "Hello from delivery mirror!",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fs.existsSync(result.sessionFile)).toBe(true);
      const sessionFileMode = fs.statSync(result.sessionFile).mode & 0o777;
      if (process.platform !== "win32") {
        expect(sessionFileMode).toBe(0o600);
      }

      const lines = fs.readFileSync(result.sessionFile, "utf8").trim().split("\n");
      expect(lines.length).toBe(2);

      const header = JSON.parse(lines[0]);
      expect(header.type).toBe("session");
      expect(header.id).toBe(sessionId);

      const messageLine = JSON.parse(lines[1]);
      expect(messageLine.type).toBe("message");
      expect(messageLine.message.role).toBe("assistant");
      expect(messageLine.message.content[0].type).toBe("text");
      expect(messageLine.message.content[0].text).toBe("Hello from delivery mirror!");
    }
  });

  it("emits transcript update events for delivery mirrors", async () => {
    const store = {
      [sessionKey]: {
        channel: "discord",
        chatType: "direct",
        sessionId,
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf8");
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      text: "Hello from delivery mirror!",
    });

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: "text", text: "Hello from delivery mirror!" }],
          model: "delivery-mirror",
          provider: "openclaw",
          role: "assistant",
        }),
        messageId: expect.any(String),
        sessionFile,
        sessionKey,
      }),
    );
    emitSpy.mockRestore();
  });

  it("does not append a duplicate delivery mirror for the same idempotency key", async () => {
    writeTranscriptStore();

    await appendAssistantMessageToSessionTranscript({
      idempotencyKey: "mirror:test-source-message",
      sessionKey,
      storePath: fixture.storePath(),
      text: "Hello from delivery mirror!",
    });
    await appendAssistantMessageToSessionTranscript({
      idempotencyKey: "mirror:test-source-message",
      sessionKey,
      storePath: fixture.storePath(),
      text: "Hello from delivery mirror!",
    });

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);

    const messageLine = JSON.parse(lines[1]);
    expect(messageLine.message.idempotencyKey).toBe("mirror:test-source-message");
    expect(messageLine.message.content[0].text).toBe("Hello from delivery mirror!");
  });

  it("finds session entry using normalized (lowercased) key", async () => {
    const storeKey = "agent:main:bluebubbles:direct:+15551234567";
    const store = {
      [storeKey]: {
        channel: "bluebubbles",
        chatType: "direct",
        sessionId: "test-session-normalized",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf8");

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:BlueBubbles:direct:+15551234567",
      storePath: fixture.storePath(),
      text: "Hello normalized!",
    });

    expect(result.ok).toBe(true);
  });

  it("finds Slack session entry using normalized (lowercased) key", async () => {
    const storeKey = "agent:main:slack:direct:u12345abc";
    const store = {
      [storeKey]: {
        channel: "slack",
        chatType: "direct",
        sessionId: "test-slack-session",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf8");

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:slack:direct:U12345ABC",
      storePath: fixture.storePath(),
      text: "Hello Slack user!",
    });

    expect(result.ok).toBe(true);
  });

  it("ignores malformed transcript lines when checking mirror idempotency", async () => {
    writeTranscriptStore();

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          cwd: process.cwd(),
          id: sessionId,
          timestamp: new Date().toISOString(),
          type: "session",
          version: 1,
        }),
        "{not-json",
        JSON.stringify({
          message: {
            content: [{ text: "Hello from delivery mirror!", type: "text" }],
            idempotencyKey: "mirror:test-source-message",
            role: "assistant",
          },
          type: "message",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await appendAssistantMessageToSessionTranscript({
      idempotencyKey: "mirror:test-source-message",
      sessionKey,
      storePath: fixture.storePath(),
      text: "Hello from delivery mirror!",
    });

    expect(result.ok).toBe(true);
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(3);
  });

  it("appends exact assistant transcript messages without rewriting phased content", async () => {
    writeTranscriptStore();

    const result = await appendExactAssistantMessageToSessionTranscript({
      message: {
        api: "openai-responses",
        content: [
          {
            text: "internal reasoning",
            textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
            type: "text",
          },
          {
            text: "Done.",
            textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
            type: "text",
          },
        ],
        model: "delivery-mirror",
        provider: "openclaw",
        role: "assistant",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      },
      sessionKey,
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = fs.readFileSync(result.sessionFile, "utf8").trim().split("\n");
      const messageLine = JSON.parse(lines[1]);
      expect(messageLine.message.content).toEqual([
        {
          text: "internal reasoning",
          textSignature: JSON.stringify({ id: "item_commentary", phase: "commentary", v: 1 }),
          type: "text",
        },
        {
          text: "Done.",
          textSignature: JSON.stringify({ id: "item_final", phase: "final_answer", v: 1 }),
          type: "text",
        },
      ]);
    }
  });

  it("can emit file-only transcript refresh events for exact assistant appends", async () => {
    writeTranscriptStore();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    const result = await appendExactAssistantMessageToSessionTranscript({
      message: {
        api: "openai-responses",
        content: [{ text: "Done.", type: "text" }],
        model: "delivery-mirror",
        provider: "openclaw",
        role: "assistant",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      },
      sessionKey,
      storePath: fixture.storePath(),
      updateMode: "file-only",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(emitSpy).toHaveBeenCalledWith(result.sessionFile);
    }
    emitSpy.mockRestore();
  });
});
