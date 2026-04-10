import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it } from "vitest";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import {
  createCliDeps,
  expectDirectTelegramDelivery,
  mockAgentPayloads,
  runTelegramAnnounceTurn,
} from "./isolated-agent.delivery.test-helpers.js";
import { withTempCronHome, writeSessionStore } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

function makeRunMeta(finalAssistantVisibleText: string) {
  return {
    agentMeta: { model: "m", provider: "p", sessionId: "s" },
    durationMs: 5,
    finalAssistantVisibleText,
  };
}

describe("runCronIsolatedAgentTurn forum topic delivery", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
  });

  it("routes forum-topic telegram targets through the correct delivery path", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "forum message" }]);

      const res = await runTelegramAnnounceTurn({
        delivery: { channel: "telegram", mode: "announce", to: "123:topic:42" },
        deps,
        home,
        storePath,
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expectDirectTelegramDelivery(deps, {
        chatId: "123",
        messageThreadId: 42,
        text: "forum message",
      });
    });
  });

  it("delivers only the final assistant-visible text to forum-topic telegram targets", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads(
        [{ text: "section 1" }, { isError: true, text: "temporary error" }, { text: "section 2" }],
        { meta: makeRunMeta("section 1\nsection 2") },
      );

      const res = await runTelegramAnnounceTurn({
        delivery: { channel: "telegram", mode: "announce", to: "123:topic:42" },
        deps,
        home,
        storePath,
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expectDirectTelegramDelivery(deps, {
        chatId: "123",
        messageThreadId: 42,
        text: "section 1\nsection 2",
      });
    });
  });

  it("routes plain telegram targets through the correct delivery path", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "plain message" }]);

      const plainRes = await runTelegramAnnounceTurn({
        delivery: { channel: "telegram", mode: "announce", to: "123" },
        deps,
        home,
        storePath,
      });

      expect(plainRes.status).toBe("ok");
      expect(plainRes.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expectDirectTelegramDelivery(deps, {
        chatId: "123",
        text: "plain message",
      });
    });
  });

  it("delivers only the final assistant-visible text to plain telegram targets", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "Working on it..." }, { text: "Final weather summary" }], {
        meta: makeRunMeta("Final weather summary"),
      });

      const plainRes = await runTelegramAnnounceTurn({
        delivery: { channel: "telegram", mode: "announce", to: "123" },
        deps,
        home,
        storePath,
      });

      expect(plainRes.status).toBe("ok");
      expect(plainRes.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expectDirectTelegramDelivery(deps, {
        chatId: "123",
        text: "Final weather summary",
      });
    });
  });
});
