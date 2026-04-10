import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
});

describe("heartbeat transcript append-only (#39609)", () => {
  async function createTranscriptWithContent(transcriptPath: string, sessionId: string) {
    const header = {
      cwd: process.cwd(),
      id: sessionId,
      timestamp: new Date().toISOString(),
      type: "session",
      version: 3,
    };
    const existingContent = `${JSON.stringify(header)}\n{"role":"user","content":"Hello"}\n{"role":"assistant","content":"Hi there"}\n`;
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, existingContent);
    return existingContent;
  }

  async function runTranscriptScenario(params: {
    sessionId: string;
    reply: {
      text: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      };
    };
  }) {
    await withTempTelegramHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const sessionKey = resolveMainSessionKey(undefined);
        const transcriptPath = path.join(tmpDir, `${params.sessionId}.jsonl`);
        await createTranscriptWithContent(transcriptPath, params.sessionId);
        const originalSize = (await fs.stat(transcriptPath)).size;

        await seedSessionStore(storePath, sessionKey, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "user123",
          sessionId: params.sessionId,
        });

        replySpy.mockResolvedValueOnce(params.reply);

        const cfg = {
          agent: { workspace: tmpDir },
          channels: { telegram: {} },
          model: "test-model",
          sessionStore: storePath,
          version: 1,
        } as unknown as OpenClawConfig;

        await runHeartbeatOnce({
          agentId: undefined,
          cfg,
          deps: {
            getReplyFromConfig: replySpy,
            sendTelegram: vi.fn(),
          },
          reason: "test",
        });

        const finalSize = (await fs.stat(transcriptPath)).size;
        // Transcript must never be truncated — entries are append-only now.
        // HEARTBEAT_OK entries stay in the file and are filtered at context
        // Build time instead of being removed via fs.truncate (#39609).
        expect(finalSize).toBeGreaterThanOrEqual(originalSize);
      },
      { prefix: "openclaw-hb-prune-" },
    );
  }

  it("does not truncate transcript when heartbeat returns HEARTBEAT_OK", async () => {
    await runTranscriptScenario({
      reply: {
        text: "HEARTBEAT_OK",
        usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
      },
      sessionId: "test-session-no-prune",
    });
  });

  it("does not truncate transcript when heartbeat returns meaningful content", async () => {
    await runTranscriptScenario({
      reply: {
        text: "Alert: Something needs your attention!",
        usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 20 },
      },
      sessionId: "test-session-content",
    });
  });
});
